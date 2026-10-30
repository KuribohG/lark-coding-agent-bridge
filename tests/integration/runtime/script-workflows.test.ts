import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkflowRuntime } from '../../../src/workflows/runtime';
import { callWorkflow } from '../../../src/workflows/ipc';
import { RunExecutor } from '../../../src/runtime/run-executor';
import { ProcessPool } from '../../../src/runtime/process-pool';
import { ActiveRuns } from '../../../src/runtime/active-runs';
import { FakeAgentAdapter } from '../../helpers/fake-agent';
import type { WorkflowRoot } from '../../../src/workflows/types';
import type { RunPolicyAllow } from '../../../src/policy/run-policy';
import type { AgentKind } from '../../../src/config/profile-schema';
import type { AgentEvent } from '../../../src/agent/types';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
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
  const executor = new RunExecutor({ resolveAgent, pool: new ProcessPool(() => 5), activeRuns: new ActiveRuns() });
  const wakeMain = vi.fn(async () => {
    const state = runtime.kernel.state(root.scopeId)!;
    runtime.kernel.markNotified(root.scopeId, state.events.map(event => event.id));
  });
  const deps: ConstructorParameters<typeof WorkflowRuntime>[0] = { path, executor, resolve: async () => ({ root, policy }), wakeMain, showPlan,
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
  return { get runtime() { return runtime; }, adapters, resolveAgent, wakeMain, binding, state, call, until,
    restart: async () => { binding.release(); await runtime.close(); runtime = new WorkflowRuntime(deps); await runtime.start(); binding = runtime.bindMain(root.scopeId, 'continue'); },
    changeRoot: () => { root = { ...root, catalogBinding: 'replacement' }; } };
}

describe('script workflow runtime', () => {
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
