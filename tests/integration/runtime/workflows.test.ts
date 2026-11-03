import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBridgeWorkflowRuntime } from '../../../src/workflows/bridge/runtime';
import { callWorkflow } from '@kuribohg/agent-workflows';
import { RunExecutor } from '../../../src/runtime/run-executor';
import { ProcessPool } from '../../../src/runtime/process-pool';
import { ActiveRuns } from '../../../src/runtime/active-runs';
import { FakeAgentAdapter } from '../../helpers/fake-agent';
import type { WorkflowRoot } from '@kuribohg/agent-workflows';
import type { RunPolicyAllow } from '../../../src/policy/run-policy';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });

describe('workflow IPC and worker execution', () => {
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
    const runtime = createBridgeWorkflowRuntime({ path: ':memory:', executor, resolve: async () => ({ root, policy }), wakeMain });
    await runtime.start(); cleanup.push(() => runtime.close());
    const main = runtime.bindMain(root.scopeId, 'start');
    const call = (method: string, args: Record<string, unknown> = {}) => callWorkflow(method,
      { operationId: randomUUID(), expectedStateVersion: runtime.kernel.state(root.scopeId)?.stateVersion, ...(method === 'run_script' || method === 'replay_script' ? {plan:'Review the task with the requested harness and model; return a final result.'} : {}), ...args }, main.env);
    await call('run_script', { goal: 'test design', script: 'return await agent("design A",{key:"a"});' });
    main.release(); // Child lifetime is independent of the parent CLI turn.
    await runtime.tick();
    await vi.waitFor(async () => { await runtime.tick(); expect(runtime.kernel.state(root.scopeId)?.script?.status).toBe('result_ready'); });
    const state = runtime.kernel.state(root.scopeId)!;
    expect(resolveAgent).toHaveBeenCalledWith('real-topic', 'codex');
    expect(agent.runOptions[0]?.threadId).toBeUndefined();
    expect(agent.runOptions[0]?.env?.AGENT_WORKFLOW_TOKEN).not.toEqual(main.env.AGENT_WORKFLOW_TOKEN);
    expect(state.sessions[0]?.nativeSessionId).toBe('child-1');
    expect(state.artifacts.find(a => a.taskId)?.text).toBe('proposal');
    await runtime.kernel.tick(); expect(wakeMain).toHaveBeenCalledWith('real-topic');
    await expect(callWorkflow('task_status', {}, agent.runOptions[0]!.env)).rejects.toThrow('revoked');
  });
});
