import { cancelWork } from './work-queue';
import { BUSY, pushEvent } from './kernel-state';
import { emit } from './kernel-store';
import type { KernelContext } from './kernel-context';
import type { WorkflowView } from './types';

/** Whole-workflow transitions the main agent and the scheduler share: wake-ups, invalidation and cancellation. */
export class WorkflowLifecycle {
  constructor(private readonly ctx: KernelContext) {}

  hasWake(scopeId: string): boolean {
    const state = this.ctx.store.state(scopeId);
    return Boolean(state && ['active', 'paused'].includes(state.status) && state.events.some(event => !event.acknowledged && !event.notified));
  }

  markNotified(scopeId: string, ids: string[]): void {
    const state = this.ctx.store.state(scopeId);
    const pending = state?.events.filter(event => ids.includes(event.id) && !event.notified).map(event => event.id);
    if (state && pending?.length) this.ctx.store.transact(() => emit(state, { type: 'notices_notified', ids: pending, at: this.ctx.now() }), 'host:notified');
  }

  invalidate(scopeId: string): void {
    const state = this.ctx.store.state(scopeId);
    if (!state || ['binding_attention', 'interrupted'].includes(state.status)) return;
    this.ctx.store.transact(() => {
      this.ctx.children.suspendChildren(state, false);
      emit(state, { type: 'binding_invalidated' });
      for (const task of state.tasks) if (BUSY.has(task.status) || task.status === 'waiting_workflow') this.ctx.scheduler.cancelTask(task, state);
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
    emit(state, { type: 'workflow_cancelled' });
    cancelWork(state, this.ctx.now());
    for (const task of state.tasks) if (BUSY.has(task.status) || task.status === 'waiting_input' || task.status === 'waiting_workflow') this.ctx.scheduler.cancelTask(task, state);
  }

  pause(state: WorkflowView): void {
    this.ctx.children.suspendChildren(state, false);
    emit(state, { type: 'workflow_paused' });
    for (const task of state.tasks) if (BUSY.has(task.status) || task.status === 'waiting_workflow') this.ctx.scheduler.cancelTask(task, state);
  }
}
