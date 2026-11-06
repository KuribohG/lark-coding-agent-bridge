import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hostToolInstructions, WORKFLOW_TOOL_INSTRUCTIONS, workflowWorkerInstructions } from '../src/engine/ipc';
import { WorkflowKernel } from '../src/engine/kernel';
import { stopReasonOf, WorkflowRuntime, type WorkerRunSpec, type WorkflowRoot } from '../src';
import type { ExecutionObservation, WorkflowTask, WorkflowWorkerRequest, WorkflowWorkerResult } from '../src/engine/types';

type Grant = { claimId: string; generation: number };
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const root: WorkflowRoot = { scopeId: 'governed', profile: 'default', agentKind: 'codex', cwdRealpath: '/workspace',
  policyFingerprint: 'policy', catalogBinding: 'root', modelSettings: {} };

/** A kernel whose native turns outlive cancellation until the test settles them. */
async function harness(options: { ledger?: boolean; path?: string } = {}) {
  let now = 1_000_000;
  const receipts = new Map<string, ExecutionObservation>();
  const lookups = new Set<string>();
  const requests: WorkflowWorkerRequest[] = [];
  const finishers = new Map<string, (result: WorkflowWorkerResult) => void>();
  const host = { resolveRoot: async () => root, wakeMain: async () => {},
    ...(options.ledger === false ? {} : { executionLedger: { lookupExecution: async (id: string, scopeId: string) => {
      lookups.add(scopeId);
      return receipts.get(id) ?? { state: 'not-submitted' as const, proof: 'fixture' };
    } } }),
    execute: async (request: WorkflowWorkerRequest) => {
      requests.push(request);
      request.onRun('run-' + request.attemptId);
      request.onSession('native-' + request.session.sessionRef);
      return new Promise<WorkflowWorkerResult>(resolve => {
        finishers.set(request.attemptId, resolve);
        // A cancelled turn may outlive its signal; only process shutdown ends this fixture on its own.
        request.signal.addEventListener('abort', () => {
          if (stopReasonOf(request.signal) === 'shutdown') resolve({ status: 'stopped', stopReason: 'shutdown', quiescence: 'unknown' });
        }, { once: true });
      });
    } };
  const open = async () => {
    const opened = new WorkflowKernel(options.path ?? ':memory:', host, () => now);
    await opened.reconcileExecutions();
    return opened;
  };
  let kernel = await open();
  cleanup.push(async () => {
    for (const finish of finishers.values()) finish({ status: 'stopped', quiescence: 'quiescent' });
    await kernel.close();
  });
  let workflowId: string | undefined;
  const state = () => {
    const current = workflowId ? kernel.state(root.scopeId, workflowId) : kernel.state(root.scopeId);
    workflowId = current?.workflowId;
    return current!;
  };
  const call = (method: string, args: Record<string, unknown> = {}) => kernel.call({ kind: 'main', scopeId: root.scopeId, allowStart: true }, method,
    { operationId: randomUUID(), workflowId: state()?.workflowId, expectedStateVersion: state()?.stateVersion, ...args });
  const worker = (request: WorkflowWorkerRequest, method: string, args: Record<string, unknown> = {}) => kernel.call({ kind: 'worker',
    scopeId: root.scopeId, workflowId: state().workflowId, taskId: request.task.taskId, attemptId: request.attemptId }, method,
  { operationId: randomUUID(), ...args });
  const claimed = async () => {
    await call('run_script', { goal: 'Consume work', plan: 'One member consumes one item.', script: 'return null;' });
    kernel.beginScript(root.scopeId, state().workflowId);
    await kernel.scriptWork(root.scopeId, state().workflowId, state().script!.runId, { kind: 'enqueue', key: 'item', title: 'Item' });
    await kernel.scriptAgent(root.scopeId, state().workflowId, state().script!.runId, { key: 'member', member: 'A', prompt: 'Consume the queue' });
    await kernel.tick();
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    const request = requests[0]!;
    await vi.waitFor(() => expect(state().tasks[0]!.status).toBe('running'));
    return { request, grant: await worker(request, 'claim_work') as Grant };
  };
  return { get kernel() { return kernel; }, state, call, worker, requests, receipts, lookups, finishers, claimed,
    advance: (milliseconds: number) => { now += milliseconds; },
    deadline: () => state().deadlineAt - now,
    restart: async () => { await kernel.close(); kernel = await open(); },
    settle: (status: string) => vi.waitFor(() => expect(state().tasks[0]!.status).toBe(status)) };
}

describe('workflow kernel with a host execution ledger', () => {
  it('freezes a claim on cancel until the old native turn proves quiescence', async () => {
    const h = await harness();
    const { request, grant } = await h.claimed();
    await h.call('cancel');
    expect(h.state()).toMatchObject({ status: 'cancelling' });
    expect(h.state().tasks[0]!.status).toBe('cancelling');
    expect(h.state().workQueue!.claims[0]).toMatchObject({ status: 'active', frozen: true });
    expect(h.state().workQueue!.items[0]!.status).toBe('claimed');
    await expect(h.worker(request, 'complete_work', { ...grant, result: 'late' })).rejects.toThrow();

    h.finishers.get(request.attemptId)!({ status: 'stopped', quiescence: 'quiescent' });
    await h.settle('cancelled');
    expect(h.state().status).toBe('cancelled');
    expect(h.state().workQueue!.items[0]!.status).toBe('cancelled');
    expect(h.state().workQueue!.claims[0]!.status).not.toBe('active');
    expect([...h.lookups]).toEqual([root.scopeId]);
  });

  it('cancels at once and releases the claim for a host without a ledger', async () => {
    const h = await harness({ ledger: false });
    const { request } = await h.claimed();
    await h.call('cancel');
    expect(h.state().status).toBe('cancelled');
    expect(h.state().workQueue!.claims[0]!.status).toBe('cancelled');
    expect(h.state().workQueue!.items[0]!.status).toBe('cancelled');
    h.finishers.get(request.attemptId)!({ status: 'completed', text: 'late' });
    await h.settle('cancelled');
  });

  it('keeps a turn unknown until the host proves it was never submitted', async () => {
    const h = await harness();
    const { request } = await h.claimed();
    const executionId = h.state().tasks[0]!.attempts[0]!.executionId!;
    await h.call('cancel');
    h.receipts.set(executionId, { state: 'unknown', reason: 'native settlement lost' });
    h.finishers.get(request.attemptId)!({ status: 'stopped', quiescence: 'unknown', error: 'native settlement lost' });
    await h.settle('unknown');
    expect(h.state()).toMatchObject({ status: 'cancelling' });
    expect(h.state().workQueue!.claims[0]).toMatchObject({ status: 'active', frozen: true });

    h.receipts.set(executionId, { state: 'not-submitted', proof: 'host proof' });
    await h.kernel.reconcileExecutions();
    await h.settle('cancelled');
    expect(h.state().status).toBe('cancelled');
  });

  it('marks a submitted attempt unknown across a restart and settles its durable completion once', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'governed-execution-'));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const h = await harness({ path: join(directory, 'workflow.sqlite') });
    await h.claimed();
    const executionId = h.state().tasks[0]!.attempts[0]!.executionId!;
    h.receipts.set(executionId, { state: 'unknown' });
    await h.restart();
    expect(h.state().tasks[0]).toMatchObject({ status: 'unknown', quiescence: 'unknown' });
    expect(h.requests).toHaveLength(1);

    const result: WorkflowWorkerResult = { status: 'completed', quiescence: 'quiescent', text: 'stored answer' };
    h.receipts.set(executionId, { state: 'completed', result });
    await h.kernel.reconcileExecutions();
    expect(h.state().tasks[0]).toMatchObject({ status: 'result_ready' });
    expect(h.state().tasks[0]!.resultRefs).toHaveLength(1);
    await expect(h.kernel.notifyExecution(root.scopeId, h.state().workflowId, executionId))
      .resolves.toMatchObject({ state: 'completed', accepted: true });
    expect(h.state().tasks[0]!.resultRefs).toHaveLength(1);
    h.receipts.set(executionId, { state: 'completed', result: { ...result, text: 'changed' } });
    await expect(h.kernel.notifyExecution(root.scopeId, h.state().workflowId, executionId)).rejects.toThrow('completion changed');
    expect(h.requests).toHaveLength(1);
  });

  it.each([[true, 'deadline', true], [false, undefined, undefined]])('fails a script at its deadline (ledger %s)', async (ledger, stopReason, frozen) => {
    const h = await harness({ ledger });
    await h.claimed();
    h.advance(h.deadline() + 1);
    await h.kernel.tick();
    expect(h.state().script).toMatchObject({ status: 'failed', error: 'Workflow deadline reached' });
    expect(h.state().script!.stopReason).toBe(stopReason);
    expect(h.state().workQueue!.claims[0]!.frozen).toBe(frozen);
  });

  it('never expires a claim from under a running governed turn', async () => {
    const h = await harness();
    const { request } = await h.claimed();
    h.advance(h.state().workQueue!.claims[0]!.leaseUntil - 1_000_000 + 1);
    await h.kernel.tick();
    expect(h.state().workQueue!.claims[0]).toMatchObject({ status: 'active', frozen: true });
    expect(h.state().workQueue!.items[0]!.status).toBe('claimed');
    expect(h.state().tasks[0]!.status).toBe('cancelling');
    expect(request.signal.aborted).toBe(true);
  });
});

describe('workflow runtime with host tools', () => {
  it('names no shell CLI in any instruction', () => {
    const member = { agentId: 'member', workflowTool: true } as WorkflowTask;
    const oneShot = {} as WorkflowTask;
    for (const text of [WORKFLOW_TOOL_INSTRUCTIONS, workflowWorkerInstructions(member), workflowWorkerInstructions(oneShot)]) {
      expect(hostToolInstructions(text)).not.toContain('AGENT_WORKFLOW_CLI');
    }
    expect(hostToolInstructions(WORKFLOW_TOOL_INSTRUCTIONS)).toContain('workflow_call');
    expect(hostToolInstructions(workflowWorkerInstructions(member))).toContain('workflow_call({method:"run_workflow"');
  });

  it('gives a governed worker one native turn, a host tool and input references it can read', async () => {
    const receipts = new Map<string, ExecutionObservation>();
    const specs: WorkerRunSpec[] = [];
    const runtime = new WorkflowRuntime({
      path: ':memory:', hostTools: true, resolveRoot: async () => root, wakeMain: async () => {},
      executionLedger: { lookupExecution: async id => receipts.get(id) ?? { state: 'not-submitted', proof: 'fixture' } },
      runner: {
        async start(spec) {
          specs.push(spec);
          await spec.validateBeforeRun();
          const text = specs.length === 1 ? 'first answer' : 'not json';
          return {
            runId: `run-${specs.length}`, result: Promise.resolve('completed'), stop: async () => {},
            waitForExit: async () => false, waitForQuiescence: async () => ({ state: 'quiescent' }), stopReason: () => undefined,
            async *events() {
              yield { type: 'session', nativeSessionId: `native-${specs.length}` };
              yield { type: 'final_text', text };
              receipts.set(spec.executionId, { state: 'completed', result: { status: 'completed', quiescence: 'quiescent', text } });
              yield { type: 'done', normal: true };
            },
          };
        },
      },
    });
    await runtime.start();
    cleanup.push(() => runtime.close());
    const main = runtime.bindMain(root.scopeId, 'start');
    expect(main.env).toEqual({});
    expect(main.instructions).not.toContain('AGENT_WORKFLOW_CLI');
    await main.call!('run_script', { operationId: randomUUID(), goal: 'read', plan: 'One worker reads the result of another.',
      script: 'const first = await agent("first", {key:"a"}); return await agent("second", {key:"b", inputs:["a"], output:"json"});' });
    await vi.waitFor(async () => {
      await runtime.tick();
      expect(runtime.kernel.state(root.scopeId)!.tasks.map(task => task.status)).toEqual(['result_ready', expect.stringMatching(/^(result_ready|failed)$/)]);
    });
    expect(specs).toHaveLength(2);
    for (const spec of specs) {
      expect(spec.env).toEqual({});
      expect(spec.systemPrompt).not.toContain('AGENT_WORKFLOW_CLI');
      expect(spec.workflowTools!.definitions).toHaveLength(1);
    }
    expect(specs[1]!.prompt).toContain('workflow_call({method:"read_artifact"');
    expect(specs[1]!.prompt).not.toContain('AGENT_WORKFLOW_CLI');
  });
});
