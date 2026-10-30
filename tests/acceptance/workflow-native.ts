import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRootConfig, runtimeProfileConfig } from '../../src/config/profile-store';
import { resolveAppPaths } from '../../src/config/app-paths';
import { profileForAgentKind } from '../../src/runtime/execution-controller';
import { createAgentAdapter } from '../../src/agent/backends';
import { larkAgentHostContext } from '../../src/channels/lark/agent-host';
import { WorkflowRuntime } from '../../src/workflows/runtime';
import { callWorkflow } from '../../src/workflows/ipc';
import { RunExecutor } from '../../src/runtime/run-executor';
import { ActiveRuns } from '../../src/runtime/active-runs';
import { ProcessPool } from '../../src/runtime/process-pool';
import { resolveWorkerExecution } from '../../src/workflows/execution';
import type { AgentAdapter, AgentRun, AgentRunOptions } from '../../src/agent/types';
import type { AgentKind } from '../../src/config/profile-schema';
import type { RunPolicyAllow } from '../../src/policy/run-policy';
import type { WorkflowRoot, WorkflowState } from '../../src/workflows/types';

const option = (name: string, fallback?: string) => {
  const at = process.argv.indexOf('--' + name);
  return at < 0 ? fallback : process.argv[at + 1];
};
const output = option('output')!;
const project = option('project')!;
let cancelled = false;
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { cancelled = true; });
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const save = (path: string, data: unknown) => writeFile(path, JSON.stringify(data, null, 2), { mode: 0o600 });
type Backend = Extract<AgentKind, 'codex' | 'claude' | 'pi'>;
type Case = {
  id: string;
  scenario: 'memory' | 'interrupt' | 'discussion' | 'queue';
  backend: Backend;
  reviewer?: Backend;
  marker: string;
  profile: string;
};
type Observation = {
  backend: Backend;
  phase: string;
  resumed?: string;
  native?: string;
  model?: string;
  markerInPrompt: boolean;
  tools: string[];
  sleep: boolean;
  final?: string;
};

async function currentProfile() {
  const home = process.env.CODEX_HOME;
  const inheritedProfile = process.env.LARK_CHANNEL_PROFILE;
  const inferred = home && basename(home) === 'codex-home' && basename(dirname(dirname(home))) === 'profiles' ? basename(dirname(home)) : undefined;
  const profile = inheritedProfile ?? inferred;
  assert(profile, 'Run from an authorized bridge profile; no personal/default-profile fallback');
  if (inheritedProfile && inferred) assert.equal(inheritedProfile, inferred, 'Conflicting current profile bindings');
  const rootDir = process.env.LARK_CHANNEL_HOME ?? (inferred ? dirname(dirname(dirname(home!))) : undefined);
  assert(rootDir, 'Missing current bridge root');
  const paths = resolveAppPaths({ rootDir, profile });
  const root = await loadRootConfig(paths.configFile);
  assert(root, 'Current bridge config is unavailable');
  const config = runtimeProfileConfig(root, profile);
  if (config.codex?.codexHome && home) {
    assert.equal(await realpath(config.codex.codexHome), await realpath(home), 'Configured Codex home differs from the current authorized home');
  }
  return { paths, config };
}

function wrap(adapter: AgentAdapter, kind: Backend, phase: string, test: Case, observations: Observation[], runs: AgentRunOptions[]): AgentAdapter {
  const runNative = adapter.run.bind(adapter);
  adapter.run = (opts: AgentRunOptions): AgentRun => {
    runs.push(opts);
    const observation: Observation = { backend: kind, phase, resumed: opts.threadId ?? opts.sessionId,
      markerInPrompt: opts.prompt.includes(test.marker), tools: [], sleep: false };
    observations.push(observation);
    if (test.scenario === 'memory' && phase === 'recover') {
      assert.equal(observation.markerInPrompt, false, 'Recall prompt leaked the hidden marker');
    }
    const native = runNative(opts);
    const events = (async function* () {
      for await (const event of native.events) {
        if (event.type === 'system') {
          observation.native = event.threadId ?? event.sessionId ?? observation.native;
          observation.model = event.model ?? observation.model;
        }
        if (event.type === 'tool_use') {
          observation.tools.push(event.name);
          observation.sleep ||= JSON.stringify(event.input).includes('sleep 90');
        }
        if (event.type === 'final_text') observation.final = event.content;
        yield event;
      }
    })();
    return { runId: native.runId, events, capabilities: native.capabilities,
      stop: () => native.stop(), waitForExit: timeout => native.waitForExit(timeout),
      ...(native.sendInput ? { sendInput: native.sendInput.bind(native) } : {}),
      ...(native.steer ? { steer: native.steer.bind(native) } : {}) };
  };
  return adapter;
}

async function scriptFor(test: Case): Promise<string> {
  const call = (prompt: string, key: string, member: string, backend = test.backend, json = false) =>
    `agent(${JSON.stringify(prompt)},${JSON.stringify({ key, member, harness: backend, ...(json ? { output: 'json' } : {}) })})`;
  if (test.scenario === 'memory') {
    const seed = 'Native conversation retention test. Memorize this exact non-secret random marker: ' + test.marker + '. Do not use tools, write a checkpoint or any file, or repeat the marker now. Reply exactly READY. A later turn will ask for the marker without providing it again.';
    return `await ${call(seed, 'remember', 'A')}; await receive('A',{key:'wake'}); return await ${call('Without using any tools, return the exact marker I asked you to memorize in the earlier conversation. Return only JSON with the single field marker.', 'recall', 'A', test.backend, true)};`;
  }
  if (test.scenario === 'interrupt') {
    const prompt = `Native interruption acceptance test. If the saved checkpoint in your member context has state.stage equal to "armed", use no tools and reply with JSON {"stage":"resumed"}. Otherwise run this exact shell command using your shell tool: node "$LARK_WORKFLOW_CLI" workflow checkpoint --input '{"operationId":"armed","expectedCheckpointVersion":0,"state":{"stage":"armed"}}' --json . Then execute /bin/sleep 90 in your shell tool in the foreground and wait for it. Do not launch background work. The test harness will interrupt that wait. If sleep completes normally, return {"stage":"unexpected-completion"}. Do not read configuration, credentials or other files.`;
    return `return await ${call(prompt, 'interrupted-turn', 'A', test.backend, true)};`;
  }
  return readFile(join(project, 'workflow-definitions/scripted/examples/discussion.js'), 'utf8');
}

async function childPhase(test: Case, phase: string, directory: string) {
  let stopping = false;
  const stop = () => { stopping = true; };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  const { paths, config } = await currentProfile();
  assert.equal(paths.profile, test.profile);
  const workspace = join(directory, 'workspace');
  await mkdir(workspace, { recursive: true });
  const observations: Observation[] = [];
  const nativeRuns: AgentRunOptions[] = [];
  const root: WorkflowRoot = { scopeId: test.id, profile: paths.profile, agentKind: test.backend, cwdRealpath: workspace,
    catalogBinding: test.id, policyFingerprint: test.id, modelSettings: {} };
  const policy: RunPolicyAllow = { ok: true, prompt: '', requestedCwd: workspace, cwdRealpath: workspace,
    accessMode: 'full', sandbox: 'danger-full-access', permissionMode: 'bypassPermissions',
    access: { ok: true, reason: 'allowed-user' }, attachments: [], policyFingerprint: test.id, expiresAt: Date.now() + 900_000 };
  const adapters = new Map<Backend, AgentAdapter>();
  const host = larkAgentHostContext(paths);
  for (const kind of new Set([test.backend, ...(test.reviewer ? [test.reviewer] : [])])) {
    const profile = profileForAgentKind(config, kind);
    const adapter = createAgentAdapter({ profile, profileDir: paths.profileDir, env: host.env, systemPrompt: '' });
    // No startup provider override: native configuration remains unchanged; a running Codex daemon is never restarted.
    adapters.set(kind, wrap(adapter, kind, phase, test, observations, nativeRuns));
  }
  const activeRuns = new ActiveRuns();
  const executor = new RunExecutor({ resolveAgent: (_, kind) => {
    const adapter = adapters.get(kind as Backend); assert(adapter, 'Backend outside this case'); return adapter;
  }, activeRuns, pool: new ProcessPool(() => 3) });
  let wakeCount = 0;
  const runtime = new WorkflowRuntime({ path: join(directory, 'workflow.sqlite'), cliPath: join(project, 'dist/cli.js'), executor,
    resolve: async () => ({ root, policy }),
    resolveWorker: async (bound, selection, parentPolicy) => resolveWorkerExecution(bound, profileForAgentKind(config, selection.agentKind), parentPolicy,
      { ...(selection.model ? {model:selection.model} : {}), ...(selection.reasoningEffort ? {reasoningEffort:selection.reasoningEffort} : {}) }),
    showPlan: async () => {},
    wakeMain: async () => {
      wakeCount++;
      const state = runtime.kernel.state(test.id);
      if (state) runtime.kernel.markNotified(test.id, state.events.map(event => event.id));
    },
  });
  const state = () => runtime.kernel.state(test.id)!;
  const call = (method: string, args: Record<string, unknown> = {}) => runtime.kernel.call({kind:'main',scopeId:test.id,allowStart:phase==='prepare'},method,
    {operationId:randomUUID(),workflowId:state()?.workflowId,expectedStateVersion:state()?.stateVersion,...args});
  const until = async (condition: (state: WorkflowState) => boolean) => {
    const deadline = Date.now() + 240_000;
    while (Date.now() < deadline) {
      if (stopping) throw new Error('Acceptance phase cancelled');
      await runtime.tick();
      const current = state();
      if (current.script?.status === 'failed') throw new Error(current.script.error);
      const failure = current.tasks.find(task => task.status === 'failed');
      if (failure) throw new Error(failure.error);
      if (condition(current)) return current;
      await delay(50);
    }
    throw new Error('Acceptance phase exceeded 240 seconds');
  };
  await runtime.start();
  try {
    if (test.scenario === 'queue') {
      assert.equal(phase, 'prepare');
      const consumer = join(workspace, 'consumer.mjs');
      await writeFile(consumer, await readFile(join(project, 'tests/acceptance/workflow-queue-consumer.mjs')), {mode:0o600});
      const script = await readFile(join(project, 'workflow-definitions/scripted/examples/work-queue.js'), 'utf8');
      const command = 'node ' + "'" + consumer.replaceAll("'", "'\\''") + "'";
      await call('run_script', {
        goal:'Isolated queue acceptance: three native members run only the provided local consumer helper in the foreground. It may use the worker CLI to claim/checkpoint/complete ten arithmetic items, and read/write synchronization markers beside itself. Its bounded wait is intentional for this test. No other file access, external messages, credentials or delegation.',
        plan:`Run members A, B and C using ${test.backend} and its currently configured native model. A saves partial progress; the test controller interrupts A. B and C then take over and complete all ten items through the actual worker CLI. Verify progress retention, generations and stale-result rejection.`,
        script, timeoutMs:600_000, maxConcurrent:3, args:{
          items:Array.from({length:10},(_,i)=>({key:`square-${i}`,title:`Square ${i}`,input:i})),
          members:['A','B','C'].map(name=>({name,harness:test.backend})),
          consumerPrompt:`Execute exactly this foreground shell command: ${command} . The trusted test helper implements the entire queue protocol and intentional bounded synchronization; do not replace or repeat it, read other files, or invoke additional tools. Wait for it to finish and return its JSON stdout as your final answer.`,
        },
      });
      await until(current=>current.workQueue?.items.some(item=>(item.progress.state as {stage?:string})?.stage==='armed')===true);
      const armed = state().workQueue!.items.find(item=>(item.progress.state as {stage?:string})?.stage==='armed')!;
      const abandoned = state().workQueue!.claims.find(claim=>claim.id===armed.claimId)!;
      const original = state().tasks.find(task=>task.taskId===abandoned.taskId)!;
      const oldRun = nativeRuns.find(run=>run.runId===original.attempts.at(-1)?.runId)!;
      assert(oldRun?.env, 'Missing original worker IPC binding');
      await call('cancel_task', {taskId:original.taskId});
      await until(current=>current.tasks.find(task=>task.taskId===original.taskId)?.status==='cancelled');
      await assert.rejects(callWorkflow('complete_work', {operationId:randomUUID(),claimId:abandoned.id,generation:abandoned.generation,result:-1}, oldRun.env), /inactive|revoked/);
      await writeFile(join(workspace, 'adopt-ready'), 'ready', {mode:0o600});
      const done = await until(current=>current.script?.status==='result_ready');
      const work = done.workQueue!;
      assert.equal(done.agents!.length, 3);
      assert.equal(observations.length, 3);
      assert(done.sessions.every(session=>session.nativeSessionId));
      assert.equal(work.items.length, 10);
      assert(work.items.every(item=>item.status==='completed'));
      assert.equal(work.claims.filter(claim=>claim.status==='completed').length, 10);
      assert.equal(work.claims.filter(claim=>claim.status==='cancelled').length, 1);
      for (const item of work.items) assert.equal((item.result as {square:number}).square, (item.input as number)**2);
      const adopted = work.items.find(item=>item.id===armed.id)!;
      assert.equal(adopted.generation, 2);
      assert.deepEqual((adopted.result as {inherited:unknown}).inherited, {stage:'armed',partial:7});
      for (const member of ['B', 'C']) assert(work.items.some(item=>(item.result as {member:string}).member===member));
      await call('ack_events', {eventIds:done.events.filter(event=>!event.acknowledged).map(event=>event.id)});
      await call('complete', {reportRef:done.script!.resultRef,openIssues:[],verificationLimits:'Native queue acceptance in an isolated controller; production runtime unchanged. Resource keys do not provide filesystem isolation or exactly-once side effects.'});
      await save(join(directory, 'result.json'), {passed:true,scenario:'queue',backend:test.backend,
        nativeSessions:done.sessions.map(session=>({member:session.actorKey,nativeId:session.nativeSessionId,model:session.observedModel})),
        items:work.items,claims:work.claims,staleSubmissionRejected:true,wakeCount});
      return;
    }
    if(phase==='prepare') {
      await call('run_script',{goal:'Native workflow acceptance: only the specified local checkpoint command and sleep are permitted tools; do not read files, credentials, send external messages, or create agents outside this script.',
        plan:'Validate native session retention, persistent checkpoints, and mailbox wakeups in an isolated test workspace.',
        script:await scriptFor(test),timeoutMs:900_000,maxConcurrent:2,
        ...(test.scenario === 'discussion' ? { args: {
          subject: 'an in-memory cache whose entries expire after 60 seconds; prevent a delayed refresh from overwriting a newer value',
          designerHarness: test.backend, reviewerHarness: test.reviewer, reviewId: test.marker, waitForStart: true,
        } } : {}) });
      if(test.scenario==='interrupt') {
        await until(current=>current.checkpoints?.some(c=>(c.state as {stage?:string})?.stage==='armed')===true && observations.some(o=>o.sleep));
        await call('pause');
        await until(current=>!current.tasks.some(t=>['starting','running','cancelling'].includes(t.status)));
        assert.equal(state().tasks[0]?.resultRefs.length,0,'An interrupted attempt must not commit a final result');
      } else {
        const expectedWaits=test.scenario==='discussion'?2:1;
        await until(current=>current.mailbox?.receipts.filter(r=>r.status==='waiting').length===expectedWaits);
        assert(state().tasks.every(t=>t.status==='result_ready'));
      }
      if(test.scenario==='memory') {
        assert.equal(observations.length,1);
        assert.equal(observations[0]!.tools.length,0,'Memory seed must not write files/checkpoints');
        assert(!JSON.stringify(state().checkpoints).includes(test.marker),'Checkpoint leaked the native-only marker');
        assert(!JSON.stringify(state().tasks.flatMap(t=>t.resultRefs.map(ref=>state().artifacts.find(a=>a.ref===ref)?.text))).includes(test.marker),'Seed output leaked the marker');
      }
      assert(state().sessions.length > 0 && state().sessions.every(session => session.nativeSessionId), 'Missing native session identity');
      await save(join(directory, 'before.json'), {
        pid: process.pid, sessions: state().sessions, checkpoints: state().checkpoints,
        tasks: state().tasks.map(t => ({ taskId: t.taskId, status: t.status, attempts: t.attempts })),
        waits: state().mailbox?.receipts,
      });
    } else {
      assert.equal(state().status,'interrupted');
      await runtime.tick();
      assert.equal(observations.length,0,'Restart must not execute before explicit replay');
      const before=JSON.parse(await readFile(join(directory,'before.json'),'utf8'));
      assert.notEqual(process.pid,before.pid,'Recovery must run in a fresh OS process');
      if (test.scenario !== 'interrupt') {
        await call('send_message', { member: test.scenario === 'discussion' ? 'B' : 'A', text: 'Continue the agreed test now.' });
      }
      assert.equal(observations.length,0,'Queued messages must not implicitly resume an interrupted workflow');
      await call('replay_script');
      const done=await until(current=>current.script?.status==='result_ready');
      const result=JSON.parse(done.artifacts.find(a=>a.ref===done.script!.resultRef)!.text);
      for (const prior of before.sessions) {
        const after = done.sessions.find(s => s.sessionRef === prior.sessionRef);
        assert(after);
        assert.equal(after.nativeSessionId, prior.nativeSessionId, 'Native conversation was replaced');
      }
      if(test.scenario==='memory') {
        assert.equal(observations.length,1,'The completed seed turn must be cached');
        assert.equal(observations[0]!.markerInPrompt,false);
        assert.equal(observations[0]!.tools.length,0,'Recall must use native history, not a file/tool');
        assert.equal(result.marker,test.marker,'Native conversation did not retain the hidden marker');
      } else if(test.scenario==='interrupt') {
        assert.equal(result.stage, 'resumed');
        assert.equal(observations.length, 1);
        assert.equal(observations[0]?.tools.length, 0, 'Recovery repeated a completed checkpoint or sleep');
        assert.equal(done.tasks[0]?.attempts.length, 2);
        assert.equal(done.agents![0]?.checkpointVersion, 2);
      } else {
        assert.equal(result.revised.version, 2);
        assert.equal(result.revised.review_id, test.marker);
        assert.equal(result.review.review_id, test.marker);
        assert(result.revised.addressed?.length > 0);
        assert(result.review.required_change?.length > 0);
        assert.equal(observations.length,2,'Only reviewer and revision turns should run after restart');
        assert(done.mailbox?.receipts.every(receipt=>receipt.status==='consumed'));
      }
      await call('ack_events',{eventIds:state().events.filter(e=>!e.acknowledged).map(e=>e.id)});
      await call('complete',{reportRef:state().script!.resultRef,openIssues:[],verificationLimits:'Native backend acceptance; only isolated workflow runtime restarted. No production bridge restart.'});
      await save(join(directory, 'result.json'), {
        passed: true, scenario: test.scenario, backend: test.backend, reviewer: test.reviewer,
        pid: process.pid, previousPid: before.pid,
        sessions: done.sessions.map(s => ({ member: s.actorKey, nativeId: s.nativeSessionId, model: s.observedModel })),
        checkpointVersions: done.agents?.map(member => ({ member: member.key, version: member.checkpointVersion })),
        attempts: done.tasks.map(task => ({ taskId: task.taskId, attempts: task.attempts.length })),
        receipts: done.mailbox?.receipts.map(receipt => ({ status: receipt.status, key: receipt.key })),
        result, wakeCount,
      });
    }
  } finally {
    await activeRuns.stopAll();
    await runtime.close();
    await save(join(directory,phase+'-observations.json'),observations);
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
  }
}

async function launch(test: Case, phase: string, directory: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const path = join(directory, phase + '.log');
    const log = createWriteStream(path, { flags: 'w', mode: 0o600 });
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url),
      '--project', project, '--output', output, '--child', directory, '--phase', phase,
    ], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    let force: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const stop = () => {
      stopped = true;
      child.kill('SIGTERM');
      force ??= setTimeout(() => child.kill('SIGKILL'), 15_000);
    };
    const timeout = setTimeout(stop, 300_000);
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
    child.once('error', reject);
    log.once('error', error => { stop(); reject(error); });
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      clearTimeout(force);
      process.removeListener('SIGTERM', stop);
      process.removeListener('SIGINT', stop);
      log.end(() => {
        if (code === 0 && !stopped) resolve();
        else reject(new Error(`${test.id} ${phase} failed (${signal ?? code}); see ${path}`));
      });
    });
  });
}

const childDirectory = option('child');
if (childDirectory) {
  const phase = option('phase');
  assert(phase === 'prepare' || phase === 'recover', 'Unsupported phase');
  await childPhase(JSON.parse(await readFile(join(childDirectory, 'case.json'), 'utf8')), phase, childDirectory);
} else {
  const { paths } = await currentProfile();
  const backends = option('backends', 'codex,claude,pi')!.split(',') as Backend[];
  assert(backends.length > 0 && backends.every(b => ['codex', 'claude', 'pi'].includes(b)), 'Unsupported backend');
  const scenarios = option('scenarios', 'memory,interrupt,discussion')!.split(',');
  assert(scenarios.length > 0 && scenarios.every(s => ['memory', 'interrupt', 'discussion', 'queue'].includes(s)), 'Unsupported scenario');
  const cases: Case[] = backends.flatMap(backend => (['memory', 'interrupt', 'queue'] as const)
    .filter(s => scenarios.includes(s))
    .map(scenario => ({
      id: backend + '-' + scenario + '-' + randomUUID().slice(0, 8),
      scenario, backend, marker: randomUUID(), profile: paths.profile,
    })));
  if (scenarios.includes('discussion')) cases.push({
    id: 'discussion-' + randomUUID().slice(0, 8), scenario: 'discussion',
    backend: backends[0]!, reviewer: backends[1] ?? backends[0]!, marker: randomUUID(), profile: paths.profile,
  });
  const results: Array<{ id: string; passed: boolean; error?: string }> = [];
  for (const test of cases) {
    if (cancelled) { process.exitCode = 1; break; }
    const directory = join(output, test.id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await save(join(directory, 'case.json'), test);
    console.log(JSON.stringify({ case: test.id, phase: 'prepare' }));
    try {
      await launch(test, 'prepare', directory);
      assert(!cancelled, 'Acceptance cancelled');
      if (test.scenario !== 'queue') {
        console.log(JSON.stringify({ case: test.id, phase: 'recover' }));
        await launch(test, 'recover', directory);
      }
      results.push({ id: test.id, passed: true });
    } catch (error) {
      results.push({ id: test.id, passed: false, error: String(error) });
    }
    await save(join(output, 'summary.json'), { profile: paths.profile, cancelled, results });
    console.log(JSON.stringify(results.at(-1)));
  }
  if (results.some(result => !result.passed)) process.exitCode = 1;
}
