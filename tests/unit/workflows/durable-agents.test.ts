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
  let root: WorkflowRoot = { scopeId: 'durable', profile: 'default', agentKind: 'codex', cwdRealpath: '/workspace',
    policyFingerprint: 'policy', catalogBinding: 'root', modelSettings: {} };
  const requests: WorkflowWorkerRequest[] = [];
  const finishes: Array<(result: WorkflowWorkerResult) => void> = [];
  let configuration = 'initial';
  const host = { resolveRoot: async () => root, wakeMain: async () => {},
    resolveWorker: async (r: WorkflowRoot, selection: Parameters<typeof inheritedWorkerExecution>[1]) => ({ ...inheritedWorkerExecution(r, selection), configurationFingerprint: configuration }),
    execute: async (request: WorkflowWorkerRequest) => {
      requests.push(request);
      request.onRun('run-' + requests.length);
      request.onSession(request.session.nativeSessionId ?? 'thread-' + requests.length);
      return new Promise<WorkflowWorkerResult>(resolve => {
        finishes.push(resolve);
        request.signal.addEventListener('abort', () => resolve({ status: 'completed', text: 'late result' }), { once: true });
      });
    },
  };
  let kernel = new WorkflowKernel(path, host);
  cleanup.push(() => kernel.close());
  const state = () => kernel.state('durable')!;
  const call = (method: string, args: Record<string, unknown> = {}) => kernel.call({kind:'main',scopeId:'durable',allowStart:true},method,
    {operationId:randomUUID(), workflowId:state()?.workflowId, expectedStateVersion:state()?.stateVersion,
      ...(method === 'run_script' || method === 'replay_script' ? {plan:'Exercise persistent members and their mailbox.'} : {}), ...args});
  const agent = (key: string, member = 'A', args: object = {}) => kernel.scriptAgent('durable', state().workflowId, state().script!.runId, {key, member, prompt:key, ...args});
  const mail = (kind: string, member: string, key: string, text?: string) => kernel.scriptMailbox('durable',state().workflowId,state().script!.runId,{kind,member,key,...(text === undefined ? {} : {text})});
  const received = (id: string) => kernel.scriptMailboxResult('durable',state().workflowId,state().script!.runId,id);
  const worker = (request: WorkflowWorkerRequest, method: string, args: Record<string, unknown> = {}) => kernel.call({kind:'worker',scopeId:'durable',workflowId:state().workflowId,taskId:request.task.taskId,attemptId:request.attemptId},method,args);
  const begin = () => kernel.beginScript('durable',state().workflowId);
  const settle = () => vi.waitFor(() => expect(state().tasks.some(t => ['starting','running','cancelling'].includes(t.status))).toBe(false));
  const run = async () => { const count = requests.length; await kernel.tick(); await vi.waitFor(() => expect(requests).toHaveLength(count + 1)); return requests.at(-1)!; };
  const finish = async (text = 'done') => { finishes.at(-1)!({status:'completed',text}); await settle(); };
  return { get kernel() { return kernel; }, state, call, agent, mail, received, worker, begin, requests, finishes, run, finish, settle,
    configChange: () => { configuration = 'changed'; }, rootChange: () => { root = {...root,catalogBinding:'changed'}; },
    restart: async () => { await kernel.close(); kernel = new WorkflowKernel(path,host); },
    start: async () => { await call('run_script',{goal:'authorized test',script:'return null;'}); begin(); },
    end: () => kernel.finishScript('durable',state().workflowId,state().script!.runId,{text:'null'}),
  };
}

describe('durable workflow members', () => {
  it('retains identity, native conversation and checkpoints across turns and replays', async () => {
    const h = harness(); await h.start(); const first = await h.agent('plan'); const request = await h.run();
    await expect(h.agent('overlap')).rejects.toThrow('unfinished turn');
    await h.worker(request,'checkpoint',{operationId:'plan-state',expectedCheckpointVersion:0,state:{decision:'use SQLite',next:'review'}});
    await expect(h.call('read_checkpoint',{member:'A'})).resolves.toMatchObject({version:1,state:{decision:'use SQLite'}});
    await h.finish('proposal');
    await h.agent('review'); const second = await h.run();
    expect(second.session.nativeSessionId).toBe('thread-1');
    expect(second.prompt).toContain('use SQLite');
    expect(second.task.inputCheckpointVersion).toBe(2);
    await h.finish('reviewed'); h.end();
    const identity = h.state().agents![0];
    await h.call('replay_script'); h.begin();
    expect((await h.agent('plan')).taskId).toBe(first.taskId);
    await h.agent('review');
    expect(h.state().script!.calls.map(c=>c.cached)).toEqual([true,true]);
    expect(h.state().agents![0]).toEqual(identity);
    await h.agent('decision'); await h.run(); await h.finish();
    expect(h.state().sessions).toHaveLength(1);
    expect(h.state().tasks).toHaveLength(3);
  });

  it('reserves messages arriving before receive and acknowledges them only with the completed turn', async () => {
    const h = harness(); await h.start(); await h.agent('init'); await h.run(); await h.finish();
    await h.mail('send','A','m1','review this');
    const receipt = await h.mail('receive','A','inbox');
    expect(h.received(receipt.receiptId!)).toMatchObject([{text:'review this'}]);
    expect(h.state().mailbox!.messages[0]?.consumedByTurnId).toBeUndefined();
    await h.agent('reply'); const request = await h.run();
    expect(request.prompt).toContain('review this');
    expect(request.task.inputMessageIds).toHaveLength(1);
    await h.worker(request,'checkpoint',{operationId:'progress',expectedCheckpointVersion:1,state:{next:'finish'}});
    expect(h.state().mailbox!.messages[0]?.consumedByTurnId).toBeUndefined();
    await h.finish();
    expect(h.state().mailbox!.messages[0]?.consumedByTurnId).toBe(request.task.taskId);
    expect(h.state().mailbox!.receipts[0]?.status).toBe('consumed');
  });

  it('persists an empty wait through restart and resumes from a message sent while interrupted', async () => {
    const dir = await mkdtemp(join(tmpdir(),'durable-wait-')); cleanup.push(()=>rm(dir,{recursive:true,force:true}));
    const h = harness(join(dir,'state.db')); await h.start(); await h.agent('prepare'); await h.run(); await h.finish('waiting');
    const first = await h.mail('receive','A','review');
    expect(h.received(first.receiptId!)).toBeUndefined();
    await h.restart(); expect(h.state().status).toBe('interrupted');
    await h.kernel.tick(); expect(h.requests).toHaveLength(1);
    await h.call('send_message',{member:'A',text:'B approved'});
    expect(h.state().status).toBe('interrupted');
    await h.call('replay_script'); h.begin(); await h.agent('prepare');
    const second = await h.mail('receive','A','review');
    expect(second.receiptId).toBe(first.receiptId);
    expect(h.received(second.receiptId!)).toMatchObject([{text:'B approved'}]);
    await h.agent('continue'); const request = await h.run();
    expect(request.session.nativeSessionId).toBe('thread-1');
    expect(request.prompt).toContain('B approved'); await h.finish();
    expect(h.state().agents![0]?.wait).toBeUndefined();
  });

  it('retries an interrupted turn with its saved checkpoint, fences old attempts, and deduplicates worker sends', async () => {
    const h = harness(); await h.start(); await h.agent('init','B'); await h.run(); await h.finish();
    const original = await h.agent('work'); const request = await h.run();
    const save = {operationId:'saved',expectedCheckpointVersion:0,state:{done:['read source'],next:'test'}};
    await h.worker(request,'checkpoint',save);
    const sent = await h.worker(request,'send_message',{operationId:'notify',member:'B',text:'half done'});
    await h.call('pause'); await h.settle();
    await expect(h.worker(request,'checkpoint',{...save,operationId:'late'})).rejects.toThrow('inactive');
    await h.call('resume'); h.begin(); await h.agent('init','B');
    expect((await h.agent('work')).taskId).toBe(original.taskId);
    const retry = await h.run();
    expect(retry.attemptId).not.toBe(request.attemptId);
    expect(retry.session.nativeSessionId).toBe('thread-2');
    expect(retry.prompt).toContain('read source');
    request.onSession('late-replacement');
    expect(h.state().sessions[1]?.nativeSessionId).toBe('thread-2');
    expect(await h.worker(retry,'send_message',{operationId:'notify',member:'B',text:'half done'})).toEqual(sent);
    await h.worker(retry,'checkpoint',save);
    expect(h.state().mailbox!.messages).toHaveLength(1);
    expect(h.state().checkpoints!.filter(c=>c.agentId===retry.task.agentId)).toHaveLength(1);
    await h.finish();
    expect(h.state().tasks[1]?.attempts).toHaveLength(2);
  });

  it('rejects rewriting committed member history or changing its execution binding', async () => {
    const h = harness(); await h.start(); await h.agent('first'); await h.run(); await h.finish(); h.end();
    await h.call('replay_script'); h.begin();
    await expect(h.agent('first','A',{prompt:'different'})).rejects.toThrow('rewrite member history');
    h.configChange(); await expect(h.agent('first')).rejects.toThrow('binding changed');
    expect(h.state().tasks).toHaveLength(1);
  });

  it('checks checkpoint versions, rejects spoofed mailbox options and scopes member access', async () => {
    const h = harness(); await h.start(); await h.agent('a'); const request = await h.run();
    await h.worker(request,'checkpoint',{operationId:'one',expectedCheckpointVersion:0,state:{step:1}});
    await expect(h.worker(request,'checkpoint',{operationId:'two',expectedCheckpointVersion:0,state:{step:2}})).rejects.toThrow('checkpointVersion conflict');
    await expect(h.worker(request,'checkpoint',{operationId:'large',expectedCheckpointVersion:1,state:'x'.repeat(16001)})).rejects.toThrow('exceeds');
    await expect(h.worker(request,'send_message',{operationId:'unknown',member:'other-workflow-agent',text:'x'})).rejects.toThrow('Unknown member');
    await expect(h.kernel.scriptMailbox('durable',h.state().workflowId,h.state().script!.runId,{kind:'send',member:'A',key:'spoof',text:'x',from:'someone'})).rejects.toThrow('Unsupported');
    await h.finish();
    await expect(h.worker(request,'checkpoint',{operationId:'finished',expectedCheckpointVersion:2,state:{}})).rejects.toThrow('inactive');
    h.rootChange(); await expect(h.mail('send','A','root-change','x')).rejects.toThrow('binding');
  });

  it('deduplicates script sends across replay and binds receives to the original turn history', async () => {
    const h = harness(); await h.start(); await h.agent('init'); await h.run(); await h.finish();
    const first = await h.mail('send','A','send','original');
    await h.mail('receive','A','read'); await h.agent('reply'); await h.run(); await h.finish(); h.end();
    await h.call('replay_script'); h.begin(); await h.agent('init');
    expect(await h.mail('send','A','send','original')).toEqual(first);
    const receipt = await h.mail('receive','A','read'); expect(h.received(receipt.receiptId!)).toMatchObject([{text:'original'}]);
    await h.agent('reply');
    expect(h.state().mailbox!.messages).toHaveLength(1);
    await expect(h.mail('send','A','reply','x')).rejects.toThrow('Duplicate');
    h.end(); await h.call('replay_script'); h.begin(); await h.agent('init');
    await expect(h.mail('send','A','send','changed')).rejects.toThrow('operation ID conflict');
    await expect(h.mail('receive','A','send')).rejects.toThrow('changed operation kind');
  });
});
