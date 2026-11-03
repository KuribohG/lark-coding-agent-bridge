import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { callWorkflow, WorkflowRuntime, type WorkerRunSpec, type WorkflowRoot } from '../../../src/workflows';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });

describe('workflow engine without bridge services', () => {
  it('runs a script through a host-supplied runner and resumes the native session for members', async () => {
    const root: WorkflowRoot = { scopeId: 'chat', profile: 'embedded', agentKind: 'custom-agent', cwdRealpath: '/repo',
      policyFingerprint: 'policy', catalogBinding: 'main', modelSettings: { model: 'm1', reasoningEffort: 'deep' } };
    const specs: WorkerRunSpec[] = [];
    const wakeMain = vi.fn(async () => {});
    const runtime = new WorkflowRuntime({
      path: ':memory:', resolveRoot: async () => root, wakeMain,
      checkSelection: selection => { if (selection.agentKind !== 'custom-agent') throw new Error('unsupported harness'); },
      runner: {
        async start(spec) {
          specs.push(spec);
          await spec.validateBeforeRun();
          return {
            runId: `run-${specs.length}`, result: Promise.resolve('completed'),
            stop: async () => {}, waitForExit: async () => true, stopReason: () => undefined,
            async *events() {
              yield { type: 'session', nativeSessionId: spec.resume?.id ?? 'native-1' };
              yield { type: 'final_text', text: `answer ${specs.length}` };
              yield { type: 'done', normal: true };
            },
          };
        },
      },
    });
    await runtime.start(); cleanup.push(() => runtime.close());
    const main = runtime.bindMain(root.scopeId, 'start');
    await callWorkflow('run_script', { operationId: randomUUID(), goal: 'embed', plan: 'One member answers twice; return both answers.',
      script: 'const a = await agent("first", {key:"a", member:"m"}); const b = await agent("second", {key:"b", member:"m"}); return a + "|" + b;' }, main.env);
    main.release();
    await vi.waitFor(async () => { await runtime.tick(); expect(runtime.kernel.state(root.scopeId)?.script).toMatchObject({ status: 'result_ready' }); });
    const state = runtime.kernel.state(root.scopeId)!;
    expect(state.artifacts.find(artifact => artifact.ref === state.script?.resultRef)?.text).toBe(JSON.stringify('answer 1|answer 2'));
    expect(specs.map(spec => spec.resume)).toEqual([undefined, { kind: 'sessionId', id: 'native-1' }]);
    expect(specs[0]).toMatchObject({ prompt: expect.stringContaining('first'), execution: { agentKind: 'custom-agent', modelSettings: { reasoningEffort: 'deep' } } });
    expect(specs[0]!.env.LARK_WORKFLOW_TOKEN).toBeTruthy();
    await expect(callWorkflow('run_script', { operationId: randomUUID(), goal: 'x', plan: 'x', script: 'return 1;' }, specs[0]!.env)).rejects.toThrow();
    await runtime.kernel.tick(); expect(wakeMain).toHaveBeenCalledWith('chat');
  });

  it('rejects worktrees unless the host authorizes them', async () => {
    const root: WorkflowRoot = { scopeId: 'chat', profile: 'embedded', agentKind: 'custom-agent', cwdRealpath: '/repo',
      policyFingerprint: 'policy', catalogBinding: 'main', modelSettings: {} };
    const runtime = new WorkflowRuntime({ path: ':memory:', workspaceRoot: '/nonexistent', resolveRoot: async () => root, wakeMain: async () => {},
      runner: { start: async () => { throw new Error('unused'); } } });
    await runtime.start(); cleanup.push(() => runtime.close());
    const main = runtime.bindMain(root.scopeId, 'start');
    await callWorkflow('run_script', { operationId: randomUUID(), goal: 'ws', plan: 'Create a worktree and return its id.',
      script: 'return (await createWorkspace({key:"w"})).id;' }, main.env);
    main.release();
    await vi.waitFor(async () => { await runtime.tick(); expect(runtime.kernel.state(root.scopeId)?.script?.status).toBe('failed'); });
    expect(runtime.kernel.state(root.scopeId)?.script?.error).toContain('unavailable in this host');
  });
});
