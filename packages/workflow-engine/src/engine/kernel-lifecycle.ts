import { cancelWork, freezeWorkClaims } from './work-queue';
import { acknowledge, BUSY, pushEvent } from './kernel-state';
import { emit } from './kernel-store';
import type { KernelContext } from './kernel-context';
import type { WorkflowEvent, WorkflowTask, WorkflowView } from './types';

/** A task whose turn ended but which still holds its session: cancel it whenever the workflow stops. */
const IDLE_PENDING = new Set<WorkflowTask['status']>(['waiting_workflow', 'waiting_input']);

/**
 * Notices that only tell the main agent something. Once a turn of its has them they are settled: nothing about the
 * workflow stays open on their account, unlike a queue that is still dry or a result that still waits for `complete`.
 * A reply can be read again with worker_messages, and the next review comes when it is due.
 */
const TOLD: ReadonlySet<WorkflowEvent['kind']> = new Set(['worker_reply', 'review_due']);

/** Whole-workflow transitions the main agent and the scheduler share: wake-ups, invalidation and cancellation. */
export class WorkflowLifecycle {
  constructor(private readonly ctx: KernelContext) {}

  hasWake(scopeId: string): boolean {
    const state = this.ctx.store.state(scopeId);
    return Boolean(state && ['active', 'paused'].includes(state.status) && state.events.some(event => !event.acknowledged && !event.notified));
  }

  /** The notices the main agent has not been given yet, oldest first. */
  undelivered(scopeId: string): WorkflowEvent[] {
    const state = this.ctx.store.state(scopeId);
    if (!state || !['active', 'paused'].includes(state.status)) return [];
    return state.events.filter(event => !event.acknowledged && !event.notified).map(event => ({ ...event }));
  }

  /**
   * The main agent was woken for these notices, or the wake failed and is not tried again. `delivered` says that a
   * turn of its has them, at its start or handed in while it runs: the ones that only told it something are settled
   * with that, and so are those of their kind that an earlier turn was given and never acknowledged.
   */
  markNotified(scopeId: string, ids: string[], delivered = false): void {
    const state = this.ctx.store.state(scopeId);
    if (!state) return;
    const pending = state.events.filter(event => ids.includes(event.id) && !event.notified).map(event => event.id);
    const told = delivered ? state.events.filter(event => TOLD.has(event.kind) && !event.acknowledged && (event.notified || ids.includes(event.id))) : [];
    if (!pending.length && !told.length) return;
    this.ctx.store.transact(() => {
      if (pending.length) emit(state, { type: 'notices_notified', ids: pending, at: this.ctx.now() });
      acknowledge(state, told, this.ctx.now());
    }, 'host:notified');
  }

  invalidate(scopeId: string): void {
    const state = this.ctx.store.state(scopeId);
    if (!state || ['binding_attention', 'interrupted'].includes(state.status)) return;
    this.ctx.store.transact(() => {
      this.ctx.children.suspendChildren(state, false);
      emit(state, { type: 'binding_invalidated' });
      for (const task of state.tasks) if (BUSY.has(task.status) || IDLE_PENDING.has(task.status)) this.ctx.scheduler.cancelTask(task, state);
      pushEvent(state, { kind: 'binding_attention', summary: 'Root session, engine, workspace or policy changed; new delegation stopped.' }, this.ctx.now);
    }, 'host:invalidate');
  }

  cancel(scopeId: string): boolean {
    const state = this.ctx.store.state(scopeId);
    if (!state) return false;
    this.ctx.store.transact(() => this.cancelState(state), 'host:cancel');
    return true;
  }

  cancelState(state: WorkflowView): void {
    this.ctx.children.suspendChildren(state, true);
    const governed = Boolean(this.ctx.host.executionLedger);
    emit(state, { type: governed ? 'workflow_cancel_requested' : 'workflow_cancelled' });
    if (governed) freezeWorkClaims(state, 'Workflow admission revoked; native quiescence is pending');
    cancelWork(state, this.ctx.now(), governed);
    for (const task of state.tasks) if (BUSY.has(task.status) || task.status === 'waiting_input' || task.status === 'waiting_workflow') this.ctx.scheduler.cancelTask(task, state);
    if (governed && !state.tasks.some(task => task.status === 'cancelling' || task.status === 'unknown')) {
      emit(state, { type: 'workflow_cancelled' }); cancelWork(state, this.ctx.now());
    }
  }

  pause(state: WorkflowView): void {
    this.ctx.children.suspendChildren(state, false);
    emit(state, { type: 'workflow_paused' });
    for (const task of state.tasks) if (BUSY.has(task.status) || IDLE_PENDING.has(task.status)) this.ctx.scheduler.cancelTask(task, state);
  }
}
