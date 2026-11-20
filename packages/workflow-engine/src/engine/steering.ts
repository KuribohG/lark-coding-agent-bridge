import { postToBoard } from './board';
import { pushEvent } from './kernel-state';
import { emit } from './kernel-store';
import { BOARD_NOTICED_TOPIC } from './limits';
import { boundedInteger, scriptText } from './script-contract';
import type { Immutable, StoredTask, WorkflowCharter, WorkflowView } from './types';

export const CHARTER_MAX_TEXT = 6000;
/** The longest delay a wake-up may ask for, and the shortest interval of a recurring one. */
export const WAKE_MAX_MINUTES = 24 * 60;
const WAKE_EVERY_MIN_MINUTES = 10;
const WAKE_NOTE_MAX_TEXT = 500;

const runningLead = (state: WorkflowView, name: string) => state.swarms?.some(swarm => swarm.lead === name && swarm.status === 'running'
  && swarm.runId === state.script?.runId && !swarm.finish && !swarm.members.find(member => member.name === name)?.stopped);

/**
 * Replaces the charter: the goal, priorities and standing rules as they stand now. The workflow's goal and a swarm's
 * task never change, so without it a change of direction lives only in a growing pile of announcements that a member
 * added later never reads. `by` is `main` or the calling member, who must lead a running swarm. Leads other than the
 * author are told on the board, which wakes them to re-plan.
 */
export function setCharter(state: WorkflowView, input: { text?: unknown }, by: string, now: number): { charterVersion: number; notified: string[] } {
  if (by !== 'main' && !runningLead(state, by)) throw new Error('Only the main agent and the lead of a running swarm can set the charter');
  const text = scriptText(input.text, 'charter', CHARTER_MAX_TEXT);
  if (!text.trim()) throw new Error('Charter text must not be empty');
  emit(state, { type: 'charter_set', text, by, at: now });
  const version = state.charter!.version;
  const notified: string[] = [];
  for (const swarm of state.swarms ?? []) {
    if (!swarm.lead || !runningLead(state, swarm.lead)) continue;
    // Every member that plans work re-plans: the swarm's lead and, under it, the leads of queues.
    for (const member of swarm.members) {
      const lead = member.name;
      if (member.stopped || lead === by || !(lead === swarm.lead || member.leads?.length) || !state.agents?.some(agent => agent.key === lead)) continue;
      // Naming nobody with @ keeps the notice from being delivered to anyone but the lead.
      postToBoard(state, { author: 'system' }, { to: [lead], text: `The charter was replaced (version ${version}, set by ${by === 'main' ? 'the main agent' : 'lead ' + by}). `
        + 'It overrides the task where they differ, and every turn of every member is given it. Re-plan against it now: stop handing out work that no longer serves it, '
        + 'enqueue or assign what it newly requires, and name the members whose work in flight it changes.' }, now);
      notified.push(lead);
    }
  }
  return { charterVersion: version, notified };
}

/** The charter as a worker reads it; `changed` marks a version the member's previous turn was not scheduled under. */
export function charterView(state: WorkflowView, task?: Immutable<StoredTask>): (WorkflowCharter & { changed?: true }) | undefined {
  const charter = state.charter;
  if (!charter) return undefined;
  return { ...charter, ...(task?.agentId && task.previousTurnId && charter.version > (task.charterSince ?? 0) ? { changed: true as const } : {}) };
}

/** The paragraph of a worker turn's prompt that carries the charter in force when the turn starts. */
export function charterPrompt(state: WorkflowView, task: Immutable<StoredTask>): string | undefined {
  const charter = charterView(state, task);
  if (!charter) return undefined;
  return `Charter in force (version ${charter.version}, set by ${charter.by === 'main' ? 'the main agent' : 'lead ' + charter.by}${charter.changed ? '; it was replaced since your last turn, so check the work you have in hand against it first' : ''}). `
    + `It is the latest revision of the request above and of the task that follows: where they differ the charter wins, and earlier announcements and instructions that conflict with it no longer hold.\n${charter.text}`;
}

/**
 * Sets, replaces or cancels the main agent's wake-up. The main agent is otherwise woken only by what goes wrong
 * (a failure, a stall, a starved queue), so nothing brings it back to check that work in progress still serves the goal.
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
  // One review at a time: while the last one waits to be acknowledged, another would only repeat it.
  if (!state.events.some(event => event.kind === 'review_due' && !event.acknowledged)) {
    // The review starts from what the user asked for, since the charter is itself rewritten as a run goes on, and
    // asks how far off that is: a look at what was produced lately finds it reasonable whatever it was produced for.
    pushEvent(state, { kind: 'review_due', summary: `定时复盘${wake.note ? '（' + wake.note + '）' : ''}：从用户的原始需求出发，不要只看汇报。`
      + (state.charter ? `先看现行目标单（第 ${state.charter.version} 版）开头的目标和达成标准是否仍是用户要的；` : '原始需求之外尚未设置目标单：先用 set_charter 写下目标和可检验的达成标准；')
      + '再用 status、work_status、search_work、read_board 核对实际产出，按达成标准现在还差多少、比上次复盘近了多少，最大的差距有没有人在做，'
      + `留言板 ${BOARD_NOTICED_TOPIC} 主题里成员看到了哪些计划没考虑到的事。在做的事对不上目标就撤销或挂起（update_work），并用 set_charter 改写目标之后的现状部分；`
      + '连续两次复盘没有更近，是打法的问题：安排人查原因、试别的路，不要追加同类工作项。人手不合适用 staff_swarm；一切正常则 ack_events 后结束本轮。' }, () => now);
  }
  emit(state, { type: 'main_wake_set', ...(wake.every ? { wake: { ...wake, at: now + wake.every } } : {}) });
}
