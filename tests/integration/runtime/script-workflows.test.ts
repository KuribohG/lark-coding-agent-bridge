import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkflowRuntime } from '../../../src/workflows/runtime';
import { callWorkflow } from '../../../src/workflows/ipc';
import { RunExecutor } from '../../../src/runtime/run-executor';
import { ProcessPool } from '../../../src/runtime/process-pool';
import { ActiveRuns } from '../../../src/runtime/active-runs';
import { FakeAgentAdapter } from '../../helpers/fake-agent';
import type { WorkflowRoot, WorkflowWorkItem } from '../../../src/workflows/types';
import type { RunPolicyAllow } from '../../../src/policy/run-policy';
import type { AgentKind } from '../../../src/config/profile-schema';
import type { AgentEvent } from '../../../src/agent/types';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  try { for (const close of cleanup.splice(0).reverse()) await close(); }
  finally { vi.useRealTimers(); }
});
const output = (text: string, kind: string): AgentEvent[] => [
  { type: 'system', ...(kind === 'codex' ? { threadId: randomUUID() } : { sessionId: randomUUID() }) },
  { type: 'final_text', content: text }, { type: 'done', terminationReason: 'normal' },
];
async function harness(results: Partial<Record<AgentKind, string[]>> = {}, rootKind: 'claude' | 'codex' | 'pi' = 'codex', showPlan?: ConstructorParameters<typeof WorkflowRuntime>[0]['showPlan'], path = ':memory:') {
  let root: WorkflowRoot = { scopeId: 'script-topic', profile: 'default', agentKind: rootKind, cwdRealpath: '/workspace',
    policyFingerprint: 'policy', catalogBinding: 'root', modelSettings: { model: 'root-model' } };
  const policy: RunPolicyAllow = { ok: true, prompt: '', requestedCwd: '/workspace', cwdRealpath: '/workspace',
    accessMode: 'full', sandbox: 'danger-full-access', permissionMode: 'bypassPermissions',
    access: { ok: true, reason: 'allowed-user' }, attachments: [], policyFingerprint: 'policy', expiresAt: Date.now() + 60_000 };
  const adapters = Object.fromEntries(['claude', 'codex', 'pi'].map(kind => [kind, new FakeAgentAdapter({
    id: kind, capabilities: { finalAnswer: 'separate-event', input: 'unsupported' },
    events: (results[kind as AgentKind] ?? []).map(text => output(text, kind)),
  })])) as Record<'claude' | 'codex' | 'pi', FakeAgentAdapter>;
  const resolveAgent = vi.fn((_: string, kind?: AgentKind) => adapters[kind as keyof typeof adapters]);
  const pool = new ProcessPool(() => 5);
  const executor = new RunExecutor({ resolveAgent, pool, activeRuns: new ActiveRuns() });
  const wakeMain = vi.fn(async (scopeId: string) => {
    const state = runtime.kernel.state(scopeId)!;
    runtime.kernel.markNotified(scopeId, state.events.map(event => event.id));
  });
  const deps: ConstructorParameters<typeof WorkflowRuntime>[0] = { path, executor, resolve: async scopeId => ({ root: {...root,scopeId}, policy }), wakeMain, showPlan,
    resolveWorker: async (current, selection) => ({ policy, execution: {
      agentKind: selection.agentKind, profile: current.profile, configurationFingerprint: selection.agentKind,
      policyFingerprint: policy.policyFingerprint, modelSettings: { ...(selection.agentKind === current.agentKind ? current.modelSettings : {model: selection.agentKind + '-default'}), ...(selection.model ? {model:selection.model} : {}), ...(selection.reasoningEffort ? {reasoningEffort:selection.reasoningEffort} : {}) },
    } }),
  };
  let runtime = new WorkflowRuntime(deps);
  await runtime.start(); cleanup.push(() => runtime.close());
  let binding = runtime.bindMain(root.scopeId, 'start');
  const state = () => runtime.kernel.state(root.scopeId)!;
  const call = (method: string, args: Record<string, unknown> = {}) => callWorkflow(method,
    { operationId: randomUUID(), workflowId: state()?.workflowId, expectedStateVersion: state()?.stateVersion, ...(method === 'run_script' || method === 'replay_script' ? {plan:'Review the task with the requested harness and model; return a final result.'} : {}), ...args }, binding.env);
  const until = async (check: () => void) => vi.waitFor(async () => { await runtime.tick(); check(); }, { timeout: 5000, interval: 20 });
  return { get runtime() { return runtime; }, adapters, resolveAgent, wakeMain, binding, state, call, until, pool,
    restart: async () => { binding.release(); await runtime.close(); runtime = new WorkflowRuntime(deps); await runtime.start(); binding = runtime.bindMain(root.scopeId, 'continue'); },
    changeRoot: () => { root = { ...root, catalogBinding: 'replacement' }; } };
}

describe('script workflow runtime', () => {
  it('preserves a committed child when the runtime closes before its caller yields', async () => {
    const dir=await mkdtemp(join(tmpdir(),'nested-before-yield-'));cleanup.push(()=>rm(dir,{recursive:true,force:true}));
    const h=await harness({},'codex',undefined,join(dir,'state.db'));
    let release!:()=>void;
    const pending=new Promise<void>(resolve=>{release=resolve;});
    cleanup.push(async()=>release());
    const run=h.adapters.codex.run.bind(h.adapters.codex);
    h.adapters.codex.run=opts=>{
      const native=run(opts);
      const events=(async function*():AsyncGenerator<AgentEvent>{
        yield {type:'system',threadId:opts.threadId ?? 'parent-before-yield'};
        if(!opts.threadId) {
          await callWorkflow('run_workflow',{operationId:'child',key:'child',goal:'Compute',plan:'Return 42',script:'return 42;'},opts.env);
          await pending;
          return;
        }
        const context=await callWorkflow('read_context',{},opts.env) as {workflows:{call:{ok:boolean;result:unknown}}};
        expect(context.workflows.call).toMatchObject({ok:true,result:42});
        yield {type:'final_text',content:'recovered child result'};
        yield {type:'done',terminationReason:'normal'};
      })();
      return {runId:native.runId,events,stop:async()=>{await native.stop();release();},waitForExit:ms=>native.waitForExit(ms)};
    };
    await h.call('run_script',{goal:'Recover a committed child before yield',maxConcurrent:1,script:'return await agent("parent",{key:"parent",workflowTool:true});'});
    await h.until(()=>expect(h.state().tasks[0]?.waitingWorkflowId).toBeTruthy());
    const childId=h.state().tasks[0]!.waitingWorkflowId!;
    await h.restart();
    expect(h.runtime.kernel.state('script-topic',childId)?.status).toBe('interrupted');
    await h.call('replay_script');
    await h.until(()=>expect(h.state().script?.status).toBe('result_ready'));
    expect(h.adapters.codex.runs).toHaveLength(2);
    expect(h.adapters.codex.runOptions[1]?.threadId).toBe('parent-before-yield');
    expect(h.pool.snapshot()).toMatchObject({active:0,waiting:0});
  });

  it.each([false, true])('yields a nested caller (member=%s), releases its only slot, and resumes with the child result', async persistent => {
    const showPlan = vi.fn(async () => {});
    const h = await harness({}, 'codex', showPlan);
    const run = h.adapters.codex.run.bind(h.adapters.codex);
    const childInput = {operationId:'nested-call',key:'nested',goal:'Return a leaf answer',plan:'One leaf without the workflow tool',
      script:'return await agent("leaf", {key:"leaf"});',checkpoint:{stage:'delegated'}};
    let childId: string | undefined;
    h.adapters.codex.run = opts => {
      const native = run(opts);
      expect(h.pool.snapshot().active).toBe(1);
      const events = (async function* (): AsyncGenerator<AgentEvent> {
        yield {type:'system',threadId:opts.threadId ?? randomUUID()};
        const context = await callWorkflow('read_context',{},opts.env) as {objective:string;workflows?:{checkpoint:unknown;call?:unknown}};
        if (context.objective === 'leaf') {
          expect(opts.systemPrompt).not.toContain('run_workflow');
          await expect(callWorkflow('run_workflow',childInput,opts.env)).rejects.toThrow('not enabled');
          yield {type:'final_text',content:'child result'};
        } else {
          expect(opts.systemPrompt).toContain('run_workflow');
          const response = await callWorkflow('run_workflow',childInput,opts.env) as {workflowId:string;status:string};
          if (!opts.threadId) {
            childId = response.workflowId;
            expect(response.status).toBe('waiting');
            yield {type:'final_text',content:'This yield must not be the parent result'};
          } else {
            expect(response).toMatchObject({workflowId:childId,status:'completed',result:'child result'});
            expect(context.workflows).toMatchObject({checkpoint:{stage:'delegated'},call:{ok:true,result:'child result'}});
            expect(opts.prompt).toContain('child result');
            yield {type:'final_text',content:'parent finished'};
          }
        }
        yield {type:'done',terminationReason:'normal'};
      })();
      return {runId:native.runId,events,stop:()=>native.stop(),waitForExit:ms=>native.waitForExit(ms)};
    };
    await h.call('run_script',{goal:'Delegate and resume',maxConcurrent:1,
      script:`return await agent("parent", {key:"parent",workflowTool:true${persistent ? ',member:"parent"' : ''}});`});
    await h.until(()=>expect(h.state().script?.status).toBe('result_ready'));
    expect(h.state().tasks[0]?.attempts).toHaveLength(2);
    expect(h.state().tasks[0]?.resultRefs).toHaveLength(1);
    expect(h.state().artifacts.at(-1)?.text).toBe('"parent finished"');
    expect(h.adapters.codex.runs).toHaveLength(3);
    expect(h.adapters.codex.runOptions[2]?.threadId).toBe(h.state().sessions[0]?.nativeSessionId);
    expect(h.pool.snapshot()).toMatchObject({active:0,waiting:0});
    expect(showPlan).toHaveBeenCalledTimes(1);
    expect(h.runtime.kernel.state('script-topic',childId)?.events.every(event=>event.acknowledged && event.notified)).toBe(true);
  });

  it('can start children while all four root interpreter slots wait for nested calls', async () => {
    let release!: () => void;
    const ready = new Promise<void>(resolve=>{release=resolve;});
    let plans = 0;
    const h = await harness({},'codex',async()=>{if (++plans===4) release();await ready;});
    cleanup.push(async()=>release());
    const run = h.adapters.codex.run.bind(h.adapters.codex);
    h.adapters.codex.run = opts => {
      const native = run(opts);
      const events = (async function* (): AsyncGenerator<AgentEvent> {
        yield {type:'system',threadId:opts.threadId ?? randomUUID()};
        if (!opts.threadId) await callWorkflow('run_workflow',{operationId:'child',key:'child',goal:'Compute',plan:'Return 42',script:'return 42;'},opts.env);
        yield {type:'final_text',content:opts.threadId ? 'finished' : 'yield'};
        yield {type:'done',terminationReason:'normal'};
      })();
      return {runId:native.runId,events,stop:()=>native.stop(),waitForExit:ms=>native.waitForExit(ms)};
    };
    const scopes = Array.from({length:4},(_,i)=>'scope-'+i);
    for (const scope of scopes) {
      const binding = h.runtime.bindMain(scope,'start');cleanup.push(async()=>binding.release());
      await callWorkflow('run_script',{operationId:'start',goal:'Nested',plan:'Nested parent',maxConcurrent:1,
        script:'return await agent("parent",{key:"parent",workflowTool:true});'},binding.env);
    }
    await h.until(()=>expect(scopes.every(scope=>h.runtime.kernel.state(scope)?.script?.status==='result_ready')).toBe(true));
    expect(plans).toBe(4);
    expect(h.adapters.codex.runs).toHaveLength(8);
    expect(h.pool.snapshot()).toMatchObject({active:0,waiting:0});
  });

  it('stops a caller that does not yield after requesting a child and still resumes its conversation', async () => {
    vi.useFakeTimers();
    const h = await harness();
    let release!: () => void;
    const stuck = new Promise<void>(resolve=>{release=resolve;});
    cleanup.push(async()=>release());
    const run = h.adapters.codex.run.bind(h.adapters.codex);
    h.adapters.codex.run = opts => {
      const native = run(opts);
      const events = (async function* (): AsyncGenerator<AgentEvent> {
        yield {type:'system',threadId:opts.threadId ?? 'yield-session'};
        if (!opts.threadId) {
          await callWorkflow('run_workflow',{operationId:'child',key:'child',goal:'Compute',plan:'Return 42',script:'return 42;'},opts.env);
          await stuck;
          return;
        }
        yield {type:'final_text',content:'finished after forced yield'};
        yield {type:'done',terminationReason:'normal'};
      })();
      return {runId:native.runId,events,stop:async()=>{await native.stop();release();},waitForExit:ms=>native.waitForExit(ms)};
    };
    await h.call('run_script',{goal:'Forced yield',maxConcurrent:1,script:'return await agent("parent",{key:"parent",workflowTool:true});'});
    await h.until(()=>expect(h.state().tasks[0]?.waitingWorkflowId).toBeTruthy());
    await vi.advanceTimersByTimeAsync(31_000);
    await h.until(()=>expect(h.state().script?.status).toBe('result_ready'));
    expect(h.adapters.codex.runs[0]?.stopped).toBe(true);
    expect(h.adapters.codex.runOptions[1]?.threadId).toBe('yield-session');
    expect(h.state().tasks[0]?.attempts[0]?.result).toBe('suspended');
  });

  it('lets an opted-in consumer delegate and reclaim saved work after its child completes', async () => {
    const h = await harness();
    const run = h.adapters.codex.run.bind(h.adapters.codex);
    h.adapters.codex.run = opts => {
      const native = run(opts);
      const events = (async function* (): AsyncGenerator<AgentEvent> {
        yield {type:'system',threadId:opts.threadId ?? 'consumer'};
        expect(opts.systemPrompt).toContain('run_workflow');
        const grant=await callWorkflow('claim_work',{operationId:'claim'},opts.env) as {claimId:string;generation:number;item:WorkflowWorkItem};
        if (!opts.threadId) {
          await callWorkflow('checkpoint_work',{operationId:'progress',claimId:grant.claimId,generation:grant.generation,
            expectedProgressVersion:0,state:{stage:'delegated'}},opts.env);
          await callWorkflow('run_workflow',{operationId:'child',key:'child',goal:'Compute',plan:'Return 42',script:'return 42;'},opts.env);
        } else {
          expect(grant.generation).toBe(2);
          expect(grant.item.progress.state).toEqual({stage:'delegated'});
          const context=await callWorkflow('read_context',{},opts.env) as {workflows:{call:{result:unknown}}};
          await callWorkflow('complete_work',{operationId:'complete',claimId:grant.claimId,generation:grant.generation,result:context.workflows.call.result},opts.env);
        }
        yield {type:'final_text',content:'done'};
        yield {type:'done',terminationReason:'normal'};
      })();
      return {runId:native.runId,events,stop:()=>native.stop(),waitForExit:ms=>native.waitForExit(ms)};
    };
    await h.call('run_script',{goal:'Delegate work from a consumer',maxConcurrent:1,script:[
      'await enqueueWork({key:"item",title:"Compute",input:null});',
      'await closeWorkQueue({key:"close"});',
      'return await consumeWork({key:"pool",members:[{name:"A",workflowTool:true}],prompt:"Process the item"});',
    ].join('\n')});
    await h.until(()=>expect(h.state().script?.status).toBe('result_ready'));
    expect(h.state().workQueue?.items[0]?.result).toBe(42);
    expect(h.adapters.codex.runs).toHaveLength(2);
    expect(h.pool.snapshot()).toMatchObject({active:0,waiting:0});
  });

  it('releases the process pool while consumers wait, resumes native sessions for added work, and drains only after close', async () => {
    const h = await harness();
    const run = h.adapters.codex.run.bind(h.adapters.codex);
    h.adapters.codex.run = opts => {
      const native = run(opts);
      const events = (async function* (): AsyncGenerator<AgentEvent> {
        yield {type:'system',threadId:opts.threadId ?? randomUUID()};
        for (;;) {
          const grant = await callWorkflow('claim_work',{operationId:randomUUID()},opts.env) as {claimId:string;generation:number;item:WorkflowWorkItem}|null;
          if (!grant) break;
          await callWorkflow('complete_work',{operationId:randomUUID(),claimId:grant.claimId,generation:grant.generation,result:(grant.item.input as number)**2},opts.env);
        }
        yield {type:'final_text',content:'Batch consumed'};
        yield {type:'done',terminationReason:'normal'};
      })();
      return {runId:native.runId,events,stop:()=>native.stop(),waitForExit:ms=>native.waitForExit(ms)};
    };
    const script = await readFile(new URL('../../../workflow-definitions/scripted/examples/consumer-pool.js', import.meta.url), 'utf8');
    await h.call('run_script',{goal:'Consume work as it arrives',script,args:{items:[],members:['A','B','C'].map(name=>({name})),consumerPrompt:'Square item.input',keepOpen:true}});
    await h.until(()=>expect(h.state().consumerPool?.status).toBe('waiting'));
    expect(h.adapters.codex.runs).toHaveLength(0);
    expect(h.pool.snapshot()).toMatchObject({active:0,waiting:0});
    for(let i=0;i<10;i++) await h.call('enqueue_work',{key:'item-'+i,title:'Square '+i,input:i});
    await h.until(()=>expect(h.state().workQueue?.items.filter(item=>item.status==='completed')).toHaveLength(10));
    await h.until(()=>expect(h.state().consumerPool?.status).toBe('waiting'));
    const runs=h.adapters.codex.runs.length;
    const ids=h.state().sessions.map(session=>session.nativeSessionId);
    expect(h.state().script?.status).toBe('running');expect(h.wakeMain).not.toHaveBeenCalled();
    expect(h.pool.snapshot()).toMatchObject({active:0,waiting:0});
    expect(await h.runtime.kernel.call({kind:'main',scopeId:'script-topic'},'status',{})).toMatchObject({consumers:{status:'waiting'}});
    await h.runtime.tick();expect(h.adapters.codex.runs).toHaveLength(runs);
    for(let i=10;i<15;i++) await h.call('enqueue_work',{key:'item-'+i,title:'Square '+i,input:i});
    await h.call('close_work_queue');
    await h.until(()=>expect(h.state().script?.status).toBe('result_ready'));
    expect(h.state().workQueue!.items.map(item=>item.result)).toEqual(Array.from({length:15},(_,i)=>i*i));
    expect(h.adapters.codex.runOptions.slice(runs).every(options=>ids.includes(options.threadId))).toBe(true);
    expect(h.pool.snapshot()).toMatchObject({active:0,waiting:0});
    const result=JSON.parse(h.state().artifacts.find(artifact=>artifact.ref===h.state().script!.resultRef)!.text);
    expect(result).toMatchObject({queue:{completed:15,closed:true},consumers:{status:'drained'}});
  });

  it('runs the queue example through QuickJS and worker IPC, adopts an interrupted claim, and replays without duplicating work', async () => {
    const h = await harness();
    const run = h.adapters.codex.run.bind(h.adapters.codex);
    let startOthers!: () => void;
    let stopFirst!: () => void;
    const others = new Promise<void>(resolve => { startOthers = resolve; });
    const first = new Promise<void>(resolve => { stopFirst = resolve; });
    cleanup.push(async () => { startOthers(); stopFirst(); });
    let abandoned: {claimId: string; generation: number; item: WorkflowWorkItem} | undefined;
    const recovered: unknown[] = [];
    let index = 0;
    h.adapters.codex.run = opts => {
      const native = run(opts);
      const order = index++;
      const events = (async function* (): AsyncGenerator<AgentEvent> {
        yield { type: 'system', threadId: opts.threadId ?? randomUUID() };
        const call = (method: string, args: Record<string, unknown> = {}) => callWorkflow(method, {operationId:randomUUID(),...args}, opts.env);
        if (order === 0) {
          abandoned = await call('claim_work') as typeof abandoned;
          await call('checkpoint_work', {claimId:abandoned!.claimId,generation:abandoned!.generation,expectedProgressVersion:0,state:{stage:'adopt-me'}});
          await first;
          return;
        }
        await others;
        for (;;) {
          const grant = await call('claim_work') as typeof abandoned;
          if (!grant) break;
          if (grant.item.progress.version) recovered.push(grant.item.progress.state);
          await call('complete_work', {claimId:grant.claimId,generation:grant.generation,result:(grant.item.input as number)**2});
        }
        yield {type:'final_text',content:'done'};
        yield {type:'done',terminationReason:'normal'};
      })();
      return {runId:native.runId,events,capabilities:native.capabilities,
        stop:async()=>{ await native.stop(); if(order===0) stopFirst(); },waitForExit:ms=>native.waitForExit(ms)};
    };
    const script = await readFile(new URL('../../../workflow-definitions/scripted/examples/work-queue.js', import.meta.url), 'utf8');
    await h.call('run_script', {goal:'Consume ten items and recover saved progress',script,args:{
      items:Array.from({length:10},(_,i)=>({key:`item-${i}`,title:`Square ${i}`,input:i})),
      members:['A','B','C'].map(name=>({name})),consumerPrompt:'Compute the square of item.input.',
    }});
    await h.until(()=>expect(h.state().workQueue?.items[0]?.progress.version).toBe(1));
    const original = h.state().tasks[0]!;
    const oldEnv = h.adapters.codex.runOptions[0]!.env;
    await h.call('cancel_task', {taskId:original.taskId});
    await h.until(()=>expect(h.state().tasks[0]?.status).toBe('cancelled'));
    startOthers();
    await h.until(()=>expect(h.state().script?.status).toBe('result_ready'));
    expect(recovered).toEqual([{stage:'adopt-me'}]);
    expect(h.state().workQueue!.items.map(item=>item.result)).toEqual(Array.from({length:10},(_,i)=>i**2));
    expect(h.state().workQueue!.claims.filter(claim=>claim.status==='completed')).toHaveLength(10);
    await expect(callWorkflow('complete_work',{operationId:'late',claimId:abandoned!.claimId,generation:abandoned!.generation,result:-1},oldEnv)).rejects.toThrow(/revoked|inactive/);
    const ids = h.state().workQueue!.items.map(item=>item.id);
    await h.call('replay_script');
    await h.until(()=>expect(h.state().script?.status).toBe('result_ready'));
    expect(h.state().workQueue!.items.map(item=>item.id)).toEqual(ids);
    expect(h.state().workQueue!.claims).toHaveLength(11);
    expect(h.adapters.codex.runs).toHaveLength(4);
    expect(h.adapters.codex.runOptions[3]?.threadId).toBe(h.state().sessions[0]?.nativeSessionId);
    expect(JSON.parse(h.state().artifacts.at(-1)!.text).status).toMatchObject({total:10,completed:10,pending:0,claimed:0});
  });

  it.each(['codex', 'claude', 'pi'] as const)('keeps a %s worker running across rate limits and disconnections, resuming its session', async kind => {
    vi.useFakeTimers();
    const h = await harness();
    const identity: AgentEvent = { type: 'system', ...(kind === 'codex' ? { threadId: 'child' } : { sessionId: 'child' }) };
    h.adapters[kind].setEvents([
      [identity, { type: 'tool_use', id: 'write', name: 'write', input: {} },
        { type: 'final_text', content: 'incomplete result' },
        { type: 'error', terminationReason: 'failed', message: 'HTTP 429 Too Many Requests' }],
      [identity, { type: 'error', terminationReason: 'failed', failureKind: 'transient', message: 'connection lost' }],
      [identity, { type: 'final_text', content: 'recovered result' }, { type: 'done', terminationReason: 'normal' }],
    ]);
    await h.call('run_script', { goal: 'finish the task', script: `return await agent("task",{key:"task",harness:"${kind}"});` });
    await h.until(() => expect(h.adapters[kind].runs).toHaveLength(1));
    expect(h.state().tasks[0]?.status).toBe('running');
    expect(h.wakeMain).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.adapters[kind].runs).toHaveLength(2);
    expect(h.state().tasks[0]?.status).toBe('running');
    expect(h.state().script?.status).toBe('running');
    expect(h.state().tasks[0]?.resultRefs).toEqual([]);
    await vi.advanceTimersByTimeAsync(60_000);
    await h.until(() => expect(h.state().script?.status).toBe('result_ready'));
    const state = h.state();
    expect(state.tasks).toHaveLength(1);
    expect(state.tasks[0]?.attempts).toHaveLength(1);
    expect(state.sessions[0]?.nativeSessionId).toBe('child');
    expect(state.artifacts.find(a => a.taskId)?.text).toBe('recovered result');
    expect(state.events.map(e => e.kind)).toEqual(['script_result_ready']);
    const [initial, ...resumed] = h.adapters[kind].runOptions;
    for (const options of resumed) {
      expect(options).toMatchObject({ runId: initial!.runId, model: initial!.model,
        ...(kind === 'codex' ? { threadId: 'child' } : { sessionId: 'child' }) });
      expect(options.prompt).toContain('不要重复执行已完成的操作');
    }
  });

  it.each(['cancel', 'deadline'] as const)('stops a disconnected worker during backoff on %s', async stop => {
    vi.useFakeTimers();
    const h = await harness();
    h.adapters.codex.setEvents([[{ type: 'system', threadId: 'child' },
      { type: 'error', terminationReason: 'failed', failureKind: 'transient', message: 'connection lost' }]]);
    await h.call('run_script', { goal: 'bounded retry', timeoutMs: 10_000,
      script: 'return await agent("task",{key:"task"});' });
    await h.until(() => expect(h.adapters.codex.runs).toHaveLength(1));
    const workflowId = h.state().workflowId;
    if (stop === 'cancel') await h.call('cancel');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.adapters.codex.runs).toHaveLength(1);
    expect(h.adapters.codex.runs[0]?.stopped).toBe(true);
    expect(h.runtime.kernel.state('script-topic', workflowId)?.tasks[0]?.status).toBe('cancelled');
  });

  it('replays a persisted mailbox wait after a runtime restart without replaying completed agent turns', async () => {
    const dir=await mkdtemp(join(tmpdir(),'durable-runtime-')); cleanup.push(()=>rm(dir,{recursive:true,force:true}));
    const h=await harness({},'codex',undefined,join(dir,'state.db'));
    const events=(text:string):AgentEvent[]=>[{type:'system',threadId:'saved-thread'},{type:'final_text',content:text},{type:'done',terminationReason:'normal'}];
    h.adapters.codex.setEvents([events('prepared'),events('resumed')]);
    await h.call('run_script',{goal:'restart recovery',script:'await agent("prepare",{key:"prepare",member:"A"});const m=await receive("A",{key:"inbox"});return await agent(JSON.stringify(m),{key:"resume",member:"A"});'});
    await h.until(()=>expect(h.state().mailbox?.receipts[0]?.status).toBe('waiting'));
    await h.restart();
    await h.runtime.tick();
    expect(h.state().status).toBe('interrupted');
    expect(h.adapters.codex.runs).toHaveLength(1);
    await h.call('send_message',{member:'A',text:'arrived during restart'});
    await h.call('replay_script');
    await h.until(()=>expect(h.state().script?.status).toBe('result_ready'));
    expect(h.adapters.codex.runs).toHaveLength(2);
    expect(h.adapters.codex.runOptions[1]?.threadId).toBe('saved-thread');
    expect(h.adapters.codex.runOptions[1]?.prompt).toContain('arrived during restart');
    expect(h.state().script?.calls[0]?.cached).toBe(true);
    expect(h.state().mailbox?.receipts[0]?.status).toBe('consumed');
  });

  it.each(['codex', 'claude', 'pi'] as const)('resumes a persistent %s member after releasing its process to wait for a message', async kind => {
    const h = await harness({},kind);
    const id = 'persistent-' + kind;
    const events = (text: string): AgentEvent[] => [
      {type:'system',...(kind === 'codex' ? {threadId:id} : {sessionId:id})},
      {type:'final_text',content:text},{type:'done',terminationReason:'normal'},
    ];
    h.adapters[kind].setEvents([events('prepared'),events('continued')]);
    await h.call('run_script',{goal:'wait and continue',script:[
      'await agent("prepare",{key:"prepare",member:"designer"});',
      'const messages = await receive("designer",{key:"review"});',
      'return await agent(JSON.stringify(messages),{key:"continue",member:"designer"});',
    ].join('\n')});
    await h.until(()=>expect(h.state().mailbox?.receipts[0]?.status).toBe('waiting'));
    expect(h.adapters[kind].runs).toHaveLength(1);
    expect(h.adapters[kind].runs[0]?.waitForExitCalls).toBeGreaterThan(0);
    expect(h.state().tasks[0]?.status).toBe('result_ready');
    expect(h.wakeMain).not.toHaveBeenCalled();
    await h.call('send_message',{member:'designer',text:'review approved'});
    await h.until(()=>expect(h.state().script?.status).toBe('result_ready'));
    const opts=h.adapters[kind].runOptions[1]!;
    expect(kind==='codex'?opts.threadId:opts.sessionId).toBe(id);
    expect(opts.prompt).toContain('review approved');
    expect(h.state().mailbox!.messages[0]?.consumedByTurnId).toBe(h.state().tasks[1]?.taskId);
    expect(h.state().artifacts.at(-1)?.text).toBe('"continued"');
    await h.call('replay_script');
    await h.until(()=>expect(h.state().script?.status).toBe('result_ready'));
    expect(h.adapters[kind].runs).toHaveLength(2);
    expect(h.state().sessions).toHaveLength(1);
  });

  it('runs independent members while a receiver waits and routes script messages through the sandbox', async () => {
    const h=await harness();
    const events=(id:string,text:string):AgentEvent[]=>[{type:'system',threadId:id},{type:'final_text',content:text},{type:'done',terminationReason:'normal'}];
    h.adapters.codex.setEvents([events('A','prepared'),events('B','reviewed'),events('A','revised')]);
    await h.call('run_script',{goal:'discussion',script:[
      'await agent("prepare",{key:"a1",member:"A"});',
      'return await parallel([',
      ' async()=>{const messages=await receive("A",{key:"inbox"});return await agent(JSON.stringify(messages),{key:"a2",member:"A"});},',
      ' async()=>{const review=await agent("review",{key:"b1",member:"B"});await send("A",review,{key:"deliver"});return review;}',
      ']);',
    ].join('\n')});
    await h.until(()=>expect(h.state().script?.status).toBe('result_ready'));
    expect(h.state().artifacts.at(-1)?.text).toBe('["revised","reviewed"]');
    expect(h.adapters.codex.runOptions[2]?.threadId).toBe('A');
  });

  it('fails a member continuation if the backend silently replaces its native session', async () => {
    const h=await harness({codex:['first','replacement']});
    await h.call('run_script',{goal:'session identity',script:'await agent("first",{key:"first",member:"A"});return await agent("second",{key:"second",member:"A"});'});
    await h.until(()=>expect(h.state().script?.status).toBe('failed'));
    expect(h.state().tasks[1]?.error).toContain('replaced the native worker session');
    expect(h.state().agents![0]?.lastTurnId).toBe(h.state().tasks[0]?.taskId);
  });

  it('restricts continuation credentials to the original workflow and denies new starts', async () => {
    const h = await harness();
    expect(() => h.runtime.bindMain('script-topic', 'continue')).toThrow('No active workflow');
    await h.call('run_script', { goal: 'first', script: 'return 1;' });
    await h.until(() => expect(h.state().script?.status).toBe('result_ready'));
    const original = h.state().workflowId;
    const continuation = h.runtime.bindMain('script-topic', 'continue');
    const call = (method: string, args: Record<string, unknown> = {}) => callWorkflow(method,
      { operationId: randomUUID(), expectedStateVersion: h.state()?.stateVersion, ...args }, continuation.env);
    await expect(call('status')).resolves.toMatchObject({ workflowId: original });
    await call('cancel');
    await expect(call('run_script', { allowStart: true, goal: 'unexpected', plan: 'Return two.', script: 'return 2;' }))
      .rejects.toThrow('explicit /workflow');
    expect(h.state()).toBeUndefined();
    await h.call('run_script', { goal: 'second', script: 'return 2;' });
    await expect(call('status')).resolves.toMatchObject({ workflowId: original, status: 'cancelled' });
    await expect(call('cancel', { workflowId: h.state().workflowId })).rejects.toThrow('outside this run binding');
    expect(h.state().status).toBe('active');
    continuation.release();
  });

  it('publishes the saved plan before workers start and refuses execution if delivery fails', async () => {
    let deliver: (() => void) | undefined;
    const showPlan=vi.fn(async () => new Promise<void>(resolve => {deliver=resolve;}));
    const h=await harness({pi:['result']},'codex',showPlan);
    await h.call('run_script',{goal:'visible plan',plan:'Pi with pi-model inspects the design, then returns findings.',script:'return await agent("review",{key:"review",harness:"pi",model:"pi-model"});'});
    await h.until(()=>expect(deliver).toBeTypeOf('function'));
    expect(h.adapters.pi.runs).toHaveLength(0);
    expect(h.state().tasks).toHaveLength(0);
    expect(h.runtime.kernel.plan('script-topic')).toContain('Pi with pi-model');
    deliver!();
    await h.until(()=>expect(h.state().script?.status).toBe('result_ready'));
    expect(showPlan).toHaveBeenCalledTimes(1);
    showPlan.mockRejectedValueOnce(new Error('Plan could not be delivered'));
    await h.call('replay_script');
    await h.until(()=>expect(h.state().script?.status).toBe('failed'));
    expect(h.state().script?.error).toContain('Plan could not be delivered');
    expect(h.adapters.pi.runs).toHaveLength(1);
  });

  it('requires a new visible plan when changing script inputs or models', async () => {
    const h=await harness();
    await expect(h.call('run_script',{goal:'missing plan',script:'return 1;',plan:undefined})).rejects.toThrow('plan');
    await h.call('run_script',{goal:'plan revisions',script:'return 1;',plan:'Return one.'});
    await h.until(()=>expect(h.state().script?.status).toBe('result_ready'));
    const planRef=h.state().script!.planRef;
    await expect(h.call('replay_script',{script:'return 2;',plan:undefined})).rejects.toThrow('updated plan');
    expect(h.state().script!.planRef).toBe(planRef);
    await h.call('replay_script',{script:'return 2;',plan:'Return two instead.'});
    expect(h.runtime.kernel.plan('script-topic')).toContain('Return two instead.');
    expect(h.state().script!.planRef).not.toBe(planRef);
    const old=await h.call('read_artifact',{ref:planRef});
    expect(old).toMatchObject({text:'Return one.'});
    await h.until(()=>expect(h.state().script?.status).toBe('result_ready'));
  });

  it.each(['claude', 'pi'] as const)('supports a %s main harness and inherits it by default', async rootKind => {
    const h = await harness({ [rootKind]: ['value'] }, rootKind);
    await h.call('run_script', { goal: 'root selection', script: 'return await agent("task",{key:"task"});' });
    await h.until(() => expect(h.state().script?.status).toBe('result_ready'));
    expect(h.state().root.agentKind).toBe(rootKind);
    expect(h.resolveAgent).toHaveBeenCalledWith('script-topic', rootKind);
    expect(h.adapters[rootKind].runOptions[0]?.model).toBe('root-model');
    expect(h.state().artifacts.at(-1)?.text).toBe('"value"');
  });

  it('pins independent models and efforts on the same harness and invalidates only the changed model on replay', async () => {
    const h = await harness({ pi: ['fast', 'baseline', 'revised'] });
    const script = 'return await parallel([()=>agent("review",{key:"fast",harness:"pi",model:"service/fast",reasoningEffort:"minimal"}),()=>agent("review",{key:"default"})]);';
    await h.call('run_script', {goal:'model selection', script, execution:{agentKind:'pi',model:'service/baseline',reasoningEffort:'high'}});
    await h.until(() => expect(h.state().script?.status).toBe('result_ready'));
    expect(h.adapters.pi.runOptions.map(o=>({model:o.model,effort:o.reasoningEffort}))).toEqual([
      {model:'service/fast',effort:'minimal'}, {model:'service/baseline',effort:'high'}]);
    expect(h.state().root.modelSettings.model).toBe('root-model');
    await h.call('replay_script', {execution:{agentKind:'pi',model:'service/revised',reasoningEffort:'high'}});
    await h.until(() => expect(h.state().script?.status).toBe('result_ready'));
    expect(h.state().script?.calls.map(c=>c.cached)).toEqual([true,false]);
    expect(h.adapters.pi.runOptions.map(o=>o.model)).toEqual(['service/fast','service/baseline','service/revised']);
  });

  it('routes each call through its harness, branches on JSON, and wakes main only for the final artifact', async () => {
    const h = await harness({ pi: ['{"review":true}'], claude: ['analysis'], codex: ['decision'] });
    const script = [
      'phase("analysis");',
      'const [plan, notes] = await parallel([',
      ' () => agent("plan", {key:"plan", harness:"pi", model:"pi-model", output:"json"}),',
      ' () => agent("notes", {key:"notes", harness:"claude"})]);',
      'if (plan.review) return {decision: await agent(notes, {key:"decision", harness:"codex"})};',
      'return "skipped";',
    ].join('\n');
    await h.call('run_script', { goal: 'review plan', script });
    h.binding.release();
    await h.until(() => expect(h.state().script?.status).toBe('result_ready'));
    const state = h.state();
    expect(state.artifacts.find(a => a.ref === state.script?.resultRef)?.text).toBe('{"decision":"decision"}');
    expect(state.tasks.map(t => t.scriptKey)).toEqual(['plan', 'notes', 'decision']);
    expect(state.events.map(e => e.kind)).toEqual(['script_result_ready']);
    expect(h.resolveAgent.mock.calls).toEqual([['script-topic', 'pi'], ['script-topic', 'claude'], ['script-topic', 'codex']]);
    expect(h.adapters.pi.runOptions[0]?.model).toBe('pi-model');
    expect(h.adapters.claude.runOptions[0]?.model).toBe('claude-default');
    await h.runtime.tick();
    expect(h.wakeMain).toHaveBeenCalledTimes(1);
  });

  it('reuses independent matching results across reordered branches, rerunning changed input in a fresh session', async () => {
    const h = await harness({ pi: ['A', 'A2'], codex: ['B'] });
    await h.call('run_script', { goal: 'compare', args: { prompt: 'a' }, script:
      'return await parallel([() => agent(args.prompt,{key:"a",harness:"pi"}), () => agent("b",{key:"b",harness:"codex"})]);' });
    await h.until(() => expect(h.state().script?.status).toBe('result_ready'));
    const firstSessions = h.state().sessions.map(s => s.nativeSessionId);
    await h.call('replay_script', { args: { prompt: 'a2' }, script:
      'const b = await agent("b",{key:"b",harness:"codex"}); const a = await agent(args.prompt,{key:"a",harness:"pi"}); return [b,a];' });
    await h.until(() => expect(h.state().script?.status).toBe('result_ready'));
    expect(h.state().script?.calls.map(c => ({ key: c.key, cached: c.cached }))).toEqual([{key:'b',cached:true},{key:'a',cached:false}]);
    expect(h.adapters.codex.runs).toHaveLength(1);
    expect(h.adapters.pi.runs).toHaveLength(2);
    expect(h.adapters.pi.runOptions.every(o => !o.sessionId)).toBe(true);
    expect(h.state().sessions[2]?.nativeSessionId).not.toBe(firstSessions[0]);
    expect(h.state().artifacts.at(-1)?.text).toBe('["B","A2"]');
    await h.call('ack_events', { eventIds: h.state().events.filter(e => !e.acknowledged).map(e => e.id) });
    await h.call('complete', { reportRef: h.state().script!.resultRef, openIssues: [], verificationLimits: 'fake adapters only' });
    expect(h.runtime.kernel.state('script-topic')).toBeUndefined();
  });

  it('fails invalid JSON and retries it with a new worker instead of caching the error', async () => {
    const h = await harness({ pi: ['```json\n{}\n```', '{"ok":true}'] });
    await h.call('run_script', { goal: 'JSON test', script: 'return await agent("json",{key:"json",harness:"pi",output:"json"});' });
    await h.until(() => expect(h.state().script?.status).toBe('failed'));
    expect(h.state().script?.error).toContain('not valid JSON');
    expect(h.state().tasks[0]?.status).toBe('failed');
    expect(h.state().events.map(e => e.kind)).toEqual(['script_failed']);
    await h.call('replay_script');
    await h.until(() => expect(h.state().script?.status).toBe('result_ready'));
    expect(h.state().script?.calls[0]?.cached).toBe(false);
    expect(h.adapters.pi.runs).toHaveLength(2);
  });

  it('aborts suspended guest code on pause, resumes with replay, and forbids stale root replay', async () => {
    const h = await harness();
    await h.call('run_script', { goal: 'pause test', script: 'await new Promise(() => {});' });
    await h.until(() => expect(h.state().script?.status).toBe('running'));
    await h.call('pause');
    expect(h.state().script?.status).toBe('paused');
    await h.call('replay_script', { script: 'return args;', args: { resumed: true } });
    await h.until(() => expect(h.state().script?.status).toBe('result_ready'));
    expect(h.state().artifacts.at(-1)?.text).toBe('{"resumed":true}');
    h.changeRoot();
    await expect(h.call('replay_script')).rejects.toThrow('binding');
    expect(h.state().status).toBe('binding_attention');
  });

  it('rejects duplicate keys and syntax errors without per-worker main events', async () => {
    const h = await harness();
    await h.call('run_script', { goal: 'syntax', script: 'agent("never",{key:"a"}); return {' });
    await h.until(() => expect(h.state().script?.status).toBe('failed'));
    expect(h.state().tasks).toHaveLength(0);
    await h.call('replay_script', { script: 'return await parallel([()=>agent("a",{key:"same"}),()=>agent("b",{key:"same"})]);' });
    await h.until(() => expect(h.state().script?.status).toBe('failed'));
    expect(h.state().script?.error).toContain('Duplicate agent key');
    expect(h.state().tasks).toHaveLength(1);
    expect(h.state().tasks[0]?.status).toBe('cancelled');
    expect(h.state().events.every(e => e.kind === 'script_failed')).toBe(true);
  });
});
