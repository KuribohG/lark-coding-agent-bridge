import { askView, memberName, postToBoard, resolvePosts } from './board';
import { member } from './durable-agents';
import { acknowledge, BUSY, postBySeq, pushEvent, taskById } from './kernel-state';
import { BOARD_ANNOUNCE_TOPIC, BOARD_MAX_ASKS, BOARD_MAX_ASKS_EACH } from './limits';
import { scriptText } from './script-contract';
import { leadsAbove, plansWork, readsPosts } from './swarm';
import type { Immutable, OpenAsk, WorkflowView } from './types';

/**
 * Asking and answering on the board.
 *
 * A post tells; nothing says whether anyone was meant to act on it, so a question waits on its reader's attention and
 * its author cannot tell an answer that is coming from one that is not. An ask is a post whose author waits for an
 * answer from one named member, or from the main agent. It stays open until it is answered or resolved:
 * - the one asked is shown it at every turn (read_context, and the wake-up of a swarm member), not only the turn it arrived in;
 * - an answer (`answers`) goes back to the asker and resolves the ask in the same step;
 * - when the time the asker gave runs out, those who stand above the one asked are told, a level at a time.
 *
 * It says nothing about what is asked: a ruling, a review, a fact, a hand-off that must be confirmed.
 */

type Asker = { agentId: string } | { author: 'main' };

/** How long an ask waits (minutes) when its author gives no time, and the longest it may give. */
const ASK_DEFAULT_MINUTES = 15;
const ASK_MAX_MINUTES = 24 * 60;
/**
 * The main agent is told of an unanswered ask between members no sooner than this after it was made, however short
 * the time its author gave: members' turns last longer than their patience, and the main agent is not their operator.
 */
const ASK_MAIN_AFTER_MS = 30 * 60_000;
/** Asks one reminder quotes, to a member and to the main agent, whose notices are shown shortened; it counts the rest. */
const REMINDER_ASKS = 6;
const NOTICE_ASKS = 3;

const open = (state: WorkflowView) => state.board?.asks ?? [];
const minutes = (ms: number) => Math.max(1, Math.round(ms / 60_000));

function askWithin(value: unknown): number | undefined {
  if (value === undefined || value === null || value === false) return undefined;
  if (value === true) return ASK_DEFAULT_MINUTES * 60_000;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > ASK_MAX_MINUTES) {
    throw new Error(`ask is true, or the minutes you can wait for the answer (1–${ASK_MAX_MINUTES}; true waits ${ASK_DEFAULT_MINUTES})`);
  }
  return value * 60_000;
}

/** The post_board operation of the main agent and of a member: a post, an ask, or the answer to one. */
export function postBoard(state: WorkflowView, sender: Asker, input: { text?: unknown; to?: unknown; topic?: unknown; ask?: unknown; answers?: unknown }, now: number): unknown {
  const within = askWithin(input.ask);
  const answers = input.answers === undefined || input.answers === null ? undefined : input.answers;
  if (within === undefined && answers === undefined) return postToBoard(state, sender, input, now);
  if (within !== undefined && answers !== undefined) throw new Error('A post asks or answers, not both: answer, then ask in a post of its own');
  return within !== undefined ? ask(state, sender, input, within, now) : answer(state, sender, input, answers, now);
}

function ask(state: WorkflowView, sender: Asker, input: { text?: unknown; to?: unknown; topic?: unknown }, within: number, now: number): unknown {
  const me = 'agentId' in sender ? sender.agentId : undefined;
  if (open(state).length >= BOARD_MAX_ASKS) throw new Error(`The board has ${BOARD_MAX_ASKS} open asks, the most it holds; post without ask, or resolve the asks that need no answer any more`);
  if (open(state).filter(item => item.from === me).length >= BOARD_MAX_ASKS_EACH) {
    throw new Error(`You have ${BOARD_MAX_ASKS_EACH} asks open, the most one author may have; resolve_post the ones you no longer wait for`);
  }
  const named = (Array.isArray(input.to) ? input.to : [input.to]).map(name => typeof name === 'string' ? name.replace(/^@/, '') : name);
  if (named.length !== 1 || typeof named[0] !== 'string' || named[0] === 'all') {
    throw new Error(`An ask names in "to" the one member that owes the answer${me ? ', or "main" for the main agent' : ''}; a post for several members is a post without ask`);
  }
  // An announcement binds everyone and only those who may announce resolve one; an ask is one member's to answer.
  if (typeof input.topic === 'string' && input.topic.toLowerCase() === BOARD_ANNOUNCE_TOPIC) throw new Error(`An ask is for one member and topic "${BOARD_ANNOUNCE_TOPIC}" for everyone; ask in another topic`);
  // Only `to` says who is asked: a name in the text of a question is as often the subject as the addressee.
  const literal = { literal: true, ask: { within } };
  if (named[0] === 'main') {
    if (!me) throw new Error('You are the main agent: an ask names the member that owes the answer');
    const above = leadsAbove(state, memberName(state, me));
    if (above.length) throw new Error(`Ask the lead above you (${above[0]}), which asks the main agent what it cannot answer itself`);
    const post = postToBoard(state, sender, { text: input.text, topic: input.topic }, now, literal);
    askMain(state, open(state).find(item => item.seq === post.seq)!, now);
    return { ...post, to: ['main'], ask: { withinMinutes: minutes(within) } };
  }
  const target = member(state, scriptText(named[0], 'member name', 100));
  if (target.agentId === me) throw new Error('An ask names another member, not yourself');
  if (!readsPosts(state, target.key)) throw new Error(`Member "${target.key}" will not have another turn to answer in; ask a member that runs, or the lead`);
  return { ...postToBoard(state, sender, { text: input.text, to: [target.key], topic: input.topic }, now, literal), ask: { withinMinutes: minutes(within) } };
}

/** Raises the notice of an ask that the main agent owes the answer to. It stands until the ask is answered or resolved. */
function askMain(state: WorkflowView, asked: Immutable<OpenAsk>, now: number): void {
  // What to do comes before the quoted text: a notice is cut to its first few hundred characters where it is shown.
  pushEvent(state, { kind: 'ask_open', asks: [asked.seq], summary: `${asked.from ? memberName(state, asked.from) : 'main'} 请你答复（第 ${asked.seq} 帖，它等 ${minutes(asked.within)} 分钟；`
    + `用 post_board 的 answers:${asked.seq} 答复，它被唤醒并收到，答复或结帖后本通知自结）：${(postBySeq(state, asked.seq)?.text ?? asked.excerpt).slice(0, 450)}` }, () => now);
}

function answer(state: WorkflowView, sender: Asker, input: { text?: unknown; to?: unknown; topic?: unknown }, seq: unknown, now: number): unknown {
  const me = 'agentId' in sender ? sender.agentId : undefined;
  const asked = open(state).find(item => item.seq === seq);
  if (!asked) {
    const post = typeof seq === 'number' && Number.isSafeInteger(seq) && seq >= 1 ? postBySeq(state, seq) : undefined;
    throw new Error(!post ? `Unknown board post: ${JSON.stringify(seq) ?? 'undefined'}` : !post.ask ? `Post ${post.seq} is not an ask; post without answers`
      : `Ask ${post.seq} is already resolved${post.resolved?.see ? ` (see post ${post.resolved.see})` : ''}; post without answers, or reopen it with resolve_post({seq, reopen: true})`);
  }
  if (asked.from === me) throw new Error(`Ask ${asked.seq} is your own: resolve_post({seq, note}) closes it when you no longer wait for the answer`);
  if (me !== undefined && asked.to !== me && !plansWork(state, memberName(state, me))) {
    throw new Error(`Ask ${asked.seq} is not addressed to you; the member it names, a lead or the main agent answers it`);
  }
  // The answer goes to whoever asked, in the topic of the ask unless it says another.
  const topic = input.topic ?? postBySeq(state, asked.seq)?.topic;
  const others = input.to === undefined || input.to === null ? [] : Array.isArray(input.to) ? input.to : [input.to];
  const to = asked.from && readsPosts(state, memberName(state, asked.from)) ? [...others, memberName(state, asked.from)] : others;
  const posted = postToBoard(state, sender, { text: input.text, to, topic }, now, { answers: asked.seq });
  resolvePosts(state, sender, { seq: asked.seq, see: posted.seq }, now);
  settled(state, [asked], sender, { answer: posted.seq, text: scriptText(input.text, 'post', 4000) }, now);
  return { ...posted, answers: asked.seq };
}

/**
 * The resolve_post operation: marks posts resolved or reopens them. Whoever asked is told when another closes its
 * ask, and whoever owes the answer when an ask is reopened: it was shown the ask as settled.
 */
export function resolvePost(state: WorkflowView, by: Asker, input: { seq?: unknown; note?: unknown; see?: unknown; reopen?: unknown }, now: number): unknown {
  const before = [...open(state)];
  const result = resolvePosts(state, by, input, now);
  const closed = before.filter(item => result.resolved?.includes(item.seq));
  if (closed.length) {
    settled(state, closed, by, { ...(typeof input.note === 'string' ? { note: input.note } : {}), ...(typeof input.see === 'number' ? { see: input.see } : {}) }, now);
  }
  const me = 'agentId' in by ? by.agentId : undefined;
  for (const asked of open(state).filter(item => result.reopened?.includes(item.seq))) {
    if (asked.to === me) continue;
    if (asked.to === undefined) { askMain(state, asked, now); continue; }
    const to = memberName(state, asked.to);
    if (!readsPosts(state, to)) continue;
    try {
      postToBoard(state, { author: 'system' }, { to: [to], text: `Ask ${asked.seq} from ${asked.from ? memberName(state, asked.from) : 'the main agent'} was reopened`
        + `${asked.from === me ? '' : ` by ${me ? memberName(state, me) : 'the main agent'}`}: it needs an answer again (post_board({answers: ${asked.seq}, text})). "${asked.excerpt}"` }, now, { literal: true });
    } catch { /* The ask is in what the member is shown at its next turn. */ }
  }
  return result;
}

/**
 * What follows when asks are closed: the notices that told the main agent of them settle once none of the asks they
 * name is open, and whoever asked learns how it ended unless the answer was posted to it or it closed the ask itself.
 */
function settled(state: WorkflowView, asks: ReadonlyArray<Immutable<OpenAsk>>, by: Asker, how: { answer?: number; text?: string; note?: string; see?: number }, now: number): void {
  const me = 'agentId' in by ? by.agentId : undefined;
  const who = me === undefined ? 'the main agent' : memberName(state, me);
  for (const asked of asks) {
    if (asked.from === me) continue;
    const to = asked.to ? memberName(state, asked.to) : 'main';
    if (asked.from === undefined) {
      pushEvent(state, { kind: 'worker_reply', summary: how.answer !== undefined ? `${who} 答复了你的第 ${asked.seq} 帖请求（全文是第 ${how.answer} 帖，read_board 可读）：${how.text!.slice(0, 500)}`
        : `${who} 结掉了你给 ${to} 的第 ${asked.seq} 帖请求${how.note ? '：' + how.note : ''}${how.see ? `（见第 ${how.see} 帖）` : ''}` }, () => now);
    } else if (how.answer === undefined && readsPosts(state, memberName(state, asked.from))) {
      // The board may be unable to take another post; the resolution is on the ask itself.
      try {
        postToBoard(state, { author: 'system' }, { to: [memberName(state, asked.from)], text: `Your ask ${asked.seq} to ${to} was resolved by ${who} without an answer of its own`
          + `${how.note ? ': ' + how.note : '.'}${how.see ? ` See post ${how.see}.` : ''}` }, now, { literal: true });
      } catch {}
    }
  }
  const still = new Set(open(state).map(item => item.seq));
  acknowledge(state, state.events.filter(event => event.asks && !event.asks.some(seq => still.has(seq))), now);
}

/** How the one asked stands, for those who decide what to do about its silence. */
function standing(state: WorkflowView, agentId: string): 'stopped' | 'busy' | 'idle' {
  const agent = state.agents?.find(item => item.agentId === agentId);
  if (!agent || !readsPosts(state, agent.key)) return 'stopped';
  return BUSY.has(taskById(state, agent.activeTurnId)?.status ?? 'failed') ? 'busy' : 'idle';
}

/**
 * Who is told next that an ask is unanswered, in order: the members above the one asked, the nearest first, then the
 * main agent. An asker that is itself one of them can see to it, so it alone is told.
 */
function above(state: WorkflowView, asked: Immutable<OpenAsk>): string[] {
  const asker = asked.from ?? 'main';
  // A lead that has not had its first turn has no inbox yet: it is passed over.
  const leads = leadsAbove(state, memberName(state, asked.to!)).flatMap(name => state.agents?.find(agent => agent.key === name)?.agentId ?? []);
  const levels = [...leads, 'main'];
  return (levels.includes(asker) ? [asker] : levels).filter(level => level === 'main' || readsPosts(state, memberName(state, level)));
}

/**
 * Tells those above the one asked of the asks that have stayed open past the time their authors gave. Each level has
 * that long again before the next is told, and each is told once: an ask does not nag, it moves up. The asks told to
 * one reader in a pass go in one post or notice. Called on every scheduling pass.
 */
export function pumpAsks(state: WorkflowView, now: number): void {
  if (state.status !== 'active' || state.script?.status !== 'running' || !open(state).length) return;
  const due = new Map<string, Array<Immutable<OpenAsk>>>();
  for (const asked of open(state)) {
    // The main agent has nobody above it in the workflow: what it is asked stands in its notices until it answers.
    if (asked.to === undefined || now - (asked.toldAt ?? asked.at) < asked.within) continue;
    const next = above(state, asked).find(level => !asked.told?.includes(level));
    if (next === undefined || next === 'main' && asked.from !== undefined && now - asked.at < ASK_MAIN_AFTER_MS) continue;
    due.set(next, [...due.get(next) ?? [], asked]);
  }
  for (const [reader, asks] of due) {
    const seqs = asks.map(asked => asked.seq);
    const quoted = asks.slice(0, reader === 'main' ? NOTICE_ASKS : REMINDER_ASKS);
    const more = asks.length - quoted.length;
    if (reader === 'main') {
      const how = { stopped: '已停止', busy: '在回合中', idle: '不在回合中' };
      pushEvent(state, { kind: 'ask_open', asks: seqs, summary: `${asks.length} 条请求超时未答复（可以自己答：post_board 的 answers；用 tell_worker 催被问的成员；或 resolve_post 结掉不再需要的；都答复或结掉后本通知自结）：`
        + quoted.map(asked => { const view = askView(state, asked, now); return `第 ${view.seq} 帖，${view.from === 'main' ? '你' : view.from} 问 ${view.to}，已 ${minutes(now - asked.at)} 分钟，${view.to} ${how[standing(state, asked.to!)]}：「${view.text.slice(0, 80)}」`; }).join('；')
        + (more ? `；另有 ${more} 条见 status 的 asks` : '') }, () => now);
      continue;
    }
    const how = { stopped: 'has stopped', busy: 'is in a turn', idle: 'is between turns' };
    const line = (asked: Immutable<OpenAsk>) => { const view = askView(state, asked, now); return `- ask ${view.seq} ${asked.from === reader ? '' : `from ${view.from} `}to ${view.to}, ${minutes(now - asked.at)} minutes old (${view.to} ${how[standing(state, asked.to!)]}): "${view.text}"`; };
    const mine = asks.every(asked => asked.from === reader);
    try {
      postToBoard(state, { author: 'system' }, { to: [memberName(state, reader)], text: `${asks.length > 1 ? 'These asks have' : 'This ask has'} had no answer in the time ${mine ? 'you' : asks.length > 1 ? 'their authors' : 'its author'} gave:\n`
        + quoted.map(line).join('\n') + (more ? `\n- and ${more} more (read_board shows them)` : '') + '\n'
        + (mine ? 'Reach the one asked in its turn with tell_worker where you may, ask someone else, or close an ask you no longer wait on with resolve_post({seq, note}).'
          : 'You stand above the one asked: answer in its place with post_board({answers: seq, text}), have it answer (tell_worker reaches a member in its turn), or close an ask that needs no answer with resolve_post({seq, note}).') },
      now, { literal: true, overdue: seqs });
    } catch { /* A board that cannot take the reminder leaves the ask as it is, to be tried at the next pass. */ }
  }
}

/** The open asks as the main agent's status shows them, the oldest first. */
export function openAsks(state: WorkflowView, now: number): unknown[] {
  return open(state).map(asked => { const { text, ...view } = askView(state, asked, now); return { ...view, text: text.slice(0, 80) }; });
}
