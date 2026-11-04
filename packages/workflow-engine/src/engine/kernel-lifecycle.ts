import { consumerPools } from './work-routing';
import { cancelWork, freezeWorkClaims } from './work-queue';
import { BUSY, pushEvent } from './kernel-state';
import type { KernelContext } from './kernel-context';
import type { WorkflowState } from './types';

/** Whole-workflow transitions the main agent and the scheduler share: wake-ups, invalidation and cancellation. */
export class WorkflowLifecycle {
  constructor(private readonly ctx: KernelContext) {}

  hasWake(scopeId: string): boolean {
    const state = this.ctx.store.state(scopeId);
    return Boolean(state && ['active', 'paused'].includes(state.status) && state.events.some(event => !event.acknowledged && !event.notified));
  }

  markNotified(scopeId: string, ids: string[]): void {
    const state = this.ctx.store.state(scopeId);
    if (!state) return;
    for (const event of state.events) if (ids.includes(event.id) && !event.notified) { event.notified = true; event.notifiedAt = this.ctx.now(); }
    this.ctx.store.save(state);
  }

  invalidate(scopeId: string): void {
    const state = this.ctx.store.state(scopeId);
    if (!state || ['binding_attention', 'interrupted'].includes(state.status)) return;
    this.ctx.children.suspendChildren(state,false);
    state.status = 'binding_attention';
    if (state.script) state.script.status = 'interrupted';
    for (const pool of consumerPools(state)) pool.status = 'suspended';
    for (const task of state.tasks) if (BUSY.has(task.status) || task.status==='waiting_workflow') this.ctx.scheduler.cancelTask(task, state);
    pushEvent(state, { kind: 'binding_attention', summary: 'Root session, engine, workspace or policy changed; new delegation stopped.' }, this.ctx.now);
    this.ctx.store.save(state);
  }

  cancel(scopeId: string): boolean {
    const state = this.ctx.store.state(scopeId);
    if (!state) return false;
    this.cancelState(state);
    this.ctx.store.save(state);
    return true;
  }

  cancelState(state: WorkflowState): void {
    this.ctx.children.suspendChildren(state,true);
    state.status = 'cancelling';
    if (state.script) state.script.status = 'cancelled';
    for (const pool of consumerPools(state)) pool.status = 'cancelled';
    freezeWorkClaims(state, 'Workflow admission revoked; native quiescence is pending');
    cancelWork(state, this.ctx.now(), true);
    for (const task of state.tasks) if (BUSY.has(task.status) || task.status === 'waiting_input' || task.status==='waiting_workflow') this.ctx.scheduler.cancelTask(task, state);
    if (!state.tasks.some(task => ['cancelling', 'unknown'].includes(task.status))) {
      state.status = 'cancelled'; cancelWork(state, this.ctx.now());
    }
  }

  pause(state: WorkflowState): void {
    this.ctx.children.suspendChildren(state,false);
    state.status = 'paused';
    state.script!.status = 'paused';
    for (const pool of consumerPools(state)) pool.status = 'suspended';
    for (const task of state.tasks) if (BUSY.has(task.status) || task.status === 'waiting_workflow') this.ctx.scheduler.cancelTask(task, state);
  }
}
