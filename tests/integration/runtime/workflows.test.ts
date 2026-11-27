import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBridgeWorkflowRuntime } from '../../../src/workflows/bridge/runtime';
import { callWorkflow } from '@kuribohg/agent-workflows';
import { RunExecutor } from '../../../src/runtime/run-executor';
import { ProcessPool } from '../../../src/runtime/process-pool';
import { ActiveRuns } from '../../../src/runtime/active-runs';
import { FakeAgentAdapter } from '../../helpers/fake-agent';
import type { AgentEvent, AgentRun, AgentRunOptions } from '../../../src/agent/types';
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
    await expect(callWorkflow('read_context', {}, agent.runOptions[0]!.env)).rejects.toThrow('revoked');
    // A host that names no signal cells leaves its workers unconfined, and tells them nothing about signals.
    expect(agent.runOptions[0]?.signalCell).toBeUndefined();
    expect(agent.runOptions[0]?.systemPrompt).not.toContain('Signals:');
  });

  it('starts every turn of a worker session in the signal cell of that session', async () => {
    const root: WorkflowRoot = { scopeId: 'cell-topic', profile: 'default', agentKind: 'codex', cwdRealpath: '/workspace',
      policyFingerprint: 'policy', catalogBinding: 'root', modelSettings: { model: 'model' } };
    const policy: RunPolicyAllow = { ok: true, prompt: '', requestedCwd: '/workspace', cwdRealpath: '/workspace',
      accessMode: 'full', sandbox: 'danger-full-access', permissionMode: 'bypassPermissions',
      access: { ok: true, reason: 'allowed-user' }, attachments: [], policyFingerprint: 'policy', expiresAt: Date.now() + 60_000 };
    const answer = (text: string): AgentEvent[] => [{ type: 'system', threadId: text }, { type: 'final_text', content: text },
      { type: 'done', terminationReason: 'normal' }];
    const agent = new FakeAgentAdapter({ id: 'codex', capabilities: { finalAnswer: 'separate-event', input: 'unsupported' },
      events: [answer('a'), answer('b')] });
    const executor = new RunExecutor({ resolveAgent: () => agent, pool: new ProcessPool(() => 3), activeRuns: new ActiveRuns() });
    const runtime = createBridgeWorkflowRuntime({ path: ':memory:', executor, resolve: async () => ({ root, policy }), wakeMain: async () => {},
      signalCell: sessionKey => ({ id: sessionKey, log: '/state/signal-cell.log' }) });
    await runtime.start(); cleanup.push(() => runtime.close());
    const main = runtime.bindMain(root.scopeId, 'start');
    await callWorkflow('run_script', { operationId: randomUUID(), plan: 'Ask two workers.', goal: 'two workers',
      script: 'return await Promise.all([agent("first",{key:"a"}), agent("second",{key:"b"})]);' }, main.env);
    main.release();
    await vi.waitFor(async () => { await runtime.tick(); expect(runtime.kernel.state(root.scopeId)?.script?.status).toBe('result_ready'); });
    const state = runtime.kernel.state(root.scopeId)!;
    const cells = agent.runOptions.map(options => options.signalCell);
    // One cell for each session, named like the session, so no two workers share one.
    expect(cells.map(cell => cell?.id).sort()).toEqual(state.sessions.map(session => `workflow:${state.workflowId}:${session.sessionRef}`).sort());
    expect(new Set(cells.map(cell => cell?.id)).size).toBe(2);
    expect(cells.every(cell => cell?.log === '/state/signal-cell.log')).toBe(true);
    // A worker is told what a refused signal means before it meets one.
    for (const options of agent.runOptions) expect(options.systemPrompt).toContain('`Operation not permitted` from kill or pkill means');
  });

  it('does not take a run held for its background tasks as a stalled worker', async () => {
    const root: WorkflowRoot = { scopeId: 'held-topic', profile: 'default', agentKind: 'claude', cwdRealpath: '/workspace',
      policyFingerprint: 'policy', catalogBinding: 'root', modelSettings: { model: 'model' } };
    const policy: RunPolicyAllow = { ok: true, prompt: '', requestedCwd: '/workspace', cwdRealpath: '/workspace',
      accessMode: 'full', sandbox: 'danger-full-access', permissionMode: 'bypassPermissions',
      access: { ok: true, reason: 'allowed-user' }, attachments: [], policyFingerprint: 'policy', expiresAt: Date.now() + 60_000 };
    // The turn has ended and the process waits, silent, for a background task well past the stall limit.
    class HeldAgent extends FakeAgentAdapter {
      override run(opts: AgentRunOptions): AgentRun {
        this.runOptions.push(opts);
        let stopped = false;
        async function* events(): AsyncIterable<AgentEvent> {
          yield { type: 'system', sessionId: 'held-1' };
          yield { type: 'text', delta: 'answer' };
          yield { type: 'status', code: 'background_tasks', content: 'waiting' };
          await new Promise(resolve => setTimeout(resolve, 400));
          if (stopped) { yield { type: 'done', terminationReason: 'interrupted' }; return; }
          yield { type: 'final_text', content: 'answer' };
          yield { type: 'done', terminationReason: 'normal' };
        }
        return { runId: opts.runId, capabilities: this.capabilities, events: events(),
          stop: async () => { stopped = true; }, waitForExit: async () => true };
      }
    }
    const agent = new HeldAgent({ id: 'claude', capabilities: { finalAnswer: 'separate-event', input: 'unsupported' } });
    const executor = new RunExecutor({ resolveAgent: () => agent, pool: new ProcessPool(() => 3), activeRuns: new ActiveRuns() });
    const runtime = createBridgeWorkflowRuntime({ path: ':memory:', executor, resolve: async () => ({ root, policy }), wakeMain: async () => {}, stallMs: 80 });
    await runtime.start(); cleanup.push(() => runtime.close());
    const main = runtime.bindMain(root.scopeId, 'start');
    await callWorkflow('run_script', { operationId: randomUUID(), goal: 'held', plan: 'One worker answers after its background task ends.',
      script: 'return await agent("work",{key:"a"});' }, main.env);
    main.release();
    await vi.waitFor(async () => { await runtime.tick(); expect(runtime.kernel.state(root.scopeId)?.script?.status).toBe('result_ready'); }, { timeout: 4_000, interval: 20 });
    const task = runtime.kernel.state(root.scopeId)!.tasks[0]!;
    expect(task.attempts).toHaveLength(1);
    expect(agent.runOptions).toHaveLength(1);
  });

  /** One worker whose agent emits `script`, run until `settled` holds; `stopped()` turns true once the runtime stops the run. */
  async function runWorker(scopeId: string, script: (stopped: () => boolean, run: number) => AsyncIterable<AgentEvent>,
    limits: { stallMs: number; toolOverdueGraceMs?: number },
    settled: (state: NonNullable<ReturnType<ReturnType<typeof createBridgeWorkflowRuntime>['kernel']['state']>>) => boolean
      = state => state.script?.status === 'result_ready') {
    const root: WorkflowRoot = { scopeId, profile: 'default', agentKind: 'pi', cwdRealpath: '/workspace',
      policyFingerprint: 'policy', catalogBinding: 'root', modelSettings: { model: 'model' } };
    const policy: RunPolicyAllow = { ok: true, prompt: '', requestedCwd: '/workspace', cwdRealpath: '/workspace',
      accessMode: 'full', sandbox: 'danger-full-access', permissionMode: 'bypassPermissions',
      access: { ok: true, reason: 'allowed-user' }, attachments: [], policyFingerprint: 'policy', expiresAt: Date.now() + 60_000 };
    class ScriptedAgent extends FakeAgentAdapter {
      override run(opts: AgentRunOptions): AgentRun {
        this.runOptions.push(opts);
        let stopped = false;
        return { runId: opts.runId, capabilities: this.capabilities, events: script(() => stopped, this.runOptions.length),
          stop: async () => { stopped = true; }, waitForExit: async () => true };
      }
    }
    const agent = new ScriptedAgent({ id: 'pi', capabilities: { finalAnswer: 'separate-event', input: 'unsupported' } });
    const executor = new RunExecutor({ resolveAgent: () => agent, pool: new ProcessPool(() => 3), activeRuns: new ActiveRuns() });
    const runtime = createBridgeWorkflowRuntime({ path: ':memory:', executor, resolve: async () => ({ root, policy }), wakeMain: async () => {}, ...limits });
    await runtime.start(); cleanup.push(() => runtime.close());
    const main = runtime.bindMain(root.scopeId, 'start');
    await callWorkflow('run_script', { operationId: randomUUID(), goal: 'tools', plan: 'One worker answers after its tool calls return.',
      script: 'return await agent("work",{key:"a"});' }, main.env);
    main.release();
    await vi.waitFor(async () => { await runtime.tick(); expect(settled(runtime.kernel.state(root.scopeId)!)).toBe(true); }, { timeout: 4_000, interval: 20 });
    return { agent, task: runtime.kernel.state(root.scopeId)!.tasks[0]! };
  }
  const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

  it('keeps a run busy while another of its parallel tool calls is still out', async () => {
    // Two calls start together and the quick one returns; the slow one is silent well past the stall limit.
    const { agent, task } = await runWorker('parallel-topic', async function* (stopped) {
      yield { type: 'system', sessionId: 'parallel-1' };
      yield { type: 'tool_use', id: 'quick', name: 'bash', input: { command: 'ls' } };
      yield { type: 'tool_use', id: 'slow', name: 'bash', input: { command: 'make' } };
      yield { type: 'tool_result', id: 'quick', output: 'ok', isError: false };
      await pause(400);
      if (stopped()) { yield { type: 'done', terminationReason: 'interrupted' }; return; }
      yield { type: 'tool_result', id: 'slow', output: 'built', isError: false };
      yield { type: 'final_text', content: 'answer' };
      yield { type: 'done', terminationReason: 'normal' };
    }, { stallMs: 80 });
    expect(task.attempts).toHaveLength(1);
    expect(agent.runOptions).toHaveLength(1);
  });

  it('stops a run whose tool call stays out past the time limit its agent reported, for a retry', async () => {
    // The run never hears back from a call its agent bounds to 30 ms; the idle limit is far away.
    const { agent, task } = await runWorker('overdue-topic', async function* (stopped) {
      yield { type: 'system', sessionId: 'overdue-1' };
      yield { type: 'tool_use', id: 'hung', name: 'bash', input: { command: 'find /' }, timeoutMs: 30 };
      while (!stopped()) await pause(10);
      yield { type: 'done', terminationReason: 'interrupted' };
    }, { stallMs: 60_000, toolOverdueGraceMs: 20 }, state => state.tasks[0]?.attempts[0]?.failureKind === 'stall');
    expect(agent.runOptions).toHaveLength(1);
    expect(task.retryCount).toBe(1);
    expect(task.status).not.toBe('failed');
  });
});
