import { memberName, postToBoard, resolvePosts } from './board';
import { member, tellMember } from './durable-agents';
import { BUSY, postBySeq, pushEvent, taskById } from './kernel-state';
import { BOARD_ANNOUNCE_TOPIC, BOARD_MAX_ASKS, BOARD_MAX_ASKS_EACH } from './limits';
import { scriptText } from './script-contract';
import { leadsAbove, memberSwarm, plansWork, readsPosts } from './swarm';
import { holderOf, settleNotice, type Situation } from './todos';
import type { Immutable, OpenAsk, WorkflowView } from './types';

/**
 * Asking, answering and noting: the three things a member, or the main agent, says to others.
 *
 * An ask wants an answer or an action from one member, or from the main agent, and its author waits for it. It is a
 * to-do of the one asked until it is answered: shown at every turn, and passed up to those above when the time its
 * author gave runs out (see `askSituations`, and todos.ts for what all to-dos share). The answer goes back to
 * whoever asked and closes the ask in the same step.
 *
 * A note tells and asks nothing of anyone. It wakes nobody: whoever it concerns reads it when it next has a turn, in
 * the topic it was put in. Whether a post costs someone a turn used to hang on whether it named them, and since
 * naming was the only way to be sure of being read, most posts named someone. Now what must be acted on is asked,
 * and the rest is noted.
 */

type Speaker = { agentId: string } | { author: 'main' };

/** How long an ask waits (minutes) when its author gives no time, and the longest it may give. */
const ASK_DEFAULT_MINUTES = 15;
const ASK_MAX_MINUTES = 24 * 60;

const open = (state: WorkflowView) => state.board?.asks ?? [];
const minutes = (ms: number) => Math.max(1, Math.round(ms / 60_000));
/** How long ago, in whole minutes. */
const ago = (ms: number) => Math.max(0, Math.round(ms / 60_000));

/** An ask: `to` is the one member that owes the answer, or `main`; `withinMinutes` is how long its author can wait. */
export function ask(state: WorkflowView, sender: Speaker, input: { to?: unknown; text?: unknown; withinMinutes?: unknown; topic?: unknown }, now: number): unknown {
  const me = 'agentId' in sender ? sender.agentId : undefined;
  if (input.withinMinutes !== undefined && input.withinMinutes !== null && (typeof input.withinMinutes !== 'number' || !Number.isSafeInteger(input.withinMinutes) || input.withinMinutes < 1 || input.withinMinutes > ASK_MAX_MINUTES)) {
    throw new Error(`withinMinutes is how long you can wait for the answer (1–${ASK_MAX_MINUTES}; ${ASK_DEFAULT_MINUTES} when left out)`);
  }
  const within = (typeof input.withinMinutes === 'number' ? input.withinMinutes : ASK_DEFAULT_MINUTES) * 60_000;
  if (open(state).length >= BOARD_MAX_ASKS) throw new Error(`${BOARD_MAX_ASKS} asks are open, the most there can be; note what you have to say instead, or withdraw the asks that need no answer any more`);
  if (open(state).filter(item => item.from === me).length >= BOARD_MAX_ASKS_EACH) {
    throw new Error(`You have ${BOARD_MAX_ASKS_EACH} asks open, the most one author may have; answer({ask, text}) on an ask of your own withdraws it`);
  }
  const named = (Array.isArray(input.to) ? input.to : [input.to]).map(name => typeof name === 'string' ? name.replace(/^@/, '') : name);
  if (named.length !== 1 || typeof named[0] !== 'string' || named[0] === 'all') {
    throw new Error(`An ask names in "to" the one member that owes the answer${me ? ', or "main" for the main agent' : ''}; what is for several members is a note`);
  }
  // A ruling binds everyone; an ask is one member's to answer.
  if (typeof input.topic === 'string' && input.topic.toLowerCase() === BOARD_ANNOUNCE_TOPIC) throw new Error(`An ask is for one member and topic "${BOARD_ANNOUNCE_TOPIC}" for everyone; ask in another topic`);
  // Only `to` says who is asked: a name in the text of a question is as often the subject as the addressee.
  const literal = { literal: true, ask: { within } };
  if (named[0] === 'main') {
    if (!me) throw new Error('You are the main agent: an ask names the member that owes the answer');
    const above = leadsAbove(state, memberName(state, me));
    if (above.length) throw new Error(`Ask the lead above you (${above[0]}), which asks the main agent what it cannot answer itself`);
    const post = postToBoard(state, sender, { text: input.text, topic: input.topic }, now, literal);
    return { ask: post.seq, to: 'main', withinMinutes: minutes(within) };
  }
  const name = scriptText(named[0], 'member name', 100);
  if (!state.agents?.some(agent => agent.key === name) && memberSwarm(state, name)) {
    throw new Error(`Member "${name}" has not had a turn yet (a member starts when its queue has work for it): put what you need into a work item for it (enqueue_work with assignee), or ask its lead`);
  }
  const target = member(state, name);
  if (target.agentId === me) throw new Error('An ask names another member, not yourself');
  if (!readsPosts(state, target.key, me === undefined)) throw new Error(`Member "${target.key}" will not have another turn to answer in; ask a member that runs, or the lead`);
  const post = postToBoard(state, sender, { text: input.text, to: [target.key], topic: input.topic }, now, literal);
  return { ask: post.seq, to: target.key, withinMinutes: minutes(within) };
}

/**
 * The answer to an ask, from the one asked, from a lead or from the main agent: it goes to whoever asked, which is
 * woken for it, and closes the ask. Whoever asked closes its own ask the same way, which withdraws it.
 */
export function answer(state: WorkflowView, sender: Speaker, input: { ask?: unknown; text?: unknown; topic?: unknown }, now: number): unknown {
  const me = 'agentId' in sender ? sender.agentId : undefined;
  const asked = open(state).find(item => item.seq === input.ask);
  if (!asked) {
    const post = typeof input.ask === 'number' && Number.isSafeInteger(input.ask) && input.ask >= 1 ? postBySeq(state, input.ask) : undefined;
    throw new Error(!post ? `No ask has the number ${JSON.stringify(input.ask) ?? 'undefined'}; your brief (read_context) lists the asks that wait on you` : !post.ask ? `Post ${post.seq} is not an ask; what you have to say about it is a note`
      : `Ask ${post.seq} is closed already${post.resolved?.see ? ` (see post ${post.resolved.see})` : ''}; what you have to add is a note, or an ask of your own`);
  }
  if (me !== undefined && asked.from !== me && asked.to !== me && !plansWork(state, memberName(state, me))) {
    throw new Error(`Ask ${asked.seq} is not addressed to you; the member it names, a lead or the main agent answers it`);
  }
  const text = scriptText(input.text, 'answer', 4000);
  const own = asked.from === me;
  const asker = asked.from === undefined ? undefined : memberName(state, asked.from);
  // The answer goes to whoever asked, in the topic of the ask unless it says another.
  const topic = input.topic ?? postBySeq(state, asked.seq)?.topic;
  const posted = postToBoard(state, sender, { text, to: !own && asker !== undefined && readsPosts(state, asker) ? [asker] : [], topic }, now, { answers: asked.seq, literal: true });
  resolvePosts(state, sender, { seq: asked.seq, see: posted.seq }, now);
  settleNotice(state, `ask:${asked.seq}`, now);
  if (!own && asked.from === undefined) {
    pushEvent(state, { kind: 'worker_reply', summary: `${me === undefined ? 'main' : memberName(state, me)} 答复了你的第 ${asked.seq} 帖请求（全文是第 ${posted.seq} 帖，read_board 可读）：${text.slice(0, 500)}` }, () => now);
  }
  return { ask: asked.seq, post: posted.seq, ...(own ? { withdrawn: true } : { answered: true }) };
}

/** A note: a post that tells, in a topic, and reaches nobody's inbox. `to` and @names in it name nobody. */
export function note(state: WorkflowView, sender: Speaker, input: { text?: unknown; topic?: unknown; to?: unknown }, now: number): unknown {
  if (input.to !== undefined && input.to !== null) throw new Error('A note names nobody and wakes nobody: ask({to, text}) gets an answer or an action from a member, and tell_worker, for a lead and the main agent, puts words in front of one');
  const post = postToBoard(state, sender, { text: input.text, topic: input.topic }, now, { literal: true });
  return { seq: post.seq, ...(post.topic ? { topic: post.topic } : {}) };
}

/**
 * The resolve_post operation: marks notes that need nobody any more, or reopens them. An ask that someone other
 * than its author closes this way is closed without an answer, which its author is told; an ask that is reopened is
 * a to-do of the one asked again.
 */
export function resolvePost(state: WorkflowView, by: Speaker, input: { seq?: unknown; note?: unknown; see?: unknown; reopen?: unknown }, now: number): unknown {
  const before = [...open(state)];
  const result = resolvePosts(state, by, input, now);
  for (const asked of before) if (result.resolved?.includes(asked.seq)) settleNotice(state, `ask:${asked.seq}`, now);
  const me = 'agentId' in by ? by.agentId : undefined;
  const who = me === undefined ? 'the main agent' : memberName(state, me);
  for (const asked of before.filter(item => result.resolved?.includes(item.seq) && item.from !== me)) {
    const to = asked.to ? memberName(state, asked.to) : 'main';
    const how = `${typeof input.note === 'string' ? ': ' + input.note : '.'}${typeof input.see === 'number' ? ` See post ${input.see}.` : ''}`;
    if (asked.from === undefined) pushEvent(state, { kind: 'worker_reply', summary: `${who} 结掉了你给 ${to} 的第 ${asked.seq} 帖请求${how}` }, () => now);
    else if (readsPosts(state, memberName(state, asked.from))) tellMember(state, memberName(state, asked.from), `Your ask ${asked.seq} to ${to} was closed by ${who} without an answer of its own${how}`, now);
  }
  return result;
}

/** How the one asked stands, for those who decide what to do about its silence. */
function standing(state: WorkflowView, agentId: string): 'stopped' | 'busy' | 'idle' {
  const agent = state.agents?.find(item => item.agentId === agentId);
  if (!agent || !readsPosts(state, agent.key)) return 'stopped';
  return BUSY.has(taskById(state, agent.activeTurnId)?.status ?? 'failed') ? 'busy' : 'idle';
}

/**
 * Every open ask is a situation: the one asked answers for it, then those above that member, the nearest first, then
 * the main agent, each with the time the asker gave. An asker that itself stands above the one asked can see to it,
 * so it is the last to be told. What an ask says depends on who holds it now: the one asked is asked, the others are
 * told that it has gone unanswered.
 */
export function askSituations(state: WorkflowView, now: number): Situation[] {
  if (!open(state).length) return [];
  const table = new Map((state.todos?.open ?? []).map(todo => [todo.subject, todo]));
  return open(state).map(asked => {
    const from = asked.from ? memberName(state, asked.from) : 'main';
    const to = asked.to ? memberName(state, asked.to) : 'main';
    let chain = to === 'main' ? ['main'] : [to, ...leadsAbove(state, to), 'main'];
    const cut = chain.indexOf(from, 1);
    if (cut > 0) chain = chain.slice(0, cut + 1);
    const subject = `ask:${asked.seq}`;
    const todo = table.get(subject);
    const holder = (todo && holderOf(todo)) ?? chain[0];
    const age = ago(now - asked.at);
    const how = asked.to ? { stopped: 'has stopped', busy: 'is in a turn', idle: 'is between turns' }[standing(state, asked.to)] : '';
    const howZh = asked.to ? { stopped: '已停止', busy: '在回合中', idle: '不在回合中' }[standing(state, asked.to)] : '';
    const asker = from === 'main' ? 'the main agent' : from;
    const first = { en: `Ask ${asked.seq} from ${asker}: "${asked.excerpt}"`, act: `answer({ask: ${asked.seq}, text}); when you cannot answer yet, answer with what it waits on. read_board({after: ${asked.seq - 1}, limit: 1, resolved: true}) has the ask in full.` };
    const text = holder === to ? first
      : holder === from ? { en: `Your ask ${asked.seq} to ${to} has had no answer for ${age} min (${to} ${how}): "${asked.excerpt}"`,
        act: `have ${to} answer (tell_worker reaches it in its turn, where you may), ask someone else, or withdraw it with answer({ask: ${asked.seq}, text}).` }
      : { en: `Ask ${asked.seq} from ${asker} to ${to} has had no answer for ${age} min (${to} ${how}): "${asked.excerpt}"`,
        act: `answer in its place with answer({ask: ${asked.seq}, text}), or have ${to} answer (tell_worker reaches it in its turn).` };
    return { subject, kind: 'ask' as const, chain, since: asked.at, within: asked.within, ...text, ...(holder === to ? {} : { first }),
      zh: to === 'main' ? `${from} 请你答复（第 ${asked.seq} 帖，它等 ${minutes(asked.within)} 分钟）：${(postBySeq(state, asked.seq)?.text ?? asked.excerpt).slice(0, 450)}。用 answer({ask:${asked.seq},text}) 答复，它被唤醒并收到。`
        : `第 ${asked.seq} 帖请求（${from === 'main' ? '你' : from} 问 ${to}）已 ${age} 分钟未答复，${to} ${howZh}：「${asked.excerpt.slice(0, 120)}」。可以代答（answer），用 tell_worker 催被问的成员，或用 resolve_post 结掉不再需要的。` };
  });
}

/** The asks a member made that are still open, for its brief. */
export function openAsksOf(state: WorkflowView, agentId: string, now: number): Array<{ seq: number; to: string; minutes: number; text: string }> {
  return open(state).filter(asked => asked.from === agentId)
    .map((asked: Immutable<OpenAsk>) => ({ seq: asked.seq, to: asked.to ? memberName(state, asked.to) : 'main', minutes: ago(now - asked.at), text: asked.excerpt }));
}
