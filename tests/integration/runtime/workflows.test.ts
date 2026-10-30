import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkflowRuntime } from '../../../src/workflows/runtime';
import { callWorkflow, WorkflowIpc } from '../../../src/workflows/ipc';
import { RunExecutor } from '../../../src/runtime/run-executor';
import { ProcessPool } from '../../../src/runtime/process-pool';
import { ActiveRuns } from '../../../src/runtime/active-runs';
import { FakeAgentAdapter } from '../../helpers/fake-agent';
import type { WorkflowRoot } from '../../../src/workflows/types';
import type { RunPolicyAllow } from '../../../src/policy/run-policy';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });

describe('workflow IPC and worker execution', () => {
  it('authenticates from a per-run binding, ignores forged scope args, and revokes at turn end', async () => {
    const call = vi.fn(async (caller, method, args) => ({ caller, method, args }));
    const ipc = new WorkflowIpc(call); await ipc.listen(); cleanup.push(() => ipc.close());
    const binding = ipc.bind({ kind: 'main', scopeId: 'authorized-topic' }, Date.now() + 60_000);
    const response = await callWorkflow('status', { scopeId: 'other-topic', kind: 'main' }, binding.env);
    expect(response).toMatchObject({ caller: { kind: 'main', scopeId: 'authorized-topic' } });
    binding.release();
    await expect(callWorkflow('status', {}, binding.env)).rejects.toThrow('revoked');
    expect(call).toHaveBeenCalledTimes(1);
    const expired = ipc.bind({ kind: 'main', scopeId: 'authorized-topic' }, Date.now() - 1);
    await expect(callWorkflow('status', {}, expired.env)).rejects.toThrow('expired');
  });

  it('collects final output with native identity after the main binding ends', async () => {
    const root: WorkflowRoot = { scopeId: 'real-topic', profile: 'default', agentKind: 'codex', cwdRealpath: '/workspace',
      policyFingerprint: 'policy', catalogBinding: 'root', modelSettings: { model: 'model' } };
    const policy: RunPolicyAllow = { ok: true, prompt: '', requestedCwd: '/workspace', cwdRealpath: '/workspace',
      accessMode: 'full', sandbox: 'danger-full-access', permissionMode: 'bypassPermissions',
      access: { ok: true, reason: 'allowed-user' }, attachments: [], policyFingerprint: 'policy', expiresAt: Date.now() + 60_000 };
    const agent = new FakeAgentAdapter({ id: 'codex', capabilities: { finalAnswer: 'separate-event', input: 'unsupported' }, events: [
      [{ type: 'system', threadId: 'child-1' }, { type: 'text', delta: 'progress must not become the result' },
        { type: 'final_text', content: 'proposal' }, { type: 'done', terminationReason: 'normal' }],
    ] });
    const resolveAgent = vi.fn(() => agent);
    const executor = new RunExecutor({ resolveAgent, pool: new ProcessPool(() => 3), activeRuns: new ActiveRuns() });
    const wakeMain = vi.fn(async () => {});
    const runtime = new WorkflowRuntime({ path: ':memory:', executor, resolve: async () => ({ root, policy }), wakeMain });
    await runtime.start(); cleanup.push(() => runtime.close());
    const main = runtime.bindMain(root.scopeId);
    const call = (method: string, args: Record<string, unknown> = {}) => callWorkflow(method,
      { operationId: randomUUID(), expectedStateVersion: runtime.kernel.state(root.scopeId)?.stateVersion, ...args }, main.env);
    await call('run_script', { goal: 'test design', script: 'return await agent("design A",{key:"a"});' });
    main.release(); // Child lifetime is independent of the parent CLI turn.
    await runtime.tick();
    await vi.waitFor(async () => { await runtime.tick(); expect(runtime.kernel.state(root.scopeId)?.script?.status).toBe('result_ready'); });
    const state = runtime.kernel.state(root.scopeId)!;
    expect(resolveAgent).toHaveBeenCalledWith('real-topic', 'codex');
    expect(agent.runOptions[0]?.threadId).toBeUndefined();
    expect(agent.runOptions[0]?.env?.LARK_WORKFLOW_TOKEN).not.toEqual(main.env.LARK_WORKFLOW_TOKEN);
    expect(state.sessions[0]?.nativeSessionId).toBe('child-1');
    expect(state.artifacts.find(a => a.taskId)?.text).toBe('proposal');
    await runtime.kernel.tick(); expect(wakeMain).toHaveBeenCalledWith('real-topic');
    await expect(callWorkflow('task_status', {}, agent.runOptions[0]!.env)).rejects.toThrow('revoked');
  });
});
