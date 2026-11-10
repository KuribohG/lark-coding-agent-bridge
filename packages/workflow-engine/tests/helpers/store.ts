import type { WorkflowKernel } from '../../src/engine/kernel';
import type { WorkflowStore } from '../../src/engine/kernel-store';
import type { WorkflowState } from '../../src/engine/types';

/** The store behind a kernel, which the kernel itself does not expose. */
export function storeOf(kernel: WorkflowKernel): WorkflowStore {
  return (kernel as unknown as { ctx: { store: WorkflowStore } }).ctx.store;
}

/** Makes a workflow of a running kernel exactly `state`, for conditions the public operations cannot produce. */
export function overwriteState(kernel: WorkflowKernel, state: WorkflowState): void {
  const store = storeOf(kernel);
  store.transact(() => store.replace(state), 'test');
}
