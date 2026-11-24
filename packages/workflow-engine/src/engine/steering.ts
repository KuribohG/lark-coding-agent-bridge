import { tellMember } from './durable-agents';
import { pushEvent } from './kernel-state';
import { emit } from './kernel-store';
import { BOARD_NOTICED_TOPIC, WAKE_MAX_MINUTES } from './limits';
import { boundedInteger, scriptText } from './script-contract';
import { leadsAbove, plansWork, takesTurns } from './swarm';
import type { Immutable, StatusNote, StoredTask, WorkflowCharter, WorkflowView } from './types';

/**
 * What keeps long-running work on course: the goal, the status notes of the leads, and the main agent's wake-up.
 *
 * The goal says what is wanted and how to tell that it is met. It is the user's, so only the main agent changes it.
 * How the work on it stands (how far off the goal is, what is being tried, what was ruled out) changes all the time
 * and is written by whoever plans the work: each lead keeps a status note for the part it leads. The two were one
 * text, which a lead rewrote whole to record progress, and the goal drifted with every rewrite. Every turn of a
 * member is given the goal and the status notes of the leads above it; writing a status wakes nobody.
 */

export const GOAL_MAX_TEXT = 6000;
export const STATUS_MAX_TEXT = 3000;
/** The shortest interval of a recurring wake-up of the main agent. */
const WAKE_EVERY_MIN_MINUTES = 10;
const WAKE_NOTE_MAX_TEXT = 500;

/**
 * Replaces the goal: what is wanted, how to tell that it is met, and the standing rules. The workflow's request and
 * a swarm's task never change, so without it a change of direction lives only in announcements that a member added
 * later never reads. Every lead that can still take a turn is told once, which wakes it to re-plan.
 */
export function setGoal(state: WorkflowView, input: { text?: unknown }, now: number): { goalVersion: number; told: string[] } {
  const text = scriptText(input.text, 'goal', GOAL_MAX_TEXT);
  if (!text.trim()) throw new Error('Goal text must not be empty');
  emit(state, { type: 'charter_set', text, by: 'main', at: now });
  const version = state.charter!.version;
  const told = (state.swarms ?? []).flatMap(swarm => swarm.members).filter(member => plansWork(state, member.name) && takesTurns(state, member.name)
    && tellMember(state, member.name, `The main agent replaced the goal (version ${version}); your next turns are given it. It overrides the task where they differ. Re-plan against it now: `
      + 'cancel or amend the work that no longer serves it, hand out what it newly requires, tell the members whose work in flight it changes (tell_worker), and rewrite your status (set_status).', now)).map(member => member.name);
  return { goalVersion: version, told };
}

/**
 * Replaces the status note of a lead: how far off the goal its part is now, what is being tried, what was ruled out
 * and the priorities. The members that work under the lead read it at every turn. It wakes nobody.
 */
export function setStatus(state: WorkflowView, by: string, input: { text?: unknown }, now: number): { statusVersion: number } {
  if (!plansWork(state, by) || !takesTurns(state, by)) throw new Error('A status is written by the lead of a running swarm, or of one of its queues; note what you have to say instead (note({text, topic}))');
  const text = scriptText(input.text, 'status', STATUS_MAX_TEXT);
  if (!text.trim()) throw new Error('Status text must not be empty');
  emit(state, { type: 'status_set', by, text, at: now });
  return { statusVersion: state.statuses![by]!.version };
}

/** The goal as a worker reads it; `changed` marks a version the member's previous turn was not scheduled under. */
export function goalView(state: WorkflowView, task?: Immutable<StoredTask>): (Omit<WorkflowCharter, 'by'> & { changed?: true }) | undefined {
  const goal = state.charter;
  if (!goal) return undefined;
  return { version: goal.version, text: goal.text, at: goal.at, ...(task?.agentId && task.previousTurnId && goal.version > (task.charterSince ?? 0) ? { changed: true as const } : {}) };
}

/**
 * The status notes a member works under, the whole before the part: the note of the swarm's lead, then of each lead
 * between it and the member, then the member's own when it leads. A lead that has written none is left out.
 */
export function statusesFor(state: WorkflowView, name: string | undefined): Array<{ lead: string; own?: true } & StatusNote> {
  if (name === undefined || !state.statuses) return [];
  const chain = [...leadsAbove(state, name).reverse(), ...(plansWork(state, name) ? [name] : [])];
  return chain.flatMap(lead => { const note = state.statuses![lead]; return note ? [{ lead, ...(lead === name ? { own: true as const } : {}), ...note }] : []; });
}

/** The paragraphs of a worker turn's prompt that carry the goal and the status notes in force when the turn starts. */
export function goalPrompt(state: WorkflowView, task: Immutable<StoredTask>, now: number): string[] {
  const goal = goalView(state, task);
  const name = task.agentId === undefined ? undefined : state.agents?.find(agent => agent.agentId === task.agentId)?.key;
  const ago = (at: number) => { const minutes = Math.max(0, Math.round((now - at) / 60_000)); return minutes < 120 ? `${minutes} min ago` : `${Math.round(minutes / 60)} h ago`; };
  return [
    ...(goal ? [`Goal in force (version ${goal.version}, set by the main agent${goal.changed ? '; it was replaced since your last turn, so check the work you have in hand against it first' : ''}). `
      + `It is the latest revision of the request above and of the task that follows: where they differ the goal wins, and earlier rulings and instructions that conflict with it no longer hold.\n${goal.text}`] : []),
    ...statusesFor(state, name).map(note => (note.own ? `Your status, as you last wrote it (${ago(note.at)}; set_status replaces it):` : `How the work stands, by @${note.lead} (written ${ago(note.at)}):`) + '\n' + note.text),
  ];
}

/**
 * Sets, replaces or cancels the main agent's wake-up. The main agent is otherwise woken only by what waits on it,
 * so nothing brings it back to check that work in progress still serves the goal.
 */
export function setMainWake(state: WorkflowView, input: { afterMinutes?: unknown; everyMinutes?: unknown; note?: unknown }, now: number): unknown {
  if (state.parent) throw new Error('Only the root workflow wakes the main agent');
  if (input.afterMinutes === undefined && input.everyMinutes === undefined) throw new Error('Give afterMinutes, everyMinutes or both; 0 cancels');
  if (input.afterMinutes === 0 || input.everyMinutes === 0) {
    emit(state, { type: 'main_wake_set' });
    return { wakeAt: null };
  }
  const every = input.everyMinutes === undefined ? undefined : boundedInteger(input.everyMinutes, 0, WAKE_EVERY_MIN_MINUTES, WAKE_MAX_MINUTES);
  const after = boundedInteger(input.afterMinutes, every ?? 0, 1, WAKE_MAX_MINUTES);
  const note = input.note === undefined ? undefined : scriptText(input.note, 'note', WAKE_NOTE_MAX_TEXT).trim() || undefined;
  const at = now + after * 60_000;
  emit(state, { type: 'main_wake_set', wake: { at, ...(every ? { every: every * 60_000 } : {}), ...(note ? { note } : {}) } });
  return { wakeAt: new Date(at).toISOString(), ...(every ? { everyMinutes: every } : {}) };
}

/** Raises the main agent's review when its wake-up is due, and rearms a recurring one. Called on every scheduling pass. */
export function pumpMainWake(state: WorkflowView, now: number): void {
  const wake = state.mainWake;
  if (!wake || now < wake.at || state.parent || state.status !== 'active' || state.script?.status !== 'running') return;
  // One review at a time: while the last one has not reached the main agent, another would only repeat it. One that
  // reached it is done with, acknowledged or not: a review nobody acknowledged must not be the last there is.
  if (!state.events.some(event => event.kind === 'review_due' && !event.acknowledged && !event.notified)) {
    // The review starts from what the user asked for and asks how far off that is: a look at what was produced
    // lately finds it reasonable whatever it was produced for.
    pushEvent(state, { kind: 'review_due', summary: `定时复盘${wake.note ? '（' + wake.note + '）' : ''}：从用户的原始需求出发，不要只看汇报。`
      + (state.charter ? `先看现行目标（第 ${state.charter.version} 版）写的目标和达成标准是否仍是用户要的，不是就用 set_goal 改；` : '原始需求之外尚未写下目标：先用 set_goal 写下目标和可检验的达成标准；')
      + '再用 status（其中 statuses 是各负责人写的现状，todos 是等人处理的事）、work_status、search_work、read_board 核对实际产出：按达成标准现在还差多少、比上次复盘近了多少，最大的差距有没有人在做，'
      + `留言板 ${BOARD_NOTICED_TOPIC} 主题里成员看到了哪些计划没考虑到的事。在做的事对不上目标就撤销或修订（update_work），需要负责人调整打法就用 ask 向它提出；`
      + '连续两次复盘没有更近，是打法的问题：让负责人安排人查原因、试别的路，不要追加同类工作项。人手不合适用 staff_swarm；一切正常则 ack_events 后结束本轮。' }, () => now);
  }
  emit(state, { type: 'main_wake_set', ...(wake.every ? { wake: { ...wake, at: now + wake.every } } : {}) });
}
