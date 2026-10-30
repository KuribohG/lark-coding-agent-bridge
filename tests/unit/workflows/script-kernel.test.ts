import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkflowKernel } from '../../../src/workflows/kernel';
import { inheritedWorkerExecution } from '../../../src/workflows/execution';
import type { WorkflowRoot, WorkflowWorkerRequest, WorkflowWorkerResult } from '../../../src/workflows/types';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
function harness(path = ':memory:') {
  const root: WorkflowRoot = { scopeId: 'script', profile: 'default', agentKind: 'codex', cwdRealpath: '/workspace',
    policyFingerprint: 'policy', catalogBinding: 'root', modelSettings: {} };
  const requests: WorkflowWorkerRequest[] = [];
  const finishes: Array<(result: WorkflowWorkerResult) => void> = [];
  let configuration = 'initial';
  const host = { resolveRoot: async () => root, wakeMain: async () => {},
    resolveWorker: async (r: WorkflowRoot, selection: Parameters<typeof inheritedWorkerExecution>[1]) => ({ ...inheritedWorkerExecution(r, selection), configurationFingerprint: configuration }),
    execute: async (request: WorkflowWorkerRequest) => {
      requests.push(request);
      request.onRun('run-' + requests.length);
      request.onSession('thread-' + requests.length);
      return new Promise<WorkflowWorkerResult>(resolve => {
        finishes.push(resolve);
        request.signal.addEventListener('abort', () => resolve({ status: 'completed', text: 'late side effect result' }), { once: true });
      });
    },
  };
  let kernel = new WorkflowKernel(path, host);
  cleanup.push(() => kernel.close());
  const state = () => kernel.state(root.scopeId)!;
  const call = (method: string, args: Record<string, unknown> = {}) => kernel.call({kind:'main',scopeId:root.scopeId},method,
    {operationId:randomUUID(), workflowId:state()?.workflowId, expectedStateVersion:state()?.stateVersion, ...args});
  const agent = (key: string, args: object = {}) => kernel.scriptAgent(root.scopeId, state().workflowId, state().script!.runId, {key, prompt:key, ...args});
  const begin = () => kernel.beginScript(root.scopeId, state().workflowId);
  const result = (taskId: string) => kernel.scriptTaskResult(root.scopeId,state().workflowId,state().script!.runId,taskId);
  return { get kernel() { return kernel; }, state, call, agent, begin, result, requests, finishes,
    configChange: () => { configuration = 'changed'; },
    restart: async () => { await kernel.close(); kernel = new WorkflowKernel(path,host); },
    start: async (args: object = {}) => { await call('run_script',{goal:'authorized test',script:'return null;', ...args}); begin(); },
    settle: async () => vi.waitFor(() => expect(state().tasks.some(t => ['starting','running','cancelling'].includes(t.status))).toBe(false)),
    finish: () => kernel.finishScript(root.scopeId,state().workflowId,state().script!.runId,{text:'null'}),
  };
}

describe('script kernel lifecycle', () => {
  it('surfaces native questions as actionable script failures without waking main per worker', async () => {
    const h = harness(); await h.start(); const call = await h.agent('question'); await h.kernel.tick();
    await vi.waitFor(() => expect(h.finishes).toHaveLength(1));
    h.finishes[0]!({status:'stopped',question:'Which repository should I inspect?'}); await h.settle();
    expect(() => h.result(call.taskId)).toThrow('Which repository');
    expect(h.state().events).toHaveLength(0);
  });

  it('enforces worker concurrency and fences late results after pause or cancel', async () => {
    const h = harness(); await h.start({maxConcurrent:1});
    await h.agent('a'); await h.agent('b');
    await h.kernel.tick();
    await vi.waitFor(() => expect(h.requests).toHaveLength(1));
    await h.call('pause'); await h.settle();
    expect(h.state().tasks.map(t=>t.status)).toEqual(['cancelled','cancelled']);
    expect(h.state().artifacts.filter(a=>a.taskId)).toHaveLength(0);
    await h.call('resume'); h.begin();
    await h.agent('a');
    expect(h.state().script?.calls[0]?.cached).toBe(false);
    await h.kernel.tick(); await vi.waitFor(() => expect(h.requests).toHaveLength(2));
    expect(h.requests[1]?.session.nativeSessionId).toBeUndefined();
    const id = h.state().workflowId;
    await h.call('cancel');
    await vi.waitFor(()=>expect(h.kernel.state('script',id)?.tasks.at(-1)?.status).toBe('cancelled'));
    expect(h.kernel.state('script',id)?.script?.status).toBe('cancelled');
    expect(h.kernel.state('script',id)?.artifacts.filter(a=>a.taskId)).toHaveLength(0);
  });

  it('restores journal evidence after restart but only explicitly replays completed matching tasks', async () => {
    const directory = await mkdtemp(join(tmpdir(),'script-journal-'));
    cleanup.push(()=>rm(directory,{recursive:true,force:true}));
    const h = harness(join(directory,'workflow.sqlite')); await h.start();
    await h.agent('completed'); await h.kernel.tick();
    await vi.waitFor(()=>expect(h.finishes).toHaveLength(1));
    h.finishes[0]!({status:'completed',text:'saved'}); await h.settle();
    await h.agent('unfinished');
    await h.restart();
    expect(h.state().status).toBe('interrupted');
    expect(h.state().script?.status).toBe('interrupted');
    expect(h.state().tasks.map(t=>t.status)).toEqual(['result_ready','interrupted']);
    await h.kernel.tick(); expect(h.requests).toHaveLength(1);
    await h.call('replay_script'); h.begin();
    const cached = await h.agent('completed');
    expect(h.result(cached.taskId)).toBe('saved');
    await h.agent('unfinished');
    expect(h.state().script?.calls.map(c=>c.cached)).toEqual([true,false]);
    expect(h.state().tasks).toHaveLength(3);
  });

  it('includes target configuration in cache identity and rejects unknown execution overrides', async () => {
    const h = harness(); await h.start(); await h.agent('a'); await h.kernel.tick();
    await vi.waitFor(()=>expect(h.finishes).toHaveLength(1));
    h.finishes[0]!({status:'completed',text:'saved'}); await h.settle(); h.finish();
    h.configChange(); await h.call('replay_script'); h.begin(); await h.agent('a');
    expect(h.state().script?.calls[0]?.cached).toBe(false);
    await expect(h.agent('b',{harness:'unknown'})).rejects.toThrow('Unknown worker');
    await expect(h.agent('b',{profile:'other'})).rejects.toThrow('supports');
    await expect(h.call('delegate',{role:'worker'})).rejects.toThrow('own their tasks');
  });

  it('bounds calls, retries, and progress and rejects stale state versions', async () => {
    const h = harness(); await h.start({maxAgents:1});
    const version = h.state().stateVersion;
    await h.agent('a');
    await expect(h.agent('b')).rejects.toThrow('call limit');
    await expect(h.call('pause',{expectedStateVersion:version})).rejects.toThrow('conflict');
    const state = h.state();
    for (let i=0;i<60;i++) h.kernel.scriptProgress('script',state.workflowId,state.script!.runId,'log','x'.repeat(2000));
    expect(h.state().script?.logs).toHaveLength(50);
    expect(h.state().script?.logs.every(s=>s.length===1000)).toBe(true);
    await h.call('pause');
    for (let i=0;i<8;i++) { await h.call('replay_script'); h.begin(); h.finish(); }
    await expect(h.call('replay_script')).rejects.toThrow('replay limit');
  });
});
