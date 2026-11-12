import { randomUUID } from 'node:crypto';
import { releaseWorkClaims } from './work-queue';
import { workerSelection } from './execution';
import { scriptArgs, scriptText, SCRIPT_MAX_REVISIONS } from './script-contract';
import { acknowledge, addArtifact, BUSY, sameRoot } from './kernel-state';
import { emit } from './kernel-store';
import type { KernelContext } from './kernel-context';
import type { WorkflowState, WorkflowView } from './types';

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
    for (const state of store.list()) store.transact(() => {
      // Workflows a previous restart already interrupted have nothing left to retire.
      if (state.status !== 'interrupted' || state.script!.status !== 'interrupted') {
        emit(state, { type: 'workflow_interrupted', ...(state.status !== 'interrupted'
          ? { restart: { since, resume: !state.parent && state.status === 'active' && ['queued', 'running'].includes(state.script!.status) } } : {}) });
      }
      // A surviving worker could not submit a released claim; its turn restarts instead.
      hosts.discardTasks(state.workflowId, (state.workQueue?.claims ?? []).filter(claim => claim.status === 'active').map(claim => claim.taskId));
      releaseWorkClaims(state, this.ctx.now(), 'Bridge restarted; explicitly replay to continue');
      for (const task of state.tasks) if (BUSY.has(task.status) || task.status === 'waiting_workflow') {
        emit(state, { type: 'task_interrupted', taskId: task.taskId, error: 'Bridge restarted; explicitly replay the script to continue.' });
      }
    }, 'restart');
  }

  /** Interrupted time does not count toward the deadline; restore it once when the workflow is replayed. */
  resumeClock(state: WorkflowView): void {
    if (state.status !== 'interrupted' || !state.restart) return;
    emit(state, { type: 'clock_resumed', deadlineAt: state.deadlineAt + Math.max(0, this.ctx.now() - state.restart.since) });
  }

  /** Replays root scripts that a restart interrupted mid-run; anything else still waits for an explicit replay. */
  async resumeAfterRestart(): Promise<Array<{ state: WorkflowState; resumed: boolean; reason?: string }>> {
    const { store } = this.ctx;
    const outcomes: Array<{ state: WorkflowState; resumed: boolean; reason?: string }> = [];
    const interrupted = store.list().filter(state => !state.parent && state.status === 'interrupted' && state.restart?.resume)
      .map(state => ({ scopeId: state.root.scopeId, workflowId: state.workflowId }));
    for (const { scopeId, workflowId } of interrupted) {
      const root = await this.ctx.host.resolveRoot(scopeId);
      if (this.ctx.closed) break;
      const state = store.state(scopeId, workflowId);
      if (!state || state.status !== 'interrupted' || !state.restart?.resume) continue;
      let reason: string | undefined;
      try {
        if (!root || !sameRoot(root, state.root)) throw new Error(RESUME_ROOT_CHANGED);
        store.transact(() => {
          this.resumeClock(state);
          if (this.ctx.now() >= state.deadlineAt) throw new Error(RESUME_DEADLINE);
          this.replayScript(state, {}, true);
        }, 'restart');
      } catch (error) { reason = error instanceof Error ? error.message : String(error); }
      if (reason === undefined) { outcomes.push({ state: store.public(state), resumed: true }); continue; }
      // Leave it interrupted for an explicit decision; do not retry automatically on every restart.
      const current = store.state(scopeId, workflowId)!;
      store.transact(() => emit(current, { type: 'restart_resume_disabled' }), 'restart');
      outcomes.push({ state: store.public(current), resumed: false, reason });
    }
    return outcomes;
  }

  replayScript(state: WorkflowView, args: Record<string, unknown>, automatic = false): void {
    const now = this.ctx.now;
    const script = state.script;
    if (!script) throw new Error('Not a script workflow');
    this.resumeClock(state);
    if (['queued', 'running'].includes(script.status) || state.tasks.some(task => BUSY.has(task.status))) throw new Error('Stop or pause the script and wait for workers to finish before replay');
    const children=this.ctx.store.descendants(state);
    if (children.some(child=>child.tasks.some(task=>BUSY.has(task.status)))) throw new Error('Wait for child workflow workers to stop before replay');
    // The limit bounds replays someone asked for; a bridge restart must not use them up.
    if (!automatic && script.revision >= SCRIPT_MAX_REVISIONS) throw new Error('Script replay limit reached');
    if (args.script !== undefined || Object.hasOwn(args, 'args') || args.execution !== undefined || !script.planRef) {
      scriptText(args.plan, 'updated plan', 12_000);
    }
    const planRef = args.plan !== undefined ? addArtifact(state, 'workflow-plan', scriptText(args.plan, 'plan', 12_000), now).ref : undefined;
    const sourceRef = args.script !== undefined ? addArtifact(state, 'workflow-script', scriptText(args.script, 'script'), now).ref : undefined;
    emit(state, { type: 'script_replayed', runId: randomUUID(), counted: !automatic,
      ...(planRef ? { planRef } : {}), ...(sourceRef ? { sourceRef } : {}),
      ...(Object.hasOwn(args, 'args') ? { args: { value: scriptArgs(args.args) } } : {}),
      ...(args.execution !== undefined ? { defaults: workerSelection(args.execution, state.root, this.ctx.host) } : {}) });
    acknowledge(state, state.events.filter(event => ['script_result_ready', 'script_failed'].includes(event.kind)), now());
    for (const child of children.filter(child=>child.parent!.workflowId===state.workflowId && ['paused','interrupted'].includes(child.status))) {
      this.replayScript(child, {}, automatic);
    }
  }
}
