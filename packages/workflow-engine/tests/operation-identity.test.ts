import { afterEach, describe, expect, it } from 'vitest';
import { WorkflowKernel } from '../src/engine/kernel';
import type { WorkflowRoot, WorkflowWorkerRequest, WorkflowWorkerResult } from '../src/engine/types';

const cleanup: Array<() => unknown> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

function harness(): WorkflowKernel {
  const root: WorkflowRoot = { scopeId: 'operation-scope', profile: 'default', agentKind: 'codex', cwdRealpath: '/workspace',
    policyFingerprint: 'policy', catalogBinding: 'root', modelSettings: {} };
  const host = {
    resolveRoot: async () => root,
    wakeMain: async () => {},
    execute: async (request: WorkflowWorkerRequest): Promise<WorkflowWorkerResult> =>
      new Promise(resolve => request.signal.addEventListener('abort', () => resolve({ status: 'stopped' }), { once: true })),
  };
  const kernel = new WorkflowKernel(':memory:', host, () => 1_000);
  cleanup.push(() => kernel.close());
  return kernel;
}

describe('operation identity', () => {
  it('lets a reused operationId start the next workflow once the previous one finished', async () => {
    const kernel = harness();
    const caller = { kind: 'main' as const, scopeId: 'operation-scope', allowStart: true };
    const start = { operationId: 'fixed-id', goal: 'goal', plan: 'plan', script: 'return 1;', maxConcurrent: 1 };
    await kernel.call(caller, 'run_script', { ...start });
    const first = kernel.state('operation-scope')!.workflowId;
    const version = kernel.state('operation-scope')!.stateVersion;
    await kernel.call(caller, 'cancel', { operationId: 'cancel-first', workflowId: first, expectedStateVersion: version });
    expect(kernel.state('operation-scope')).toBeUndefined();

    await kernel.call(caller, 'run_script', { ...start });
    const second = kernel.state('operation-scope');
    expect(second).toBeDefined();
    expect(second!.workflowId).not.toBe(first);
    expect(second!.status).toBe('active');
  });

  it('still answers a retry of the same operation on the same workflow', async () => {
    const kernel = harness();
    const caller = { kind: 'main' as const, scopeId: 'operation-scope', allowStart: true };
    const start = { operationId: 'fixed-id', goal: 'goal', plan: 'plan', script: 'return 1;', maxConcurrent: 1 };
    const response = await kernel.call(caller, 'run_script', { ...start });
    const workflowId = kernel.state('operation-scope')!.workflowId;
    const retried = await kernel.call(caller, 'run_script', { ...start });
    expect(retried).toEqual(response);
    expect(kernel.state('operation-scope')!.workflowId).toBe(workflowId);
  });

  it('rejects the same Id with different content on the same workflow', async () => {
    const kernel = harness();
    const caller = { kind: 'main' as const, scopeId: 'operation-scope', allowStart: true };
    await kernel.call(caller, 'run_script', { operationId: 'fixed-id', goal: 'goal', plan: 'plan', script: 'return 1;', maxConcurrent: 1 });
    const workflowId = kernel.state('operation-scope')!.workflowId;
    await expect(kernel.call(caller, 'pause', { operationId: 'fixed-id', workflowId, expectedStateVersion: kernel.state('operation-scope')!.stateVersion }))
      .rejects.toThrow('operationId conflict');
  });
});
