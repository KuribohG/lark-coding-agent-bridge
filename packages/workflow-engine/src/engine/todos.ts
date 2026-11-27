import { acknowledge, pushEvent } from './kernel-state';
import { emit } from './kernel-store';
import { boundedInteger, scriptText } from './script-contract';
import type { Immutable, WorkflowTodo, WorkflowView } from './types';

/**
 * To-dos: what waits on someone.
 *
 * A swarm used to tell people of things when they happened: a post to the lead when a queue ran dry, a notice to the
 * main agent when that did not help, a reminder when an ask ran out of time, and so on, each with its own record of
 * who had been told and its own timers. What happened while the reader was busy was lost or piled up, a record that
 * another event cleared had the reader told again, and what had stopped being so was still on someone's list.
 *
 * Here nothing is raised when something happens. Each scheduling pass works out the situations that hold now
 * (`Situation`, from functions that only read the state) and brings one table in step with them (`reconcileTodos`):
 * a situation that has lasted its grace time becomes a to-do of whoever answers for it; one that is still open when
 * that member's time is up goes to the member above, and in the end to the main agent; one whose situation is gone
 * goes by itself. What a situation says is worked out anew whenever it is shown, so it says how things stand, not how
 * they stood when someone was first told.
 */

export type TodoKind = 'dry' | 'idle' | 'member' | 'unstaffed' | 'ask' | 'aside' | 'dead' | 'gate' | 'spin';

/** A situation that holds now and that someone answers for. */
export interface Situation {
  /** The same for as long as the situation lasts, and for nothing else. */
  subject: string;
  kind: TodoKind;
  /** Who answers for it, nearest first: names of members, then `main`. */
  chain: string[];
  /** Since when it has held, where the state says so; otherwise it is counted from the pass that first saw it. */
  since?: number;
  /** When the newest thing it covers came under it: whoever holds the to-do is told again when that is later than it was told. */
  fresh?: number;
  /** How long (ms) each of those told has before the next one is, where the situation says so itself. */
  within?: number;
  /** For a member: how things stand, and what it can do. */
  en: string;
  act: string;
  /** The same for the first of the chain, where it reads differently to the one that answers for it than to those above. */
  first?: { en: string; act: string };
  /** For the main agent: both in one. */
  zh: string;
}

const MIN = 60_000;
/** The minutes a deferral that names no time lasts where the to-do says that members have nothing to do (see `TIMING`). */
export const IDLE_DEFER_MINUTES = 30;
/**
 * For each kind: how long the situation must last before anyone is told (`grace`), how long each of those told has
 * before the one above is (`within`), and how long it must be gone before its to-do is (`linger`). A queue that gets
 * one item, which an idle member takes at once, has not stopped being dry.
 *
 * `defer` is how long a deferral lasts that names no time; without it, such a deferral lasts as long as the situation
 * does. Members with nothing to do are not put off for good: whoever said that there was no work for them said it of
 * how things stood then, and while it stands nobody else is told that they wait.
 */
const TIMING: Record<TodoKind, { grace: number; within: number; linger: number; defer?: number }> = {
  dry: { grace: 2 * MIN, within: 20 * MIN, linger: 3 * MIN, defer: IDLE_DEFER_MINUTES * MIN },
  idle: { grace: 0, within: 10 * MIN, linger: 0, defer: IDLE_DEFER_MINUTES * MIN },
  member: { grace: 0, within: 15 * MIN, linger: 0 },
  unstaffed: { grace: 2 * MIN, within: 15 * MIN, linger: 0 },
  ask: { grace: 0, within: 15 * MIN, linger: 0 },
  aside: { grace: 0, within: 60 * MIN, linger: 0 },
  dead: { grace: 0, within: 30 * MIN, linger: 0 },
  gate: { grace: 0, within: 60 * MIN, linger: 0 },
  spin: { grace: 0, within: 30 * MIN, linger: 0 },
};
/** A to-do that has reached the end of its chain and stays open is told there again this often. */
const AGAIN = 60 * MIN;
/** To-dos the table holds at once; past this the newest situations wait for room. */
const MAX_OPEN = 512;
const DEFER_MAX_MINUTES = 24 * 60;
const NOTE_MAX = 500;

type TodoView = Immutable<WorkflowTodo>;

const open = (state: WorkflowView) => state.todos?.open ?? [];
/** Who holds a to-do now: the last one it was told to. */
export const holderOf = (todo: TodoView) => todo.told.at(-1)?.who;
/**
 * Whom a to-do is in front of: everyone it went to since it was last handed on. Going up adds whoever stands above
 * and takes it from nobody, so the member that was asked still reads its ask after its lead has been told of it.
 */
function facing(todo: TodoView): string[] {
  let from = 0;
  todo.told.forEach((told, index) => { if (told.by !== undefined) from = index; });
  return todo.told.slice(from).map(told => told.who);
}
/** When a deferral made at `at` that names no time is over, for a kind that has such a time. */
const defaultUntil = (kind: string, at: number) => { const lasts = TIMING[kind as TodoKind]?.defer; return lasts === undefined ? undefined : at + lasts; };
/**
 * When the deferral of a to-do is over: at the time it names, or the time its kind gives one that names none;
 * undefined for one that lasts as long as the situation does. Worked out where it is read and not recorded, so that
 * a deferral recorded before its kind had such a time is held to it as well.
 */
export const deferredUntil = (todo: TodoView) => todo.deferred && (todo.deferred.until ?? defaultUntil(todo.kind, todo.deferred.at));
const deferredNow = (todo: TodoView, now: number) => { const until = deferredUntil(todo); return Boolean(todo.deferred && (until === undefined || until > now)); };
/** The subject of the notice that tells the main agent of a to-do. */
const noticeSubject = (todo: TodoView) => `todo:${todo.id}`;

/** How a member stands for what was put in front of it: whether it is in a turn, and when its latest turn was briefed. */
export type TurnStanding = (who: string) => { busy: boolean; briefedAt: number } | undefined;

/**
 * Whether a to-do its holder has left open for `within` goes up now. Time alone does not say that the holder let it
 * lie: a lead in a long turn was told of nothing that came up since the turn began, and one whose turn was briefed
 * with the to-do may be dealing with it. So it goes up once the holder has had a turn that was briefed with it and
 * is out of that turn; a holder that got no such turn is given twice the time, and nothing waits longer than three
 * times it. A member whose turns the engine does not schedule is taken to have seen it.
 */
function overdue(told: { who: string; at: number }, within: number, now: number, turn: TurnStanding): boolean {
  const waited = now - told.at;
  if (waited < within) return false;
  const standing = turn(told.who);
  if (!standing || waited >= 3 * within) return true;
  return standing.briefedAt >= told.at ? !standing.busy : waited >= 2 * within;
}

/**
 * Brings the table in step with the situations that hold. `runs` says whether a member can still take a turn: one
 * that cannot is passed over. `turn` says how a member stands (see `overdue`). Returns whether anything changed.
 */
export function reconcileTodos(state: WorkflowView, found: readonly Situation[], now: number, runs: (who: string) => boolean, turn: TurnStanding = () => undefined): boolean {
  const holds = new Map(found.map(situation => [situation.subject, situation]));
  const upsert: WorkflowTodo[] = [];
  const remove: number[] = [];
  const able = (who: string) => who === 'main' || runs(who);
  /** Who comes after those already told: the rest of the situation's chain, or all of it for a holder outside it. */
  const next = (todo: TodoView, situation: Situation) => {
    const holder = holderOf(todo);
    const at = holder === undefined ? -1 : situation.chain.indexOf(holder);
    const rest = at >= 0 ? situation.chain.slice(at + 1) : situation.chain.filter(who => !todo.told.some(told => told.who === who));
    return rest.find(able);
  };
  for (const todo of open(state)) {
    const situation = holds.get(todo.subject);
    holds.delete(todo.subject);
    const timing = TIMING[todo.kind as TodoKind] ?? TIMING.ask;
    if (!situation) {
      // Nobody was told of what did not last its grace time; what someone was told of stays until it has been gone a while.
      if (!todo.told.length || !timing.linger || todo.goneAt !== undefined && now - todo.goneAt >= timing.linger) remove.push(todo.id);
      else if (todo.goneAt === undefined) upsert.push({ ...copy(todo), goneAt: now });
      continue;
    }
    const entry = copy(todo);
    let changed = false;
    if (entry.goneAt !== undefined) { delete entry.goneAt; changed = true; }
    const tell = (who: string) => { entry.told.push({ who, at: now }); delete entry.deferred; changed = true; };
    const again = () => { entry.told[entry.told.length - 1] = { ...entry.told.at(-1)!, at: now }; changed = true; };
    // A deferral that ran out puts the to-do in front of its holder again.
    const until = deferredUntil(entry);
    if (until !== undefined && until <= now) { delete entry.deferred; again(); }
    const holder = entry.told.at(-1);
    if (!holder) {
      const first = now - entry.since >= timing.grace ? next(entry, situation) : undefined;
      if (first !== undefined) tell(first);
    } else if (!able(holder.who)) {
      // Whoever held it cannot take a turn any more: it goes up at once, or back to whoever answers for it now.
      const up = next(entry, situation) ?? situation.chain.find(able);
      if (up !== undefined && up !== holder.who) tell(up);
    } else if (!deferredNow(entry, now)) {
      // The main agent is not reached sooner than the kind allows, however little time an asker gave.
      const above = next(entry, situation);
      const within = Math.max(situation.within ?? timing.within, above === 'main' ? timing.within : 0);
      const up = above !== undefined && overdue(holder, within, now, turn) ? above : undefined;
      if (up !== undefined) tell(up);
      else if (situation.fresh !== undefined && situation.fresh > holder.at || next(entry, situation) === undefined && now - holder.at >= Math.max(AGAIN, situation.within ?? 0)) again();
    }
    if (changed) upsert.push(entry);
  }
  let id = state.todos?.next ?? 1;
  let room = MAX_OPEN - open(state).length + remove.length;
  for (const situation of holds.values()) {
    if (room-- <= 0) break;
    const since = situation.since ?? now;
    const first = now - since >= TIMING[situation.kind].grace ? situation.chain.find(able) : undefined;
    upsert.push({ id: id++, subject: situation.subject, kind: situation.kind, since, told: first === undefined ? [] : [{ who: first, at: now }] });
  }
  if (upsert.length || remove.length) emit(state, { type: 'todos_updated', ...(upsert.length ? { upsert } : {}), ...(remove.length ? { remove } : {}), at: now });
  return tellMain(state, new Map(found.map(situation => [situation.subject, situation])), now) || upsert.length > 0 || remove.length > 0;
}

function copy(todo: TodoView): WorkflowTodo {
  return { ...todo, told: todo.told.map(told => ({ ...told })), ...(todo.deferred ? { deferred: { ...todo.deferred } } : {}) };
}

/**
 * Keeps the main agent's notices in step with the to-dos it holds: one notice for each, raised when the to-do reaches
 * it (and again when it is told again), settled when the to-do is gone, deferred or handed to someone else. The main
 * agent is the top of every chain, so this is the same delivery a member gets in its brief, through the channel that
 * reaches a main agent in or between turns. While a to-do lingers, its situation gone for the moment, its notice is
 * left as it is: settling it now and raising it again when the situation returns would tell the same thing twice.
 */
function tellMain(state: WorkflowView, holds: ReadonlyMap<string, Situation>, now: number): boolean {
  const standing = new Map<string, { todo: TodoView; situation: Situation }>();
  const lingering = new Set<string>();
  for (const todo of open(state)) {
    if (holderOf(todo) !== 'main' || deferredNow(todo, now)) continue;
    const situation = holds.get(todo.subject);
    if (situation) standing.set(noticeSubject(todo), { todo, situation });
    else lingering.add(noticeSubject(todo));
  }
  const raised = state.events.filter(event => !event.acknowledged && event.subject?.startsWith('todo:'));
  const current = (subject: string) => raised.find(event => event.subject === subject && (event.createdAt ?? 0) >= standing.get(subject)!.todo.told.at(-1)!.at);
  const stale = raised.filter(event => !lingering.has(event.subject!) && (!standing.has(event.subject!) || current(event.subject!) !== event));
  if (stale.length) acknowledge(state, stale, now);
  let changed = stale.length > 0;
  for (const [subject, { todo, situation }] of standing) {
    if (current(subject)) continue;
    const minutes = Math.round((now - todo.since) / MIN);
    const last = todo.told.at(-1)!;
    const from = last.by ? `（${last.by} 转交给你${last.note ? '：' + last.note : ''}）` : todo.told.length > 1 ? `（${todo.told.slice(0, -1).map(told => told.who).join('、')} 未处理，上报到你）` : '';
    // An ask made of the main agent is told as one; an ask of someone else that reached it is a to-do like the others.
    pushEvent(state, { kind: situation.kind === 'ask' && situation.chain[0] === 'main' ? 'ask' : 'todo', subject, summary: `待办 #${todo.id}${minutes ? `，已 ${minutes} 分钟` : ''}${from}：${situation.zh}` }, () => now);
    changed = true;
  }
  return changed;
}

/**
 * Settles the notice that told the main agent of a to-do whose situation the caller has just ended, an ask it has
 * answered for one. The next pass would see that the to-do is gone; until then the notice could wake the main agent
 * for what it has dealt with.
 */
export function settleNotice(state: WorkflowView, subject: string, now: number): void {
  const todo = open(state).find(found => found.subject === subject);
  if (todo) acknowledge(state, state.events.filter(event => !event.acknowledged && event.subject === noticeSubject(todo)), now);
}

/**
 * Ends every to-do and settles what the main agent was told of them. For when the script is over: no situation is
 * worked out any more, so what was open would otherwise stay on the main agent's list for good.
 */
export function clearTodos(state: WorkflowView, now: number): boolean {
  const all = open(state);
  const raised = state.events.filter(event => !event.acknowledged && event.subject?.startsWith('todo:'));
  if (!all.length && !raised.length) return false;
  if (all.length) emit(state, { type: 'todos_updated', remove: all.map(todo => todo.id), at: now });
  acknowledge(state, raised, now);
  return true;
}

/** The to-dos in front of `who` that nobody has deferred, the oldest first, each with what it says now. */
export function todosOf(state: WorkflowView, who: string, holds: ReadonlyMap<string, Situation>, now: number): Array<{ todo: TodoView; situation: Situation }> {
  return open(state).flatMap(todo => {
    const situation = holds.get(todo.subject);
    return situation && !deferredNow(todo, now) && facing(todo).includes(who) ? [{ todo, situation }] : [];
  }).sort((a, b) => a.todo.since - b.todo.since);
}

/** How many to-dos `who` has deferred and that still hold. */
export function deferredOf(state: WorkflowView, who: string, now: number): number {
  return open(state).filter(todo => holderOf(todo) === who && todo.goneAt === undefined && deferredNow(todo, now)).length;
}

/** Whether `who` was told of a to-do after `since`, the time its latest turn was briefed: that turn did not have it. */
export function toldSince(state: WorkflowView, who: string, since: number, now: number): boolean {
  return open(state).some(todo => todo.goneAt === undefined && !deferredNow(todo, now) && holderOf(todo) === who && todo.told.at(-1)!.at > since);
}

/** A to-do as it is shown: to the member that holds it, and in the main agent's status. */
export function todoView(todo: TodoView, situation: Situation | undefined, now: number, zh = false, reader?: string): Record<string, unknown> {
  const said = situation && reader === situation.chain[0] && situation.first ? situation.first : situation;
  return { id: todo.id, kind: todo.kind, minutes: Math.round((now - todo.since) / MIN), holder: holderOf(todo) ?? null,
    ...(todo.told.length > 1 ? { leftOpenBy: [...new Set(todo.told.slice(0, -1).map(told => told.who))] } : {}),
    ...(todo.told.at(-1)?.by ? { passedBy: todo.told.at(-1)!.by, ...(todo.told.at(-1)!.note ? { note: todo.told.at(-1)!.note } : {}) } : {}),
    ...(todo.deferred ? { deferred: { by: todo.deferred.by, ...(deferredUntil(todo) === undefined ? {} : { until: deferredUntil(todo) }), ...(todo.deferred.note ? { note: todo.deferred.note } : {}) } } : {}),
    ...(situation && said ? zh ? { text: situation.zh } : { text: said.en, act: said.act } : {}) };
}

/** Every to-do that someone was told of, for the main agent's status: the ones it holds first, then the oldest. */
export function openTodos(state: WorkflowView, holds: ReadonlyMap<string, Situation>, now: number): unknown[] {
  return open(state).filter(todo => todo.told.length && todo.goneAt === undefined && holds.has(todo.subject))
    .sort((a, b) => Number(holderOf(b) === 'main') - Number(holderOf(a) === 'main') || a.since - b.since)
    .map(todo => { const view = todoView(todo, holds.get(todo.subject), now, true); return { ...view, text: String(view.text ?? '').slice(0, 240) }; });
}

function named(state: WorkflowView, input: { id?: unknown }): TodoView {
  const todo = open(state).find(found => found.id === input.id && found.told.length);
  if (!todo) throw new Error(`No open to-do has the id ${JSON.stringify(input.id) ?? 'undefined'}: it is settled, or was never yours; your brief (read_context) lists the ones that wait on you`);
  return todo;
}

/**
 * Whether `who` may defer or pass on a to-do: whoever holds it, the main agent, and a member that stands above its
 * holder (`above` names those for a member). One that left it open until it went up still reads it and can remove
 * its cause, but it is no longer that member's to put off.
 */
function may(todo: TodoView, who: string, above: (member: string) => string[]): boolean {
  const holder = holderOf(todo)!;
  return who === 'main' || holder === who || holder !== 'main' && above(holder).includes(who);
}

/**
 * "Not now": the to-do stays, but it is not put in front of its holder and does not go up, until `minutes` have
 * passed or, without them, for the time its kind has (`TIMING`) and otherwise for as long as its situation lasts.
 * `note` says why, for those who look at it later.
 */
export function deferTodo(state: WorkflowView, who: string, input: { id?: unknown; minutes?: unknown; note?: unknown }, now: number, above: (member: string) => string[]): unknown {
  const todo = named(state, input);
  if (!may(todo, who, above)) throw new Error(`To-do ${todo.id} is held by ${holderOf(todo)}; whoever holds it, a lead above that member or the main agent defers it`);
  const note = typeof input.note === 'string' && input.note.trim() ? scriptText(input.note, 'note', NOTE_MAX).trim() : '';
  if (!note) throw new Error('defer_todo needs a note: why it need not be acted on now, and what would change that');
  const minutes = input.minutes === undefined || input.minutes === null ? undefined : boundedInteger(input.minutes, 0, 1, DEFER_MAX_MINUTES);
  const given = minutes === undefined ? undefined : now + minutes * MIN;
  emit(state, { type: 'todos_updated', upsert: [{ ...copy(todo), deferred: { by: who, at: now, ...(given === undefined ? {} : { until: given }), note } }], at: now });
  if (holderOf(todo) === 'main') acknowledge(state, state.events.filter(event => !event.acknowledged && event.subject === noticeSubject(todo)), now);
  const until = given ?? defaultUntil(todo.kind, now);
  return { id: todo.id, deferred: true, ...(until === undefined ? { until: 'its cause is gone' } : { until: new Date(until).toISOString() }) };
}

/** Hands a to-do to someone else, who holds it from then on and is woken for it. */
export function passTodo(state: WorkflowView, who: string, input: { id?: unknown; to?: unknown; note?: unknown }, now: number, above: (member: string) => string[], runs: (who: string) => boolean): unknown {
  const todo = named(state, input);
  if (!may(todo, who, above)) throw new Error(`To-do ${todo.id} is held by ${holderOf(todo)}; whoever holds it, a lead above that member or the main agent passes it on`);
  const to = scriptText(input.to, 'to', 100).replace(/^@/, '');
  if (to === holderOf(todo)) throw new Error(`To-do ${todo.id} is already held by ${to}`);
  if (to !== 'main' && !runs(to)) throw new Error(`"${to.slice(0, 60)}" is not a member that will have another turn; pass it to a member that runs, or to "main"`);
  if (to === 'main' && who !== 'main' && above(who).length) throw new Error(`Pass it to the lead above you (${above(who)[0]}), which passes on to the main agent what it cannot settle itself`);
  const note = input.note === undefined || input.note === null ? undefined : scriptText(input.note, 'note', NOTE_MAX).trim() || undefined;
  const entry = copy(todo);
  delete entry.deferred;
  entry.told.push({ who: to, at: now, by: who, ...(note ? { note } : {}) });
  emit(state, { type: 'todos_updated', upsert: [entry], at: now });
  if (holderOf(todo) === 'main') acknowledge(state, state.events.filter(event => !event.acknowledged && event.subject === noticeSubject(todo)), now);
  return { id: todo.id, holder: to };
}
