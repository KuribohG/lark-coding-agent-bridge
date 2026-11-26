import { askSituations, openAsksOf } from './asks';
import { boardNews } from './board';
import { workflowDigest } from './digest';
import { availableMessages, checkpoint, receiveMessages, scheduleMemberTurn } from './durable-agents';
import type { DomainEvent } from './events';
import { callCount, readArtifact, taskById } from './kernel-state';
import { emit, readText } from './kernel-store';
import { openingPrompt, turnBrief, type BriefFacts } from './swarm-brief';
import { answersFor, chainAbove, coordinates, leadsAbove, MEMBER_BUSY, plannedBy, plansQueue, queueLead, quoted, takesTurns, turnCount, type ItemView, type MemberView, type SwarmView } from './swarm';
import { clearTodos, deferredOf, holderOf, openTodos, reconcileTodos, type Situation, todosOf, todoView, toldSince } from './todos';
import { answersShown } from './turn-mail';
import { availableWork, deadDependency, itemsByKey, keptFor, queueStanding, submittedWork, unfinishedWork, waitsOn, workFlow, workItem } from './work-queue';
import { queueControl } from './work-routing';
import type { Immutable, NativeIdKind, WorkflowSwarm, WorkflowTodo, WorkflowView } from './types';

/**
 * When the members of a swarm are woken, and what waits on whom.
 *
 * A member is woken for three things: something waits on it (a to-do it has not been shown, a message that was sent
 * to it, its own wake-up); its queue has work it can claim; or it is a lead and results have gathered. Nothing else
 * wakes anyone: a note on the board is read when its reader next has a turn.
 *
 * What waits on whom is not kept as it happens. Each pass works out the situations that hold (`situations`), from
 * functions that only read the state, and the to-do table is brought in step with them (todos.ts).
 */

const BUSY = MEMBER_BUSY;
const MIN = 60_000;
/** Failed turns the engine retries in the member's own session before the member stops and someone has to revive it. */
const AUTO_REVIVES = 1;
/**
 * While other members are working, the results a lead is owed are gathered and it is woken for them at most once per
 * this gap after its last turn: half a minute per member, ten minutes at most. A lead is otherwise woken per result,
 * and in a large swarm that is one turn of the most expensive member for every item.
 */
const LEAD_GAP_PER_MEMBER_MS = 30_000;
const LEAD_GAP_MAX_MS = 10 * MIN;
/** The results one turn of a lead is handed; what is left over waits for its next turn, which it also wakes. */
const RESULTS_PER_TURN = 48;
/**
 * A queue is dry when this share of its members, one at least, is idle while it has nothing to claim. Work in a large
 * swarm is done faster than a lead that is woken every few minutes hands it out, and the counts of a status read the
 * same whether the pending items can be claimed or wait on something.
 */
const DRY_SHARE = 0.25;
/** A dependency that was cancelled or failed is reported once it has stayed so this long: whoever ended it may be about to replace it. */
const DEAD_AFTER_MS = 10 * MIN;
/** An item set aside, and a gate nobody has declared met, come back to whoever answers for them after this long. */
const ASIDE_REVIEW_MS = 60 * MIN;
const GATE_REVIEW_MS = 60 * MIN;
/** Claims in a row that left neither progress nor a failure before an item is said to go round without moving. */
const SPIN_CLAIMS = 3;
/** Items a to-do that covers several names; it counts the rest. */
const ITEMS_SHOWN = 6;

type Offer = { slots: number; kept: Map<string, ItemView[]>; wake(member: MemberView): string };

/** How one running swarm stands in this pass: who is in a turn, and what each queue has to offer. Reads only. */
interface Survey {
  swarm: SwarmView;
  queues: string[];
  work: Map<string, Offer>;
  busy(member: MemberView): boolean;
  unread(member: MemberView): boolean;
  turnsLeft(member: MemberView): boolean;
  hasWork(member: MemberView): boolean;
  /** Whether a member that does the work is at it, or can be woken for something. */
  stirring(member: MemberView): boolean;
}

function survey(state: WorkflowView, swarm: SwarmView, now: number): Survey {
  const busy = (member: MemberView) => { const task = taskById(state, member.taskId); return Boolean(task && BUSY.has(task.status)); };
  // Looked up for every member on every pass, so indexed once rather than searched.
  const agents = new Map((state.agents ?? []).map(agent => [agent.key, agent]));
  const unread = (member: MemberView) => { const agent = agents.get(member.name); return Boolean(agent && availableMessages(state, agent.agentId).length); };
  // A lead plans for as long as the swarm runs, so maxTurns bounds the other members only.
  const turnsLeft = (member: MemberView) => coordinates(swarm, member) || member.turns < swarm.maxTurns;
  // Work a queue member could claim now, less the turns already running that have not claimed yet.
  const queues = [...new Set(swarm.members.flatMap(member => member.queue && !member.stopped ? [member.queue] : []))];
  const claiming = new Set(queues.length ? (state.workQueue?.claims ?? []).flatMap(claim => claim.status === 'active' && !claim.landing ? [claim.taskId] : []) : []);
  const work = new Map(queues.map(name => {
    const available = availableWork(state, name);
    // An item that is for one member is that member's to claim while it can be woken; the others are not woken for it.
    const kept = new Map<string, ItemView[]>();
    const holders = available.map(item => keptFor(state, item));
    holders.forEach((to, index) => { if (to) kept.set(to, [...kept.get(to) ?? [], available[index]!]); });
    // A turn that has not claimed yet will take an item of its own before one that is open to all.
    const unclaimed = (state.swarms ?? []).flatMap(other => other.members).filter(member => member.queue === name && !kept.has(member.name))
      .map(member => taskById(state, member.taskId)).filter(task => task && BUSY.has(task.status) && !task.consumerMessageTurn
        && !claiming.has(task.taskId)).length;
    const digests = new Map<string, string>();
    const offer: Offer = { slots: available.length - holders.filter(Boolean).length - unclaimed, kept,
      // Identifies the claimable set a member was last woken for, an amended item being a new one to it; only computed when a member is idle with work to offer.
      // Members that nothing is kept for share one set, which is every claimable item while none is kept for anyone.
      wake(member: MemberView) {
        const own = kept.has(member.name) ? member.name : '';
        let digest = digests.get(own);
        if (digest === undefined) digests.set(own, digest = workflowDigest(available.filter((_, index) => !holders[index] || holders[index] === own).map(item => ({ id: item.id, generation: item.generation, revision: item.revision ?? 0 }))));
        return digest;
      } };
    return [name, offer] as const;
  }));
  const hasWork = (member: MemberView) => {
    const found = member.queue ? work.get(member.queue) : undefined;
    return Boolean(found && (found.slots > 0 || found.kept.has(member.name)) && member.lastWake !== found.wake(member));
  };
  const stirring = (member: MemberView) => !member.stopped && (busy(member) || Boolean(member.retryPending)
    || turnsLeft(member) && (member.wakeAt !== undefined || unread(member) || hasWork(member) || toldSince(state, member.name, member.briefedAt ?? 0, now)));
  return { swarm, queues, work, busy, unread, turnsLeft, hasWork, stirring };
}

/** The swarms of the current run that are running. */
const running = (state: WorkflowView) => state.status === 'active' && state.script?.status === 'running'
  ? (state.swarms ?? []).filter(swarm => swarm.runId === state.script!.runId && swarm.status === 'running') : [];

/** Schedules the turns of every running swarm, keeps the to-dos in step and settles the swarms with nothing left to do. Returns whether anything changed. */
export function pumpSwarms(state: WorkflowView, nativeIdKind: (agentKind: string) => NativeIdKind, now: number, additionalTurnsAllowed = Infinity): boolean {
  if (state.status !== 'active') return false;
  // A script that has ended leaves nothing for anyone to see to. One that is paused or about to run again keeps its
  // to-dos, with who was told of them and when.
  if (state.script?.status !== 'running') return state.script !== undefined && ['result_ready', 'failed'].includes(state.script.status) && clearTodos(state, now);
  let changed = false;
  const surveys: Survey[] = [];
  for (const swarm of running(state)) {
    try {
      changed = settleTurns(state, swarm, now) || changed;
      let found = survey(state, swarm, now);
      if (passUp(state, found, now)) { changed = true; found = survey(state, swarm, now); }
      surveys.push(found);
    } catch (error) {
      emit(state, { type: 'swarm_ended', swarmId: swarm.id, stop: 'failed', reason: error instanceof Error ? error.message : String(error) });
      changed = true;
    }
  }
  let holds = situations(state, surveys, now);
  // How each member stands for what is put in front of it: a to-do does not go up over a member that has not had a
  // turn with it, or is in one.
  const standing = new Map(surveys.flatMap(found => found.swarm.members.map(member => [member.name, { busy: found.busy(member), briefedAt: member.briefedAt ?? 0 }] as const)));
  if (reconcileTodos(state, [...holds.values()], now, who => takesTurns(state, who), who => standing.get(who))) {
    changed = true;
    // What a situation says depends on who holds its to-do, which has just changed: the turns scheduled below are
    // briefed with how it reads now.
    holds = situations(state, surveys, now);
  }
  for (const found of surveys) {
    const before = found.swarm.turns.length;
    changed = schedule(state, found, holds, nativeIdKind, now, additionalTurnsAllowed) || changed;
    additionalTurnsAllowed -= found.swarm.turns.length - before;
  }
  return changed;
}

/** What the session a member had left for the one that takes over: the note its last finished turn ended with, and whether it saved a checkpoint. */
function leftBehind(state: WorkflowView, agent: NonNullable<WorkflowView['agents']>[number]): NonNullable<BriefFacts['left']> {
  const saved = checkpoint(state, agent);
  let note: string | undefined;
  // The result may have left the state with the turn it belongs to; the new session then starts without it.
  try { note = saved?.resultRef ? readArtifact(state, saved.resultRef).text.trim() || undefined : undefined; } catch { note = undefined; }
  return { ...(note ? { note } : {}), checkpoint: saved?.state !== null && saved?.state !== undefined };
}

/**
 * A turn that ended without a result during this run is a failure; turns cut short by a pause are retried instead. A
 * failed turn runs once more in the member's session, as staff_swarm's revive would have it, before the member stops:
 * nobody watches a large swarm closely enough to revive each member that hit a passing fault. That a member has
 * stopped is a situation (`member`), which whoever can replace it answers for.
 */
function settleTurns(state: WorkflowView, swarm: SwarmView, _now: number): boolean {
  let changed = false;
  for (const member of swarm.members) {
    const task = taskById(state, member.taskId);
    if (member.stopped || member.retryPending || !task || BUSY.has(task.status) || task.status === 'result_ready') continue;
    changed = true;
    if (task.status === 'failed' && !swarm.finish && (member.autoRevived ?? 0) < AUTO_REVIVES) {
      emit(state, { type: 'task_requeued', taskId: task.taskId, runId: state.script!.runId });
      emit(state, { type: 'swarm_member_revived', swarmId: swarm.id, member: member.name, auto: true });
      continue;
    }
    emit(state, { type: 'swarm_member_stopped', swarmId: swarm.id, member: member.name, reason: 'failed', detail: (task.error ?? `turn is ${task.status}`).slice(0, 500) });
  }
  return changed;
}

/**
 * A member that was woken for an item kept for it and ended that turn without taking it has passed it up: the item
 * returns to the whole queue instead of waiting for a member that will not be woken for the same work twice.
 */
function passUp(state: WorkflowView, { swarm, work, busy }: Survey, now: number): boolean {
  const passed = swarm.members.flatMap(member => {
    const found = member.queue && !busy(member) && !member.retryPending && member.lastWake !== undefined ? work.get(member.queue) : undefined;
    return found?.kept.has(member.name) && member.lastWake === found.wake(member) ? found.kept.get(member.name)! : [];
  });
  for (const item of passed) emit(state, { type: 'work_updated', itemId: item.id, assignee: null, at: now });
  return passed.length > 0;
}

/** Why the pending items of a queue that has nothing to claim are not handed out, for whoever is told that it is dry. */
function blockedFacts(standing: ReturnType<typeof queueStanding>): { en: string; zh: string } | undefined {
  const { blocked, onHold, heldReady, stuck, gates } = standing;
  if (!blocked && !gates) return undefined;
  const en = [...(onHold ? [`${onHold} set aside` + (heldReady ? `, ${heldReady} of them with nothing else in the way` : '')] : []),
    ...(stuck ? [`${stuck} waiting on an item that was cancelled or failed`] : []), ...(gates ? [`${gates} gates not settled`] : [])];
  const zh = [...(onHold ? [`${onHold} 项被搁置` + (heldReady ? `，其中 ${heldReady} 项除搁置外已无阻碍` : '')] : []),
    ...(stuck ? [`${stuck} 项等的依赖已撤销或失败`] : []), ...(gates ? [`${gates} 个条件项未达成`] : [])];
  return { en: `${blocked} pending items cannot be claimed` + (en.length ? ': ' + en.join('; ') + '; the rest wait' : ': they wait') + ' on other items, resources or attempts, or are kept for one member',
    zh: `${blocked} 项待领但领不了` + (zh.length ? '：' + zh.join('；') + '；其余' : '：') + '在等其他工作项、资源、尝试次数，或指定给了某个成员' };
}

/** Who answers for something that `name` answers for first: that member, those above it, then the main agent. */
const chainOf = (state: WorkflowView, name: string | undefined) => name === undefined || name === 'main' ? ['main'] : [name, ...leadsAbove(state, name), 'main'];

const more = (count: number) => count > ITEMS_SHOWN ? `, and ${count - ITEMS_SHOWN} more (work_status lists them)` : '';
const moreZh = (count: number) => count > ITEMS_SHOWN ? ` 等 ${count} 项` : '';
const plural = (count: number, one: string, many = one + 's') => `${count} ${count === 1 ? one : many}`;
const brief = (text: string | undefined, max = 120) => (text ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * The situations that hold now, by subject. Each of the functions below answers one question from the state as it
 * is: which situations of its kind hold, and who answers for each. None keeps anything; who was told, when it goes
 * up and when it is over is the same for all of them (todos.ts).
 */
function situations(state: WorkflowView, surveys: readonly Survey[], now: number): Map<string, Situation> {
  const found: Array<Situation & { swarm?: string }> = [...askSituations(state, now)];
  for (const each of surveys) found.push(...dry(state, each), ...stopped(each), ...unstaffed(state, each));
  found.push(...waits(state, surveys, now));
  // A swarm that has gone idle is told to its lead only when nobody else is on the hook for something in it.
  const table = new Map((state.todos?.open ?? []).map(todo => [todo.subject, todo]));
  for (const each of surveys) {
    const hooked = found.some(situation => situation.swarm === each.swarm.id && situation.kind !== 'ask' && !table.get(situation.subject)?.deferred);
    found.push(...idle(state, each, hooked, table));
  }
  return new Map(found.map(({ swarm: _swarm, ...situation }) => [situation.subject, situation]));
}

/** The situations as they stand, outside a scheduling pass: for what a member reads of its own to-dos, and for the status. */
function currentSituations(state: WorkflowView, now: number): Map<string, Situation> {
  return situations(state, running(state).map(swarm => survey(state, swarm, now)), now);
}

/**
 * A queue whose members have run out of work while it has nothing they can claim. Its lead decides: add what the goal
 * still lacks, or say that there is nothing for now. A swarm without a lead is fed by its script, which is not told.
 */
function dry(state: WorkflowView, { swarm, queues, work, busy, turnsLeft }: Survey): Array<Situation & { swarm: string }> {
  if (swarm.finish || !swarm.lead) return [];
  return queues.flatMap(name => {
    const answers = answersFor(swarm, name);
    const consumers = swarm.members.filter(member => member.queue === name && !member.stopped && turnsLeft(member));
    const idle = consumers.filter(member => !busy(member)).length;
    if (!answers || answers.stopped || (work.get(name)?.slots ?? 1) > 0 || idle < Math.max(1, Math.ceil(consumers.length * DRY_SHARE))) return [];
    const blocked = blockedFacts(queueStanding(state, name));
    return [{ swarm: swarm.id, subject: `dry:${swarm.id}:${name}`, kind: 'dry' as const, chain: chainOf(state, answers.name),
      en: `Queue "${name}" has run dry: ${idle} of its ${consumers.length} members are idle and it has no item they can claim${blocked ? ` (${blocked.en})` : ''}.`,
      act: 'ask what the goal still lacks that these members could work on, a step you know or a question whose answer would change the plan, and add that with enqueue_work. '
        + 'If there is nothing, do not make any up: defer_todo says that the queue has no work for now'
        + (answers.name === swarm.lead ? ', and staff_swarm({move, queue}) puts its idle members where there is more work than members. When the goal is met or cannot progress, end the swarm with swarm_finish instead.'
          : `; say so in your status, which @${swarm.lead} reads and which can move the members.`),
      zh: `swarm "${swarm.key}" 的队列 ${name} 断粮：${consumers.length} 名成员中 ${idle} 名空闲，没有可领工作项` + (blocked ? `（${blocked.zh}）` : '')
        + '。有推进目标的工作就用 enqueue_work 补充；没有就不必凑：用 staff_swarm 的 move 把成员挪到有活的队列，或用 defer_todo 说明该队列暂无工作。' }];
  });
}

/** A member that failed and has stopped, after the retry the engine gives it. Whoever can replace it answers for it. */
function stopped({ swarm }: Survey): Array<Situation & { swarm: string }> {
  if (swarm.finish) return [];
  const lead = swarm.members.find(member => member.name === swarm.lead && !member.stopped);
  return swarm.members.filter(member => member.stopped === 'failed').map(member => {
    const what = member.name === swarm.lead ? ' (the lead)' : member.leads?.length ? ` (lead of ${quoted(member.leads)})` : member.queue ? ` of queue "${member.queue}"` : '';
    return { swarm: swarm.id, subject: `member:${swarm.id}:${member.name}`, kind: 'member' as const, chain: lead && lead !== member ? [lead.name, 'main'] : ['main'],
      en: `Member "${member.name}"${what} failed and has stopped: ${brief(member.detail, 300)}. An item it had claimed is back in its queue.`,
      act: `staff_swarm({revive: ["${member.name}"]}) lets it retry its last turn in the session it had, replace gives it a new session under its name when the session is what fails, add brings another member, and retire gives it up when the work does not need it.`,
      zh: `swarm "${swarm.key}" 的成员 ${member.name}${member.name === swarm.lead ? '（lead）' : ''} 失败并已停止（已自动重试一次）：${brief(member.detail, 200)}。`
        + 'staff_swarm 的 revive 让它在原会话重试，replace 给它换新会话（原会话本身有问题时），add 补人，retire 表示不再需要它。' };
  });
}

/** A queue that has work to claim and no member left that could be woken for it. Without a lead the swarm ends instead (see `schedule`). */
function unstaffed(state: WorkflowView, { swarm, busy, turnsLeft }: Survey): Array<Situation & { swarm: string }> {
  const lead = swarm.members.find(member => member.name === swarm.lead && !member.stopped);
  if (swarm.finish || !lead) return [];
  const names = [...new Set(swarm.members.flatMap(member => member.queue ? [member.queue] : []))];
  return names.flatMap(name => {
    if (swarm.members.some(member => member.queue === name && !member.stopped && (busy(member) || turnsLeft(member)))) return [];
    const open = availableWork(state, name).length;
    if (!open) return [];
    return [{ swarm: swarm.id, subject: `unstaffed:${swarm.id}:${name}`, kind: 'unstaffed' as const, chain: [lead.name, 'main'],
      en: `Queue "${name}" has ${plural(open, 'item')} to claim and no member left to take ${open > 1 ? 'them' : 'it'}: its members have stopped or used their wake-ups.`,
      act: 'staff_swarm adds members to the queue (add, queue), moves members to it (move), revives failed ones or gives everyone more wake-ups (maxTurns); cancel what is no longer wanted.',
      zh: `swarm "${swarm.key}" 的队列 ${name} 有 ${open} 项可领，但已没有能被唤醒的成员（已停止或唤醒次数用完）。用 staff_swarm 的 add/move 补人、revive 重试失败成员或提高 maxTurns；不再需要的工作项用 update_work 撤销。` }];
  });
}

/**
 * A swarm in which no member has anything to do and nobody is asked to decide anything. With a lead it is the lead's
 * to say whether the goal is met; it does not end by going quiet. Once told, it stands while the lead looks into it.
 */
function idle(state: WorkflowView, { swarm, queues, busy, stirring }: Survey, hooked: boolean, table: ReadonlyMap<string, Immutable<WorkflowTodo>>): Situation[] {
  const lead = swarm.members.find(member => member.name === swarm.lead && !member.stopped);
  if (swarm.finish || !lead || hooked) return [];
  // What members handed to the landing queue is still being worked on, by the queue.
  if (submittedWork(state, queues)) return [];
  const subject = `idle:${swarm.id}`;
  if (swarm.members.some(member => !coordinates(swarm, member) && stirring(member))) return [];
  if (!table.has(subject) && swarm.members.some(member => coordinates(swarm, member) && (busy(member) || !member.taskId))) return [];
  return [{ subject, kind: 'idle', chain: [lead.name, 'main'],
    en: 'Nobody in the swarm has anything to do: every member is idle, nothing can be claimed and nothing waits to be decided.',
    act: 'check the goal against evidence. If it is met or cannot progress, call swarm_finish and say which and what remains. If it is not met, the plan so far did not reach it: '
      + 'find what is missing, what would have to be known and what has not been tried, and hand that out with enqueue_work. To wait for something outside the workflow, defer_todo with minutes and say what you wait for.',
    zh: `swarm "${swarm.key}" 停滞：全体成员空闲，没有可领的工作，也没有待裁决的事，lead 既未分派工作也未调用 swarm_finish。swarm 仍在运行并等待：`
      + '用 ask 让 lead 说明或继续、enqueue_work 补充工作，或 staff_swarm 加人、提高 maxTurns；确认无事可做再取消。' }];
}

/**
 * What keeps pending items from being handed out and will not pass by itself: an item set aside that nothing else
 * holds back, a dependency that will never be completed, a gate nobody has declared met, an item that goes round
 * without moving. Each is whoever planned it's to decide, and one to-do covers all the items of a kind one member
 * answers for, so a plan that left twenty items behind is one line to read and not twenty.
 */
function waits(state: WorkflowView, surveys: readonly Survey[], now: number): Array<Situation & { swarm?: string }> {
  const items = state.workQueue?.items ?? [];
  if (!items.some(item => item.status === 'pending' && (item.hold || item.gate || item.dependsOn?.length) || item.idleClaims)) return [];
  const find = itemsByKey(state);
  const swarms = surveys.map(each => each.swarm);
  const planners = new Map<string, { name: string; swarm?: string }>();
  /** Who answers for an item: the lead that planned it while that lead runs, the main agent otherwise. */
  const planner = (item: ItemView) => {
    const key = `${item.by ?? ''}\n${item.queue ?? 'default'}`;
    let found = planners.get(key);
    if (!found) {
      const queue = item.queue ?? 'default';
      const swarm = swarms.find(each => !each.finish && each.members.some(member => !member.stopped && (member.queue === queue || member.leads?.includes(queue) || member.name === item.by)));
      const to = swarm && plannedBy(swarm, item);
      planners.set(key, found = { name: to && !to.stopped ? to.name : 'main', ...(swarm ? { swarm: swarm.id } : {}) });
    }
    return found;
  };
  // A swarm in which no member that does the work is at it: what its items wait for is all that is left to happen.
  const quiet = new Set(surveys.filter(each => !each.swarm.members.some(member => !coordinates(each.swarm, member) && each.stirring(member))).map(each => each.swarm.id));
  type Group<T> = Map<string, { swarm?: string; entries: Array<T & { at: number }> }>;
  const add = <T>(group: Group<T>, owner: { name: string; swarm?: string }, entry: T & { at: number }) => {
    const list = group.get(owner.name) ?? { ...(owner.swarm ? { swarm: owner.swarm } : {}), entries: [] };
    list.entries.push(entry);
    group.set(owner.name, list);
  };
  const aside: Group<{ item: ItemView }> = new Map();
  const dead: Group<{ item: ItemView; on: string; how: string }> = new Map();
  const spin: Group<{ item: ItemView }> = new Map();
  const waiting = new Map<string, number>();
  for (const item of items) {
    if ((item.idleClaims ?? 0) >= SPIN_CLAIMS && (item.status === 'pending' || item.status === 'claimed')) add(spin, planner(item), { item, at: item.updatedAt });
    if (item.status !== 'pending') continue;
    const open = item.dependsOn?.length ? waitsOn(state, item, find) : [];
    const gone = deadDependency(open);
    if (gone) {
      const dependency = find(gone.key);
      const at = (dependency?.updatedAt ?? item.updatedAt) + DEAD_AFTER_MS;
      if (now >= at) add(dead, planner(item), { item, on: gone.key, how: gone.status + (dependency?.error ? ': ' + brief(dependency.error, 100) : ''), at });
      continue;
    }
    for (const entry of open) if (find(entry.key)?.gate) waiting.set(entry.key, (waiting.get(entry.key) ?? 0) + 1);
    if (item.gate || !item.hold || open.length) continue;
    // Set aside and nothing else in the way: whoever set it aside is asked once what it waited on is done, or it has stayed aside this long.
    const done = Math.max(0, ...(item.dependsOn ?? []).map(key => find(key)?.updatedAt ?? 0).filter(at => at > (item.held?.at ?? Infinity)));
    const at = done || (item.held?.at ?? item.updatedAt) + ASIDE_REVIEW_MS;
    if (now < at) continue;
    const by = item.held?.by;
    const setter = by === 'main' ? { name: 'main', ...(planner(item).swarm ? { swarm: planner(item).swarm } : {}) }
      : by !== undefined && swarms.some(each => each.members.some(member => member.name === by && !member.stopped && coordinates(each, member))) ? { name: by, ...(planner(item).swarm ? { swarm: planner(item).swarm } : {}) } : planner(item);
    add(aside, setter, { item, at });
  }
  const gates: Group<{ item: ItemView; waiters: number }> = new Map();
  for (const [key, waiters] of waiting) {
    const gate = find(key);
    if (!gate || gate.status !== 'pending') continue;
    const owner = planner(gate);
    const at = gate.createdAt + GATE_REVIEW_MS;
    // The time a to-do is counted from must not move from pass to pass: whoever holds it would be told anew each time.
    if (now >= at || owner.swarm !== undefined && quiet.has(owner.swarm)) add(gates, owner, { item: gate, waiters, at: now >= at ? at : gate.createdAt });
  }
  const found: Array<Situation & { swarm?: string }> = [];
  const push = <T>(kind: Situation['kind'], group: Group<T>, text: (entries: Array<T & { at: number }>) => Pick<Situation, 'en' | 'act' | 'zh'>) => {
    for (const [owner, { swarm, entries }] of group) {
      found.push({ ...(swarm ? { swarm } : {}), subject: `${kind}:${owner}`, kind, chain: chainOf(state, owner),
        since: Math.min(...entries.map(entry => entry.at)), fresh: Math.max(...entries.map(entry => entry.at)), ...text(entries) });
    }
  };
  const who = (by: string | undefined) => by === undefined ? '' : by === 'main' ? ' by the main agent' : ` by ${by}`;
  push('aside', aside, entries => ({
    en: `${plural(entries.length, 'item')} set aside ${entries.length > 1 ? 'have' : 'has'} nothing else in the way, and only the hold keeps ${entries.length > 1 ? 'them' : 'it'} from being handed out: `
      + entries.slice(0, ITEMS_SHOWN).map(({ item }) => `"${item.key}" (queue ${item.queue ?? 'default'}, set aside${who(item.held?.by)}${item.held?.by === undefined ? '' : ` ${Math.round((now - item.held.at) / MIN)} min ago`}: ${brief(item.held?.reason) || 'no reason recorded'})`).join('; ') + more(entries.length) + '.',
    act: 'decide each: update_work({key, hold: false}) returns it to the queue; cancel: true or supersededBy withdraws what is no longer wanted. '
      + 'An item that still waits for something names that in dependsOn (an item, or a gate) and has its hold lifted. What the main agent set aside is returned by you only when its reason is plainly over. defer_todo keeps them aside for now.',
    zh: `${entries.length} 个被搁置的工作项除搁置外已无阻碍：${entries.slice(0, ITEMS_SHOWN).map(({ item }) => `"${item.key}"（${brief(item.held?.reason, 60) || '未记原因'}）`).join('、')}${moreZh(entries.length)}。`
      + '逐项处理：update_work 的 hold:false 放回队列，cancel 或 supersededBy 撤销；还要等别的事就写进 dependsOn（工作项或条件项）再解除搁置；继续搁置用 defer_todo 说明。',
  }));
  push('dead', dead, entries => ({
    en: `${plural(entries.length, 'item')} wait${entries.length > 1 ? '' : 's'} on an item that was cancelled or has failed for good, and will not be handed out as things stand: `
      + entries.slice(0, ITEMS_SHOWN).map(({ item, on, how }) => `"${item.key}" (queue ${item.queue ?? 'default'}) waits on "${on}" (${how})`).join('; ') + more(entries.length) + '.',
    act: 'for each, one of: update_work({key: <the dependency>, supersededBy: <the item that took its place>}) moves everything that waited on it (enqueue_work with supersedes adds the replacement and does the same); '
      + 'retry_work gives a failed dependency more attempts; update_work({key, dependsOn}) changes what the item waits on; update_work({key, cancel: true, reason}) withdraws it.',
    zh: `${entries.length} 个工作项等的依赖已撤销或最终失败，照现在的样子不会被领取：${entries.slice(0, ITEMS_SHOWN).map(({ item, on }) => `"${item.key}" 等 "${on}"`).join('、')}${moreZh(entries.length)}。`
      + '逐项处理：update_work 给依赖写 supersededBy（等它的项改等替代项），retry_work 重试失败的依赖，update_work 改该项的 dependsOn，或撤销该项。',
  }));
  push('gate', gates, entries => ({
    en: `${plural(entries.length, 'gate')} nobody has declared met keep${entries.length > 1 ? '' : 's'} work from being handed out: `
      + entries.slice(0, ITEMS_SHOWN).map(({ item, waiters }) => `"${item.key}" (${plural(waiters, 'item')} wait${waiters > 1 ? '' : 's'}, added ${Math.round((now - item.createdAt) / MIN)} min ago: ${brief(item.title, 80)})`).join('; ') + more(entries.length) + '.',
    act: 'settle_work({key, result}) declares a gate met once what it stands for has happened, and what waits on it is handed out; update_work({key, cancel: true, reason}) withdraws one that will not be met, after which what waited on it needs a new dependsOn. '
      + 'If it is still to come, defer_todo with minutes.',
    zh: `${entries.length} 个条件项尚未宣布达成，挡着后面的工作：${entries.slice(0, ITEMS_SHOWN).map(({ item, waiters }) => `"${item.key}"（${waiters} 项在等）`).join('、')}${moreZh(entries.length)}。`
      + '条件已达成就用 settle_work({key,result}) 宣布，等它的项随即放行；不会达成就用 update_work 撤销它并给等它的项改 dependsOn；还要等就用 defer_todo 写明分钟数。',
  }));
  push('spin', spin, entries => ({
    en: `${plural(entries.length, 'item')} keep${entries.length > 1 ? '' : 's'} coming back without moving: `
      + entries.slice(0, ITEMS_SHOWN).map(({ item }) => `"${item.key}" (queue ${item.queue ?? 'default'}) was taken ${item.idleClaims} times in a row and came back each time with no progress saved and no failure reported${item.error ? ` (last: ${brief(item.error, 100)})` : ''}`).join('; ') + more(entries.length) + '.',
    act: 'read why with work_status({key}), then make the item one that can be done: amend it (update_work with title, input), split it, name what it waits for in dependsOn, give it to one member (assignee) or cancel it.',
    zh: `${entries.length} 个工作项被反复领取又原样交回，没有进展也没有报告失败：${entries.slice(0, ITEMS_SHOWN).map(({ item }) => `"${item.key}"（连续 ${item.idleClaims} 次）`).join('、')}${moreZh(entries.length)}。`
      + '用 work_status 看原因，然后修订（update_work 改 title/input）、拆分、写明 dependsOn、指定成员或撤销。',
  }));
  return found;
}

/** The gates nobody has declared met that an unfinished item of these queues waits on. */
function openGates(state: WorkflowView, queues: readonly string[]): boolean {
  const find = itemsByKey(state);
  return (state.workQueue?.items ?? []).some(item => item.status === 'pending' && queues.includes(item.queue ?? 'default')
    && item.dependsOn?.some(key => { const other = find(key); return other?.gate && other.status === 'pending'; }));
}

/** Wakes the members of one swarm that have something to do, and ends the swarm when nothing is left to wait for. */
function schedule(state: WorkflowView, found: Survey, holds: ReadonlyMap<string, Situation>, nativeIdKind: (agentKind: string) => NativeIdKind, now: number, additionalTurnsAllowed: number): boolean {
  const { swarm, queues, work, busy, unread, turnsLeft, hasWork } = found;
  if (swarm.status !== 'running') return false;
  let changed = false;
  const record = (event: DomainEvent) => { emit(state, event); changed = true; };
  const end = (stop: NonNullable<WorkflowSwarm['stop']>, reason?: string) => record({ type: 'swarm_ended', swarmId: swarm.id, stop, ...(reason ? { reason } : {}) });
  const taskOf = (member: MemberView) => taskById(state, member.taskId);
  const agents = new Map((state.agents ?? []).map(agent => [agent.key, agent]));
  try {
    const lead = swarm.members.find(member => member.name === swarm.lead);
    // The outcomes each lead is owed, by whoever plans the item now. One that has nobody to go to (its lead settled the
    // item itself, or has stopped), or whose item is back in the queue, is dropped: the item still holds it.
    const owed = new Map<string, Array<{ item: ItemView; worker: string }>>();
    const dropped: string[] = [];
    // The same few leads plan every item, so each is looked up once.
    const planners = new Map<string, MemberView | undefined>();
    // An item that failed, was retried and settled again is owed once, as it stands now.
    const seen = new Set<string>();
    for (const entry of swarm.results ?? []) {
      if (seen.has(entry.item)) continue;
      seen.add(entry.item);
      const item = workItem(state, entry.item);
      const settled = item && (item.status === 'completed' || item.status === 'failed') ? item : undefined;
      const planner = settled && `${settled.by ?? ''}\n${settled.queue ?? 'default'}`;
      if (planner !== undefined && !planners.has(planner)) planners.set(planner, plannedBy(swarm, settled!));
      const to = planner === undefined ? undefined : planners.get(planner);
      if (!settled || !to || to.stopped || to.name === entry.worker) { dropped.push(entry.item); continue; }
      const list = owed.get(to.name);
      if (list) list.push({ item: settled, worker: entry.worker }); else owed.set(to.name, [{ item: settled, worker: entry.worker }]);
    }
    if (dropped.length) record({ type: 'swarm_results_seen', swarmId: swarm.id, items: dropped });
    const live = swarm.members.filter(member => !member.stopped);
    // A lead gathers for the members that work under it: the swarm's lead for every member.
    const gap = (member: MemberView) => Math.min(LEAD_GAP_MAX_MS, LEAD_GAP_PER_MEMBER_MS
      * (member.name === swarm.lead ? live.length : Math.max(1, live.filter(other => chainAbove(swarm, other).includes(member)).length)));
    // With nobody else working there is nothing to gather for, and the lead is handed what came back at once.
    const results = (member: MemberView) => owed.has(member.name) && (now - (taskOf(member)?.attempts.at(-1)?.endedAt ?? 0) >= gap(member) || !swarm.members.some(other => other !== member && busy(other)));
    // A wake-up the member set for itself is due.
    const due = (member: MemberView) => member.wakeAt !== undefined && member.wakeAt <= now;
    const told = (member: MemberView) => toldSince(state, member.name, member.briefedAt ?? 0, now);
    // Once the lead has finished the swarm, the turns still running end it; nobody is woken again.
    const wakeable = (member: MemberView) => !member.stopped && !busy(member) && !swarm.finish
      && (member.retryPending || (member.taskId ? turnsLeft(member) && (due(member) || unread(member) || told(member) || hasWork(member) || results(member))
        // A lead starts by planning, and a member of a swarm without one that consumes no queue with the task itself;
        // a member that consumes a queue starts with its first claimable item. A new session of a member that had
        // turns starts the same way, and for what waits on the member besides: its messages, a wake-up, results.
        : (!member.takeover || turnsLeft(member)) && (coordinates(swarm, member) || !member.queue || hasWork(member) || told(member)
          || Boolean(member.takeover) && (due(member) || unread(member) || results(member)))));
    if (!swarm.members.some(busy) && !swarm.members.some(wakeable)) {
      if (lead?.stopped === 'failed') { end('failed', 'The lead failed: ' + (lead.detail ?? '')); return changed; }
      if (swarm.finish) { end('finished'); return changed; }
      // A member waiting for its own wake-up has work in flight, so the swarm is neither idle nor done.
      if (swarm.members.some(member => !member.stopped && member.wakeAt !== undefined && turnsLeft(member))) return changed;
      // So has the landing queue with what members handed to it: its answer completes an item or brings it back.
      if (submittedWork(state, queues)) return changed;
      // Idle members are not a verdict: a swarm with a lead ends only when the lead finishes it. What it waits for
      // now is someone's to-do (`idle`, or whatever else is open), which goes up while it stays open.
      if (lead) return changed;
      if (queues.some(name => availableWork(state, name).length)) {
        end('failed', 'No member can take the available work: its consumers have stopped or used their wake-ups; inspect member failures and explicitly replay');
      } else if (queues.some(name => queueControl(state, name)?.closedAt === undefined)) {
        // Without a lead, an open queue means producers may still add work: keep waiting.
      } else if (queues.some(name => unfinishedWork(state, name) || state.workQueue?.items.some(item => (item.queue ?? 'default') === name && item.status === 'failed'))) {
        // Work that waits for a gate nobody has declared met is waiting, not unclaimable: the swarm stays, and the
        // gate is the main agent's to-do.
        if (!openGates(state, queues)) end('failed', 'Swarm went idle with failed or unclaimable work items; inspect /workflow work, retry them, then explicitly replay');
      } else {
        const active = swarm.members.filter(member => !member.stopped || member.stopped === 'failed');
        end(active.some(member => member.stopped === 'failed') ? 'failed' : active.some(member => member.turns >= swarm.maxTurns && unread(member)) ? 'max_turns' : 'quiet');
      }
      return changed;
    }
    /** How the queues a lead answers for stand: what can be claimed against the members with nothing to do. */
    const standing = (member: MemberView) => !coordinates(swarm, member) ? undefined : queues.filter(name => plansQueue(swarm, member, name)).map(name => {
      const consumers = swarm.members.filter(other => other.queue === name && !other.stopped);
      const own = queueLead(swarm, name) === member ? undefined : queueLead(swarm, name);
      const { slots, kept } = work.get(name)!;
      const held = [...kept.values()].reduce((total, items) => total + items.length, 0);
      const { heldReady, stuck, gates } = queueStanding(state, name);
      return `"${name}" ${Math.max(0, slots) + held} claimable${held ? ` (${held} kept for ${held > 1 ? 'their assignees' : 'its assignee'})` : ''}, `
        + (heldReady ? `${heldReady} set aside with nothing else in the way, ` : '') + (stuck ? `${stuck} waiting on a cancelled or failed item, ` : '') + (gates ? `${gates} gates open, ` : '')
        + `${consumers.filter(other => !busy(other)).length} of ${consumers.length} members idle, `
        + `${workFlow(state, name, now)?.completed.at(-1) ?? 0} items completed in the last hour` + (own ? ` (lead ${own.name})` : '');
    }).join('; ') || undefined;
    const facts = (member: MemberView, timed: boolean): BriefFacts => {
      const agent = agents.get(member.name);
      const queued = member.queue ? work.get(member.queue) : undefined;
      const own = queued?.kept.get(member.name)?.length ?? 0;
      const all = owed.get(member.name) ?? [];
      return { now, timed, todos: todosOf(state, member.name, holds, now), deferred: deferredOf(state, member.name, now), asked: agent ? openAsksOf(state, agent.agentId, now) : [], answered: answersShown(state, member.taskId), ...(member.takeover && agent ? { left: leftBehind(state, agent) } : {}),
        claimable: queued ? Math.max(0, queued.slots) + own : 0, own, results: all.slice(0, RESULTS_PER_TURN), moreResults: Math.max(0, all.length - RESULTS_PER_TURN),
        queues: standing(member), ...boardNews(state, agent?.boardSeq ?? 0, coordinates(swarm, member)) };
    };
    let slots = state.definition.maxConcurrentWorkers - state.tasks.filter(task => BUSY.has(task.status)).length;
    for (const member of swarm.members) {
      if (slots <= 0) break;
      if (!wakeable(member)) continue;
      if (member.workspace && state.tasks.some(task => task.workspaceId === member.workspace && (BUSY.has(task.status) || task.status === 'waiting_workflow'))) continue;
      const prior = taskOf(member);
      const retry = Boolean(member.retryPending && prior);
      if (callCount(state) >= state.script!.maxCalls || !retry && additionalTurnsAllowed <= 0) {
        if (!swarm.members.some(busy)) end('failed', 'Swarm ran out of the workflow\'s agent call budget; raise maxAgents or reduce members and maxTurns');
        break;
      }
      const opening = !member.taskId;
      // The first turn of a new session takes the wake-up the old one set, so that it is not woken a second time for it.
      const timed = !retry && (!opening || Boolean(member.takeover)) && due(member);
      const key = retry ? prior!.scriptKey! : `@swarm/${swarm.id}/${turnCount(swarm)}`;
      const queued = member.queue ? work.get(member.queue)! : undefined;
      const own = queued?.kept.get(member.name)?.length ?? 0;
      const shown = retry ? undefined : facts(member, timed);
      const call = { key, member: member.name, prompt: retry ? readText(state, prior!.objective) : opening ? openingPrompt(state, swarm, member, shown!) : turnBrief(state, swarm, member, shown!),
        ...(member.role ? { role: member.role } : {}),
        ...(state.script?.readOnly ? { readOnly: true } : {}),
        ...(member.workflowTool ? { workflowTool: true } : {}), ...(member.workspace ? { workspace: member.workspace } : {}),
        output: 'text' as const, selection: { agentKind: member.execution.agentKind, ...member.execution.modelSettings } };
      const mail = unread(member);
      const forWork = Boolean(queued && (own || queued.slots > 0));
      let task;
      try {
        // Before its first turn a member has no messages; a new session of a member that had turns takes what the old one left unread.
        if (!retry && (!opening || member.takeover) && mail) receiveMessages(state, member.name, key + '/inbox');
        ({ task } = scheduleMemberTurn(state, call, member.execution, nativeIdKind(member.execution.agentKind)));
      } catch (error) {
        // One member whose records do not let it take a turn stops like a member whose turn failed; the others go on.
        record({ type: 'swarm_member_stopped', swarmId: swarm.id, member: member.name, reason: 'failed', detail: ('cannot be scheduled: ' + (error instanceof Error ? error.message : String(error))).slice(0, 500) });
        continue;
      }
      // The outcomes in the brief of this turn have reached their lead.
      if (shown?.results.length) { record({ type: 'swarm_results_seen', swarmId: swarm.id, items: shown.results.map(entry => entry.item.id) }); owed.delete(member.name); }
      // A turn woken for something else is not demand for a work item.
      if (!retry && queued && !forWork && !task.consumerMessageTurn) record({ type: 'task_message_turn_marked', taskId: task.taskId });
      if (forWork && !own) queued!.slots--;
      record({ type: 'swarm_turn_scheduled', swarmId: swarm.id, member: member.name, key, taskId: task.taskId, retry, opening, at: now, ...(queued ? { wake: queued.wake(member) } : {}), ...(timed ? { timer: true } : {}) });
      record({ type: 'script_call_recorded', call: { key, taskId: task.taskId, cached: false } });
      if (!retry) additionalTurnsAllowed--;
      slots--;
    }
  } catch (error) { end('failed', error instanceof Error ? error.message : String(error)); }
  return changed;
}

/** What waits on a member now and what it has deferred, as read_context shows it between briefs. */
export function memberTodos(state: WorkflowView, name: string, now: number): { todos: unknown[]; deferred?: unknown[] } {
  const holds = currentSituations(state, now);
  const deferred = (state.todos?.open ?? []).filter(todo => holderOf(todo) === name && todo.deferred && todo.goneAt === undefined && holds.has(todo.subject)
    && !todosOf(state, name, holds, now).some(found => found.todo === todo));
  return { todos: todosOf(state, name, holds, now).map(({ todo, situation }) => todoView(todo, situation, now, false, name)),
    ...(deferred.length ? { deferred: deferred.map(todo => todoView(todo, holds.get(todo.subject), now)) } : {}) };
}

/** How many to-dos a status lists; `moreTodos` counts the rest, which are the newest of those the main agent does not hold. */
const TODOS_IN_STATUS = 40;

/** Every to-do someone was told of, for the main agent's status. */
export function workflowTodos(state: WorkflowView, now: number): { todos: unknown[]; moreTodos?: number } {
  const all = openTodos(state, currentSituations(state, now), now);
  return { todos: all.slice(0, TODOS_IN_STATUS), ...(all.length > TODOS_IN_STATUS ? { moreTodos: all.length - TODOS_IN_STATUS } : {}) };
}
