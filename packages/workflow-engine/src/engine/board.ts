import { randomUUID } from 'node:crypto';
import { availableMessages, member } from './durable-agents';
import { boardTotal, postBySeq, resolutionView } from './kernel-state';
import { openAsk } from './evolve';
import { emit, recordsOf } from './kernel-store';
import { BOARD_ANNOUNCE_TOPIC, BOARD_DEFAULT_TOPIC, BOARD_MAX_DELIVERIES, BOARD_MAX_TOPICS, BOARD_NOTICED_TOPIC, MAX_NAMED_MEMBERS } from './limits';
import { boundedInteger, scriptText } from './script-contract';
import { matchFields, SEARCH_ARCHIVE_ROWS, searchTerms, storedTerms } from './search';
import type { AgentView, BoardAuthor, BoardPost, Immutable, MailboxMessage, PostResolution, TaskView, WorkflowView } from './types';

/** Topic of the mailbox messages that deliver board posts; `receive(member,{topic})` can select or skip them. */
const BOARD_TOPIC = 'board';
const POST_MAX_TEXT = 4000;
const NAME_END = '(?![A-Za-z0-9_\\-/]|\\.[A-Za-z0-9])';
const TOPIC = /^[a-z0-9][a-z0-9_.-]{0,39}$/;
/** Announcements a member is handed in one turn; a longer backlog is read with read_board({topic}). */
const DIGEST_ANNOUNCEMENTS = 5;
/** Posts one resolve_post call may name. */
const RESOLVE_MAX_POSTS = 32;
const RESOLVE_MAX_NOTE = 500;

/** A topic as given by a caller: case does not distinguish topics. */
function topicName(value: unknown): string {
  const name = scriptText(value, 'board topic', 100).toLowerCase();
  if (!TOPIC.test(name)) throw new Error('A board topic is 1–40 letters, digits, _, . or -, starting with a letter or digit');
  return name;
}

const topicOf = (post: Immutable<BoardPost>) => post.topic ?? BOARD_DEFAULT_TOPIC;

function mentioned(text: string, name: string): boolean {
  return new RegExp('(^|[^A-Za-z0-9_.@/-])@' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + NAME_END).test(text);
}

/**
 * The members a post is delivered to: the explicit `to` list plus every `@name` in the text, without the sender.
 * `all` (in `to`, or `@all` in the text) addresses every member that exists when the post is made. Unknown names in
 * `to` are rejected; an `@word` that names no member is ordinary text. A `literal` post goes to its `to` list only.
 */
function recipients(state: WorkflowView, text: string, to: unknown, sender?: string, literal = false): { agents: AgentView[]; all: boolean } {
  const agents = state.agents ?? [];
  const requested = to === undefined || to === null ? [] : typeof to === 'string' ? [to] : to;
  if (!Array.isArray(requested) || requested.length > MAX_NAMED_MEMBERS || requested.some(name => typeof name !== 'string')) throw new Error(`Post field to must be "all" or an array of at most ${MAX_NAMED_MEMBERS} member names`);
  const names = requested.map(name => scriptText(String(name).replace(/^@/, ''), 'member name', 100));
  const all = names.includes('all') || !literal && mentioned(text, 'all');
  const chosen = new Set(all ? agents : names.map(name => member(state, name)));
  if (!literal) for (const agent of agents) if (mentioned(text, agent.key)) chosen.add(agent);
  return { agents: agents.filter(agent => chosen.has(agent) && agent.agentId !== sender), all };
}

/**
 * Appends a post and delivers it to its recipients' inboxes, which wakes the ones waiting for a message. `literal`
 * is for posts whose text names nobody: an `@name` in it is ordinary text, and only `to` says who receives it. `ask`
 * and `answers` mark the post as an ask or as the answer to one; who may ask whom, and what follows from an answer,
 * is decided by the caller (asks.ts).
 */
export function postToBoard(state: WorkflowView, sender: { agentId: string } | { author: BoardAuthor }, input: { text?: unknown; to?: unknown; topic?: unknown }, now: number,
  options: { literal?: boolean; ask?: { within: number }; answers?: number } = {}): { seq: number; postId: string; to: string[]; topic?: string } {
  const text = scriptText(input.text, 'post', POST_MAX_TEXT);
  if (!text.trim()) throw new Error('Post text must not be empty');
  const from = 'agentId' in sender ? sender.agentId : undefined;
  const topic = input.topic === undefined || input.topic === null ? BOARD_DEFAULT_TOPIC : topicName(input.topic);
  if (topic === BOARD_ANNOUNCE_TOPIC && from && !state.swarms?.some(swarm => swarm.lead === memberName(state, from))) {
    throw new Error(`Topic "${BOARD_ANNOUNCE_TOPIC}" is for rules and rulings from the main agent and the lead of the swarm; note it in another topic, or ask whoever must act`);
  }
  const known = Object.keys(state.board?.topics ?? {});
  if (topic !== BOARD_DEFAULT_TOPIC && !known.includes(topic) && known.filter(name => name !== BOARD_DEFAULT_TOPIC).length >= BOARD_MAX_TOPICS) {
    throw new Error(`Board topic limit reached (${BOARD_MAX_TOPICS}); post in an existing topic: ${known.join(', ')}`);
  }
  const target = recipients(state, text, input.to, from, options.literal);
  const delivered = (state.mailbox?.messages ?? []).filter(message => message.post !== undefined).length;
  if (delivered + target.agents.length > BOARD_MAX_DELIVERIES) throw new Error('Board delivery limit reached; address fewer members');
  const post: BoardPost = { seq: boardTotal(state) + 1, id: randomUUID(), ...(from ? { from } : { author: (sender as { author: BoardAuthor }).author }),
    to: target.agents.map(agent => agent.agentId), ...(target.all ? { all: true } : {}), ...(topic === BOARD_DEFAULT_TOPIC ? {} : { topic }), text, createdAt: now,
    ...(options.ask ? { ask: options.ask } : {}), ...(options.answers === undefined ? {} : { answers: options.answers }) };
  const deliveries: MailboxMessage[] = post.to.map(to => ({ id: randomUUID(), to, ...(from ? { from } : {}), text: '', topic: BOARD_TOPIC, createdAt: now, post: post.seq }));
  emit(state, { type: 'board_posted', post, deliveries });
  return { seq: post.seq, postId: post.id, to: target.agents.map(agent => agent.key), ...(post.topic ? { topic: post.topic } : {}) };
}

export function memberName(state: WorkflowView, agentId: string): string {
  return state.agents?.find(agent => agent.agentId === agentId)?.key ?? agentId;
}

/**
 * Marks posts resolved, or reopens them. Resolving says that a post needs nobody any more: its question was answered,
 * its request done, its conclusion replaced. The post stays in the feed and in searches as written, so what was asked
 * and tried is not lost, but reads skip it unless asked, and the board shows what is still open. A resolution says
 * how the post was settled (`note`), where the answer is (`see`), or both.
 *
 * The post's author, a member it names, a lead and the main agent may resolve it; an announcement only those who may
 * announce. Posts that are already in the requested state are reported as `unchanged` and keep their first resolution.
 */
export function resolvePosts(state: WorkflowView, by: { agentId: string } | { author: 'main' }, input: { seq?: unknown; note?: unknown; see?: unknown; reopen?: unknown }, now: number): { resolved?: number[]; reopened?: number[]; unchanged?: number[] } {
  const total = boardTotal(state);
  const listed = Array.isArray(input.seq) ? input.seq : [input.seq];
  if (!listed.length || listed.length > RESOLVE_MAX_POSTS) throw new Error(`seq must be a post's seq or an array of 1–${RESOLVE_MAX_POSTS} of them`);
  const seqs = [...new Set(listed.map(seq => {
    if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 1 || seq > total) throw new Error(`Unknown board post: ${JSON.stringify(seq) ?? 'undefined'}; the board has ${total} posts`);
    return seq;
  }))];
  if (input.reopen !== undefined && typeof input.reopen !== 'boolean') throw new Error('reopen must be a boolean');
  const reopen = input.reopen === true;
  if (reopen && (input.note !== undefined || input.see !== undefined)) throw new Error('reopen takes neither note nor see');
  const note = input.note === undefined || input.note === null ? undefined : scriptText(input.note, 'note', RESOLVE_MAX_NOTE);
  const see = input.see === undefined || input.see === null ? undefined : boundedInteger(input.see, 0, 1, total);
  if (!reopen && note === undefined && see === undefined) throw new Error('Say how the post was resolved: note, a sentence, or see, the seq of the post that answers or replaces it');
  if (see !== undefined && seqs.includes(see)) throw new Error('see names the post that answers or replaces the resolved one, not the post itself');

  const me = 'agentId' in by ? by.agentId : undefined;
  const name = me === undefined ? undefined : memberName(state, me);
  const leads = name !== undefined && state.swarms?.some(swarm => swarm.lead === name);
  const plans = leads || name !== undefined && state.swarms?.some(swarm => swarm.members.some(member => member.name === name && member.leads?.length));
  const posts = seqs.map(seq => {
    const post = postBySeq(state, seq);
    if (!post) throw new Error(`Unknown board post: ${seq}`);
    if (me === undefined) return post;
    if (topicOf(post) === BOARD_ANNOUNCE_TOPIC) {
      if (!leads) throw new Error(`Post ${seq} is an announcement; only the main agent and the lead ${reopen ? 'reopen' : 'resolve'} one`);
    } else if (!plans && post.from !== me && (post.all || !post.to.includes(me))) {
      throw new Error(`Post ${seq} is neither yours nor addressed to you by name; its author, a member it names, a lead or the main agent can ${reopen ? 'reopen' : 'resolve'} it`);
    }
    return post;
  });
  const resolved: PostResolution | undefined = reopen ? undefined : { ...(me === undefined ? {} : { from: me }), at: now, ...(note === undefined ? {} : { note }), ...(see === undefined ? {} : { see }) };
  const changed: number[] = [], unchanged: number[] = [];
  for (const post of posts) {
    if (Boolean(post.resolved) !== reopen) { unchanged.push(post.seq); continue; }
    // A reopened ask is owed again from now on.
    emit(state, { type: 'board_post_resolved', seq: post.seq, postId: post.id, topic: topicOf(post), ...(resolved ? { resolved } : post.ask ? { ask: openAsk(post, now) } : {}) });
    changed.push(post.seq);
  }
  return { ...(changed.length ? { [reopen ? 'reopened' : 'resolved']: changed } : {}), ...(unchanged.length ? { unchanged } : {}) };
}

interface BoardPostView { seq: number; from: string; to: string[]; all?: true; topic?: string; text: string; at: number; ask?: { withinMinutes: number }; answers?: number; resolved?: ReturnType<typeof resolutionView> }

/** A post as readers see it. `marks: false` leaves out whether it is resolved, for reads that a replay must repeat. */
function postView(state: WorkflowView, post: Immutable<BoardPost>, marks = true): BoardPostView {
  return { seq: post.seq, from: post.from ? memberName(state, post.from) : post.author ?? 'main', to: post.to.map(id => memberName(state, id)),
    ...(post.all ? { all: true as const } : {}), ...(post.topic ? { topic: post.topic } : {}), text: post.text, at: post.createdAt,
    ...(post.ask ? { ask: { withinMinutes: post.ask.within / 60_000 } } : {}), ...(post.answers === undefined ? {} : { answers: post.answers }),
    ...(marks && post.resolved ? { resolved: resolutionView(state, post.resolved) } : {}) };
}

interface BoardTopicView { topic: string; posts: number; lastSeq: number; resolved?: number }

/**
 * The board's topics, the busiest first. The default topic also holds the posts made before topics were recorded.
 * `resolved` is how many of a topic's posts are resolved, so `posts - resolved` are open.
 */
export function boardTopics(state: Pick<WorkflowView, 'board' | 'archivedRecords'>): BoardTopicView[] {
  const topics = state.board?.topics ?? {};
  const elsewhere = Object.entries(topics).reduce((sum, [name, topic]) => sum + (name === BOARD_DEFAULT_TOPIC ? 0 : topic.posts), 0);
  const general = (state.board?.posts.length ?? 0) + (state.archivedRecords?.post ?? 0) - elsewhere;
  const view = (name: string, posts: number): BoardTopicView => ({ topic: name, posts, lastSeq: topics[name]?.recent.at(-1) ?? 0, ...(topics[name]?.resolved ? { resolved: topics[name].resolved } : {}) });
  return [...(general ? [view(BOARD_DEFAULT_TOPIC, general)] : []),
    ...Object.entries(topics).filter(([name]) => name !== BOARD_DEFAULT_TOPIC).map(([name, topic]) => view(name, topic.posts))]
    .sort((a, b) => b.posts - a.posts);
}

/** The announcements made after `since` that still stand, the oldest first, and how many there are beyond the latest few. */
function announcedSince(state: WorkflowView, since: number): { unseen: Array<Immutable<BoardPost>>; missed: number } {
  const recent = (state.board?.topics?.[BOARD_ANNOUNCE_TOPIC]?.recent ?? []).filter(seq => seq > since).flatMap(seq => { const post = postBySeq(state, seq); return post && !post.resolved ? [post] : []; });
  const unseen = recent.slice(-DIGEST_ANNOUNCEMENTS);
  // Only the latest few seqs are kept, so a count beyond them comes from the posts in the state.
  const fresh = (state.board?.posts ?? []).filter(post => post.seq > since && !post.resolved && topicOf(post) === BOARD_ANNOUNCE_TOPIC).length;
  return { unseen, missed: Math.max(fresh, recent.length) - unseen.length };
}

/**
 * What the brief of a turn says of the board: the rulings made since the member's previous turn was scheduled, and
 * for a lead how many notes of what members saw are new. Everything else on the board is read when it is wanted.
 */
export function boardNews(state: WorkflowView, since: number, lead: boolean): { rulings: Array<{ seq: number; from: string; text: string }>; moreRulings: number; noticed: number } {
  const { unseen, missed } = announcedSince(state, since);
  return { rulings: unseen.map(post => ({ seq: post.seq, from: post.from ? memberName(state, post.from) : post.author ?? 'main', text: post.text })), moreRulings: Math.max(0, missed),
    noticed: lead ? (state.board?.posts ?? []).filter(post => post.seq > since && !post.resolved && topicOf(post) === BOARD_NOTICED_TOPIC).length : 0 };
}

/**
 * What read_context tells a member about the board without reading it: the announcements made since its previous
 * turn was scheduled, in full, and for each topic how many posts it holds and how many of them are new. `new` counts
 * the posts still in the state; `older` is how many new posts have left it, which the topics' totals still include.
 * Posts resolved in the meantime are neither announced nor counted as new: nobody needs to read them.
 */
export function boardDigest(state: WorkflowView, task: TaskView): unknown {
  if (!task.agentId) return undefined;
  const since = task.boardSince ?? 0;
  const fresh = new Map<string, number>();
  for (const post of state.board?.posts ?? []) if (post.seq > since && !post.resolved) fresh.set(topicOf(post), (fresh.get(topicOf(post)) ?? 0) + 1);
  const older = (state.archivedRecords?.post ?? 0) - since;
  const { unseen, missed } = announcedSince(state, since);
  return { lastSeq: boardTotal(state), since, ...(older > 0 ? { older } : {}),
    topics: boardTopics(state).map(topic => ({ ...topic, new: fresh.get(topic.topic) ?? 0 })),
    announcements: unseen.map(post => postView(state, post)),
    ...(missed > 0 ? { moreAnnouncements: missed } : {}) };
}

/**
 * Reads the feed in order. With `after`, the posts following that seq; otherwise the latest ones. `member` keeps posts
 * from or to it, `topic` the posts of one topic. Resolved posts are skipped unless `resolved` is true, and
 * `resolvedSkipped` says how many were passed over on the way to the returned ones.
 *
 * `upTo` bounds the read to a seq recorded earlier, so a replayed script sees the board as it was: such a read returns
 * every post as posted, without resolutions, which may have been made since. A read that is not bound by `upTo` also
 * lists the board's topics once it has several.
 */
export function readBoard(state: WorkflowView, input: { after?: unknown; limit?: unknown; member?: unknown; topic?: unknown; resolved?: unknown; upTo?: number } = {}): { posts: BoardPostView[]; lastSeq: number; hasMore: boolean; resolvedSkipped?: number; topics?: BoardTopicView[] } {
  const total = boardTotal(state);
  const lastSeq = Math.min(total, input.upTo ?? total);
  const limit = boundedInteger(input.limit, 20, 1, 50);
  const only = input.member === undefined ? undefined : member(state, scriptText(input.member, 'member name', 100)).agentId;
  const topic = input.topic === undefined ? undefined : topicName(input.topic);
  const asPosted = input.upTo !== undefined;
  if (input.resolved !== undefined && typeof input.resolved !== 'boolean') throw new Error('resolved must be a boolean');
  const matches = (post: Immutable<BoardPost>) => (!only || post.from === only || post.to.includes(only)) && (!topic || topicOf(post) === topic);
  /**
   * The first `stop` matching posts of a feed, and how many resolved ones the returned page passes over: those before
   * its last post, and those after it when the feed ends there. What lies between two pages counts for the later one.
   */
  const take = (posts: Iterable<Immutable<BoardPost>>, stop: number) => {
    const kept: Array<Immutable<BoardPost>> = [];
    let skipped = 0, beyond = 0;
    const counted = (count: number) => ({ kept, skipped: count ? { resolvedSkipped: count } : {} });
    for (const post of posts) {
      if (!matches(post)) continue;
      if (post.resolved && !asPosted && input.resolved !== true) { if (kept.length < limit) skipped++; else beyond++; continue; }
      if (kept.push(post) === stop) return counted(skipped);
    }
    return counted(skipped + beyond);
  };
  const listed = asPosted ? [] : boardTopics(state);
  const topics = listed.length > 1 ? { topics: listed } : {};
  if (input.after === undefined) {
    const { kept, skipped } = take(feed(state, 0, lastSeq, true), limit);
    return { posts: kept.reverse().map(post => postView(state, post, !asPosted)), lastSeq, hasMore: false, ...skipped, ...topics };
  }
  const after = boundedInteger(input.after, 0, 0, Number.MAX_SAFE_INTEGER);
  const { kept, skipped } = take(feed(state, after, lastSeq, false), limit + 1);
  return { posts: kept.slice(0, limit).map(post => postView(state, post, !asPosted)), lastSeq, hasMore: kept.length > limit, ...skipped, ...topics };
}

/**
 * Finds posts by words in their text, newest first, including posts that have left the state. A hit carries the text
 * around the match; read_board({after: seq - 1, limit: 1, resolved: true}) returns the whole post. `member` keeps posts
 * from or to it, `topic` the posts of one topic.
 *
 * Resolved posts are found too, after the open ones and with their resolution, whose note is searched like the text:
 * whoever is about to ask or report something learns that it came up before and how it ended.
 */
export function searchBoard(state: WorkflowView, input: { query?: unknown; member?: unknown; topic?: unknown; limit?: unknown } = {}): unknown {
  if (Object.keys(input).some(key => !['query', 'member', 'topic', 'limit'].includes(key))) throw new Error('Unsupported search_board option');
  const terms = searchTerms(input.query);
  const limit = boundedInteger(input.limit, 10, 1, 30);
  const only = input.member === undefined ? undefined : member(state, scriptText(input.member, 'member name', 100)).agentId;
  const topic = input.topic === undefined ? undefined : topicName(input.topic);
  const archived = state.archivedRecords?.post ? recordsOf(state).search('post', storedTerms(terms), SEARCH_ARCHIVE_ROWS) as BoardPost[] : [];
  const hits = [];
  for (const post of [...state.board?.posts ?? [], ...archived]) {
    if (only && post.from !== only && !post.to.includes(only) || topic && topicOf(post) !== topic) continue;
    const hit = matchFields(terms, [['text', post.text], ...(post.resolved?.note ? [['note', post.resolved.note] as const] : [])]);
    if (hit) hits.push({ post, hit });
  }
  hits.sort((a, b) => Number(Boolean(a.post.resolved)) - Number(Boolean(b.post.resolved)) || b.post.seq - a.post.seq);
  return { matches: hits.length, hasMore: hits.length > limit || archived.length === SEARCH_ARCHIVE_ROWS,
    posts: hits.slice(0, limit).map(({ post, hit }) => {
      const { text: _text, ...view } = postView(state, post);
      return { ...view, snippet: hit.snippet };
    }) };
}

/** Posts with `after < seq <= upTo` in feed order, or newest first; the older ones come from the archive a page at a time. */
function* feed(state: WorkflowView, after: number, upTo: number, newestFirst: boolean): Generator<Immutable<BoardPost>> {
  const archived = state.archivedRecords?.post ?? 0;
  const live = (state.board?.posts ?? []).filter(post => post.seq > after && post.seq <= upTo);
  function* stored(): Generator<Immutable<BoardPost>> {
    let from = after, to = Math.min(upTo, archived);
    while (from < to) {
      const page = recordsOf(state).range('post', { after: from, upTo: to, limit: 200, desc: newestFirst }) as BoardPost[];
      if (!page.length) return;
      yield* page;
      if (newestFirst) to = page.at(-1)!.seq - 1; else from = page.at(-1)!.seq;
    }
  }
  if (newestFirst) { yield* [...live].reverse(); yield* stored(); }
  else { yield* stored(); yield* live; }
}

/** Members parked in an unsettled wait: no turn is running and nothing that wait listens for has arrived. */
export function parkedMembers(state: WorkflowView): Set<string> {
  const parked = new Set<string>();
  for (const agent of state.agents ?? []) {
    // A member whose turn ended in failure cannot act again in this run; it must not keep the others waiting.
    if (agent.activeTurnId && ['failed', 'cancelled', 'waiting_input'].includes(state.tasks.find(task => task.taskId === agent.activeTurnId)?.status ?? '')) { parked.add(agent.agentId); continue; }
    if (agent.activeTurnId || !agent.wait) continue;
    if (agent.wait.kind === 'message') {
      if (state.mailbox?.receipts.find(receipt => receipt.id === agent.wait!.receiptId)?.status === 'waiting') parked.add(agent.agentId);
      continue;
    }
    const wait = state.waits?.find(item => item.id === agent.wait!.receiptId);
    if (!wait || wait.status !== 'waiting' || wait.runId !== state.script?.runId) continue;
    if (!wait.any.some(arm => arm.kind === 'message' && arm.member === agent.key && availableMessages(state, agent.agentId, arm).length)) parked.add(agent.agentId);
  }
  return parked;
}
