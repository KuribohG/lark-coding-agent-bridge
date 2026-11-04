import { randomUUID } from 'node:crypto';
import { freezeWorkClaims, releaseWorkClaims } from './work-queue';
import { consumerPools } from './work-routing';
import { clearEventBindings } from './event-waits';
import { workerSelection } from './execution';
import { scriptArgs, scriptText, SCRIPT_MAX_REVISIONS } from './script-contract';
import { acknowledge, addArtifact, BUSY, sameRoot } from './kernel-state';
import type { KernelContext } from './kernel-context';
import type { WorkflowState } from './types';

export const RESUME_ROOT_CHANGED = 'root_changed';
export const RESUME_DEADLINE = 'deadline';

/** Restart handling: retiring what the previous process left running, and explicit or automatic script replay. */
export class RestartRecovery {
  constructor(private readonly ctx: KernelContext) {}

  retireInterrupted(): void {
    const { store, hosts } = this.ctx;
    // The last heartbeat approximates when the previous process stopped; the outage does not count toward deadlines.
    const beat = store.heartbeat();
    const since = Number.isFinite(beat) && beat > 0 ? Math.min(beat, this.ctx.now()) : this.ctx.now();
    // Retire old agent-led instances without discarding their evidence or blocking new scripts.
    for (const state of store.list()) {
      if (['completed', 'cancelled'].includes(state.status)) continue;
      if (state.script && state.status !== 'interrupted') {
        state.restart = { since, resume: !state.parent && state.status === 'active' && ['queued', 'running'].includes(state.script.status) };
      }
      state.status = state.script ? 'interrupted' : 'cancelled';
      if (state.script) state.script.status = 'interrupted';
      for (const pool of consumerPools(state)) pool.status = 'suspended';
      const governed = Boolean(this.ctx.host.executionLedger);
      if (governed) freezeWorkClaims(state, 'Host restart; execution settlement requires reconciliation');
      else {
        // A surviving worker could not submit a released claim; its turn restarts instead.
        hosts.discardTasks(state.workflowId, (state.workQueue?.claims ?? []).filter(claim => claim.status === 'active').map(claim => claim.taskId));
        releaseWorkClaims(state, this.ctx.now(), 'Bridge restarted; explicitly replay to continue');
      }
      for (const task of state.tasks) if (BUSY.has(task.status) || task.status === 'waiting_workflow' || (!state.script && task.status === 'waiting_input')) {
        const submittedAttempt = Boolean(task.attempts.length);
        task.status = governed && submittedAttempt ? 'unknown' : state.script ? 'interrupted' : 'cancelled';
        if (governed) task.quiescence = submittedAttempt ? 'unknown' : 'quiescent';
        task.error = state.script ? 'Bridge restarted; explicitly replay the script to continue.' : 'Agent-led workflows have been retired.';
      }
      store.save(state);
    }
  }

  /** Interrupted time does not count toward the deadline; restore it once when the workflow is replayed. */
  resumeClock(state: WorkflowState): void {
    if (state.status !== 'interrupted' || !state.restart) return;
    if (!this.ctx.host.executionLedger) state.deadlineAt += Math.max(0, this.ctx.now() - state.restart.since);
    state.restart = undefined;
  }

  /** Replays root scripts that a restart interrupted mid-run; anything else still waits for an explicit replay. */
  async resumeAfterRestart(): Promise<Array<{ state: WorkflowState; resumed: boolean; reason?: string }>> {
    const { store } = this.ctx;
    const outcomes: Array<{ state: WorkflowState; resumed: boolean; reason?: string }> = [];
    for (const snapshot of store.list()) {
      if (snapshot.parent || snapshot.status !== 'interrupted' || !snapshot.restart?.resume) continue;
      const root = await this.ctx.host.resolveRoot(snapshot.root.scopeId);
      if (this.ctx.closed) break;
      const state = store.state(snapshot.root.scopeId, snapshot.workflowId);
      if (!state || state.status !== 'interrupted' || !state.restart?.resume) continue;
      let reason: string | undefined;
      try {
        if (!root || !sameRoot(root, state.root)) throw new Error(RESUME_ROOT_CHANGED);
        store.transaction(() => {
          this.resumeClock(state);
          if (this.ctx.now() >= state.deadlineAt) throw new Error(RESUME_DEADLINE);
          this.replayScript(state, {});
          store.save(state);
        });
      } catch (error) { reason = error instanceof Error ? error.message : String(error); }
      if (reason === undefined) { outcomes.push({ state, resumed: true }); continue; }
      // Leave it interrupted for an explicit decision; do not retry automatically on every restart.
      const current = store.state(snapshot.root.scopeId, snapshot.workflowId)!;
      current.restart = { ...current.restart!, resume: false };
      store.save(current);
      outcomes.push({ state: current, resumed: false, reason });
    }
    return outcomes;
  }

  replayScript(state: WorkflowState, args: Record<string, unknown>): void {
    const now = this.ctx.now;
    const script = state.script;
    if (!script) throw new Error('Not a script workflow');
    this.resumeClock(state);
    if (['queued', 'running'].includes(script.status) || state.tasks.some(task => BUSY.has(task.status))) throw new Error('Stop or pause the script and wait for workers to finish before replay');
    const children=this.ctx.store.descendants(state);
    if (children.some(child=>child.tasks.some(task=>BUSY.has(task.status)))) throw new Error('Wait for child workflow workers to stop before replay');
    if (script.revision >= SCRIPT_MAX_REVISIONS) throw new Error('Script replay limit reached');
    if (args.script !== undefined || Object.hasOwn(args, 'args') || args.execution !== undefined || !script.planRef) {
      scriptText(args.plan, 'updated plan', 12_000);
    }
    if (args.plan !== undefined) script.planRef = addArtifact(state, 'workflow-plan', scriptText(args.plan, 'plan', 12_000), now).ref;
    if (args.script !== undefined) script.sourceRef = addArtifact(state, 'workflow-script', scriptText(args.script, 'script'), now).ref;
    if (Object.hasOwn(args, 'args')) script.args = scriptArgs(args.args);
    if (args.execution !== undefined) script.defaults = workerSelection(args.execution, state.root, this.ctx.host);
    script.runId = randomUUID(); script.revision++; script.status = 'queued';
    clearEventBindings(state);
    script.calls = []; script.mailboxCalls = []; script.workCalls = []; script.controlCalls = []; script.workspaceCalls = []; script.logs = []; script.error = undefined; script.resultRef = undefined; script.phase = undefined; script.stopReason = undefined;
    state.status = 'active';
    for (const event of state.events) if (['script_result_ready', 'script_failed'].includes(event.kind)) acknowledge(event, now());
    for (const child of children.filter(child=>child.parent!.workflowId===state.workflowId && ['paused','interrupted'].includes(child.status))) {
      this.replayScript(child,{});this.ctx.store.save(child);
    }
  }
}
