import { randomUUID } from 'node:crypto';
import { availableMessages, member } from './durable-agents';
import { boardTotal } from './kernel-state';
import { emit, recordsOf } from './kernel-store';
import { BOARD_MAX_DELIVERIES, MAX_NAMED_MEMBERS } from './limits';
import { boundedInteger, scriptText } from './script-contract';
import { matchFields, SEARCH_ARCHIVE_ROWS, searchTerms, storedTerms } from './search';
import type { AgentView, BoardAuthor, BoardPost, Immutable, MailboxMessage, WorkflowView } from './types';

/** Topic of the mailbox messages that deliver board posts; `receive(member,{topic})` can select or skip them. */
const BOARD_TOPIC = 'board';
const POST_MAX_TEXT = 4000;
const NAME_END = '(?![A-Za-z0-9_\\-/]|\\.[A-Za-z0-9])';

function mentioned(text: string, name: string): boolean {
  return new RegExp('(^|[^A-Za-z0-9_.@/-])@' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + NAME_END).test(text);
}

/**
 * The members a post is delivered to: the explicit `to` list plus every `@name` in the text, without the sender.
 * `all` (in `to`, or `@all` in the text) addresses every member that exists when the post is made. Unknown names in
 * `to` are rejected; an `@word` that names no member is ordinary text.
 */
function recipients(state: WorkflowView, text: string, to: unknown, sender?: string): { agents: AgentView[]; all: boolean } {
  const agents = state.agents ?? [];
  const requested = to === undefined || to === null ? [] : typeof to === 'string' ? [to] : to;
  if (!Array.isArray(requested) || requested.length > MAX_NAMED_MEMBERS || requested.some(name => typeof name !== 'string')) throw new Error(`Post field to must be "all" or an array of at most ${MAX_NAMED_MEMBERS} member names`);
  const names = requested.map(name => scriptText(String(name).replace(/^@/, ''), 'member name', 100));
  const all = names.includes('all') || mentioned(text, 'all');
  const chosen = new Set(all ? agents : names.map(name => member(state, name)));
  for (const agent of agents) if (mentioned(text, agent.key)) chosen.add(agent);
  return { agents: agents.filter(agent => chosen.has(agent) && agent.agentId !== sender), all };
}

/** Appends a post and delivers it to its recipients' inboxes, which wakes the ones waiting for a message. */
export function postToBoard(state: WorkflowView, sender: { agentId: string } | { author: BoardAuthor }, input: { text?: unknown; to?: unknown }, now: number): { seq: number; postId: string; to: string[] } {
  const text = scriptText(input.text, 'post', POST_MAX_TEXT);
  if (!text.trim()) throw new Error('Post text must not be empty');
  const from = 'agentId' in sender ? sender.agentId : undefined;
  const target = recipients(state, text, input.to, from);
  const delivered = (state.mailbox?.messages ?? []).filter(message => message.post !== undefined).length;
  if (delivered + target.agents.length > BOARD_MAX_DELIVERIES) throw new Error('Board delivery limit reached; address fewer members');
  const post: BoardPost = { seq: boardTotal(state) + 1, id: randomUUID(), ...(from ? { from } : { author: (sender as { author: BoardAuthor }).author }),
    to: target.agents.map(agent => agent.agentId), ...(target.all ? { all: true } : {}), text, createdAt: now };
  const deliveries: MailboxMessage[] = post.to.map(to => ({ id: randomUUID(), to, ...(from ? { from } : {}), text: '', topic: BOARD_TOPIC, createdAt: now, post: post.seq }));
  emit(state, { type: 'board_posted', post, deliveries });
  return { seq: post.seq, postId: post.id, to: target.agents.map(agent => agent.key) };
}

function memberName(state: WorkflowView, agentId: string): string {
  return state.agents?.find(agent => agent.agentId === agentId)?.key ?? agentId;
}

interface BoardPostView { seq: number; from: string; to: string[]; all?: true; text: string; at: number }

function postView(state: WorkflowView, post: Immutable<BoardPost>): BoardPostView {
  return { seq: post.seq, from: post.from ? memberName(state, post.from) : post.author ?? 'main', to: post.to.map(id => memberName(state, id)),
    ...(post.all ? { all: true as const } : {}), text: post.text, at: post.createdAt };
}

/**
 * Reads the feed in order. With `after`, the posts following that seq; otherwise the latest ones. `upTo` bounds the
 * read to a seq recorded earlier, so a replayed script sees the board as it was. `member` keeps posts from or to it.
 */
export function readBoard(state: WorkflowView, input: { after?: unknown; limit?: unknown; member?: unknown; upTo?: number } = {}): { posts: BoardPostView[]; lastSeq: number; hasMore: boolean } {
  const total = boardTotal(state);
  const lastSeq = Math.min(total, input.upTo ?? total);
  const limit = boundedInteger(input.limit, 20, 1, 50);
  const only = input.member === undefined ? undefined : member(state, scriptText(input.member, 'member name', 100)).agentId;
  const matches = (post: Immutable<BoardPost>) => !only || post.from === only || post.to.includes(only);
  if (input.after === undefined) {
    const latest: Array<Immutable<BoardPost>> = [];
    for (const post of feed(state, 0, lastSeq, true)) if (matches(post) && latest.push(post) === limit) break;
    return { posts: latest.reverse().map(post => postView(state, post)), lastSeq, hasMore: false };
  }
  const after = boundedInteger(input.after, 0, 0, Number.MAX_SAFE_INTEGER);
  const rest: Array<Immutable<BoardPost>> = [];
  for (const post of feed(state, after, lastSeq, false)) if (matches(post) && rest.push(post) > limit) break;
  return { posts: rest.slice(0, limit).map(post => postView(state, post)), lastSeq, hasMore: rest.length > limit };
}

/**
 * Finds posts by words in their text, newest first, including posts that have left the state. A hit carries the text
 * around the match; read_board({after: seq - 1, limit: 1}) returns the whole post. `member` keeps posts from or to it.
 */
export function searchBoard(state: WorkflowView, input: { query?: unknown; member?: unknown; limit?: unknown } = {}): unknown {
  if (Object.keys(input).some(key => !['query', 'member', 'limit'].includes(key))) throw new Error('Unsupported search_board option');
  const terms = searchTerms(input.query);
  const limit = boundedInteger(input.limit, 10, 1, 30);
  const only = input.member === undefined ? undefined : member(state, scriptText(input.member, 'member name', 100)).agentId;
  const archived = state.archivedRecords?.post ? recordsOf(state).search('post', storedTerms(terms), SEARCH_ARCHIVE_ROWS) as BoardPost[] : [];
  const hits = [];
  for (const post of [...state.board?.posts ?? [], ...archived]) {
    if (only && post.from !== only && !post.to.includes(only)) continue;
    const hit = matchFields(terms, [['text', post.text]]);
    if (hit) hits.push({ post, hit });
  }
  hits.sort((a, b) => b.post.seq - a.post.seq);
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
