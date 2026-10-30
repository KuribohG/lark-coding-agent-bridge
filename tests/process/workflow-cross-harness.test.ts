import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PiAdapter } from '../../src/agent/pi/adapter';
import { WorkflowRuntime } from '../../src/workflows/runtime';
import { callWorkflow } from '../../src/workflows/ipc';
import { resolveWorkerExecution } from '../../src/workflows/execution';
import { createDefaultProfileConfig } from '../../src/config/profile-schema';
import { RunExecutor } from '../../src/runtime/run-executor';
import { ProcessPool } from '../../src/runtime/process-pool';
import { ActiveRuns } from '../../src/runtime/active-runs';
import type { WorkflowRoot } from '../../src/workflows/types';
import type { RunPolicyAllow } from '../../src/policy/run-policy';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'workflow-cross-harness-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const binary = join(dir, 'pi.cjs');
  const record = join(dir, 'runs.jsonl');
  await writeFile(binary, `#!${process.execPath}
const fs = require('node:fs');
if (process.argv.includes('--version')) { console.log('1.3.0'); process.exit(0); }
let prompt = '';
process.stdin.on('data', chunk => prompt += chunk);
process.stdin.on('end', () => {
  const argv = process.argv.slice(2);
  const session = argv.includes('--session') ? argv[argv.indexOf('--session') + 1] : 'pi-child';
  fs.appendFileSync(${JSON.stringify(record)}, JSON.stringify({ argv, prompt, session }) + '\\n');
  const emit = event => console.log(JSON.stringify(event));
  emit({ type: 'session', id: session });
  emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'progress only' } });
  if (prompt.includes('WAIT_FOR_CANCEL')) { setInterval(() => {}, 1000); return; }
  emit({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: prompt.includes('follow-up') ? 'revised proposal' : 'Pi proposal' }] } });
  emit({ type: 'agent_settled', aborted: false });
});
`);
  await chmod(binary, 0o755);
  const root: WorkflowRoot = { scopeId: 'codex-topic', profile: 'codex', agentKind: 'codex', cwdRealpath: dir,
    policyFingerprint: 'root-policy', catalogBinding: 'codex-root-thread', modelSettings: { model: 'codex-only-model' } };
  const policy: RunPolicyAllow = { ok: true, prompt: '', requestedCwd: dir, cwdRealpath: dir,
    accessMode: 'read-only', sandbox: 'read-only', permissionMode: 'plan',
    access: { ok: true, reason: 'allowed-user' }, attachments: [], policyFingerprint: 'root-policy', expiresAt: Date.now() + 60000 };
  const profile = createDefaultProfileConfig({ agentKind: 'pi', pi: { binaryPath: binary },
    accounts: { app: { id: 'test', secret: 'test', tenant: 'feishu' } } });
  const adapter = new PiAdapter({ binary, stopGraceMs: 100 });
  const resolveAgent = vi.fn((scope, kind) => {
    expect(scope).toBe('codex-topic'); expect(kind).toBe('pi'); return adapter;
  });
  const pool = new ProcessPool(() => 3);
  const executor = new RunExecutor({ resolveAgent, pool, activeRuns: new ActiveRuns() });
  const wakeMain = vi.fn(async () => {});
  const runtime = new WorkflowRuntime({ path: ':memory:', executor, resolve: async () => ({ root, policy }), wakeMain,
    resolveWorker: async (boundRoot, selection, rootPolicy) => resolveWorkerExecution(boundRoot, profile, rootPolicy,
      { model: selection.model, reasoningEffort: selection.reasoningEffort }) });
  await runtime.start(); cleanup.push(() => runtime.close());
  const main = runtime.bindMain(root.scopeId, 'start');
  const call = (method: string, args: Record<string, unknown> = {}) => callWorkflow(method,
    { operationId: randomUUID(), expectedStateVersion: runtime.kernel.state(root.scopeId)?.stateVersion, ...(method === 'run_script' || method === 'replay_script' ? {plan:'Review the task with the requested harness and model; return a final result.'} : {}), ...args }, main.env);
  return { runtime, root, profile, call, main, record, resolveAgent, pool, wakeMain };
}

describe('Codex-root workflow with Pi process workers', () => {
  it('accepts scripts through the built CLI, cancels a native process on pause, and replays in a fresh session', async () => {
    const f = await fixture();
    const input = join(dirname(f.record), 'script.json');
    await writeFile(input, JSON.stringify({ operationId: randomUUID(), goal: 'script smoke', plan:'Run a Pi worker and collect its final answer.',
      execution: { agentKind: 'pi', model: 'pi-model' }, script: 'return await agent("WAIT_FOR_CANCEL",{key:"a"});' }));
    const cli = await promisify(execFile)(process.execPath, [resolve('dist/cli.js'), 'workflow', 'run-script', '--input-file', input, '--json'],
      { env: { ...process.env, ...f.main.env } });
    expect(JSON.parse(cli.stdout).script.status).toBe('queued');
    await vi.waitFor(() => expect(f.runtime.kernel.state(f.root.scopeId)?.sessions[0]?.nativeSessionId).toBe('pi-child'), { timeout: 5000 });
    await f.call('pause');
    await vi.waitFor(() => expect(f.runtime.kernel.state(f.root.scopeId)?.tasks[0]?.status).toBe('cancelled'));
    expect(f.runtime.kernel.state(f.root.scopeId)?.tasks[0]?.resultRefs).toEqual([]);
    await f.call('replay_script', { script: 'return await agent("ready",{key:"a"});' });
    await vi.waitFor(() => expect(f.runtime.kernel.state(f.root.scopeId)?.script?.status).toBe('result_ready'), { timeout: 5000 });
    const state = f.runtime.kernel.state(f.root.scopeId)!;
    expect(state.artifacts.find(a => a.ref === state.script?.resultRef)?.text).toBe('"Pi proposal"');
    expect(state.events.map(e => e.kind)).toEqual(['script_result_ready']);
    const runs = (await readFile(f.record, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(runs).toHaveLength(2);
    expect(runs.every(run => !run.argv.includes('--session'))).toBe(true);
  });

  it('routes model-pinned Pi steps back to the root with fresh native sessions', async () => {
    const f = await fixture();
    await f.call('run_script', { goal: 'cross-harness review', execution: { agentKind: 'pi', model: 'pi-only-model', reasoningEffort: 'high' },
      script: 'const a=await agent("independent design",{key:"a"}); const b=await agent("follow-up: "+a,{key:"b"}); return [a,b];' });
    f.main.release();
    await vi.waitFor(() => expect(f.runtime.kernel.state(f.root.scopeId)?.script?.status).toBe('result_ready'), {timeout:5000});
    const state = f.runtime.kernel.state(f.root.scopeId)!;
    expect(state.sessions).toHaveLength(2);
    expect(state.sessions[0]).toMatchObject({ nativeIdKind: 'sessionId', nativeSessionId: 'pi-child', execution: {agentKind:'pi',modelSettings:{model:'pi-only-model'}} });
    expect(state.artifacts.at(-1)?.text).toBe('["Pi proposal","revised proposal"]');
    expect(state.root).toEqual(f.root);
    await f.runtime.kernel.tick(); expect(f.wakeMain).toHaveBeenCalledWith('codex-topic');
    const runs = (await readFile(f.record, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(runs).toHaveLength(2);
    expect(runs.every(run => !run.argv.includes('--session') && run.argv.includes('pi-only-model') && !run.argv.includes('codex-only-model'))).toBe(true);
  });

  it('cancels a running Pi process without accepting its progress', async () => {
    const f = await fixture();
    await f.call('run_script', { goal: 'cancel', script: 'return await agent("WAIT_FOR_CANCEL",{key:"a",harness:"pi"});' });
    await vi.waitFor(() => expect(f.runtime.kernel.state(f.root.scopeId)?.sessions[0]?.nativeSessionId).toBe('pi-child'), {timeout:5000});
    const workflowId = f.runtime.kernel.state(f.root.scopeId)!.workflowId;
    await f.call('cancel');
    await vi.waitFor(() => expect(f.runtime.kernel.state(f.root.scopeId, workflowId)?.tasks[0]?.status).toBe('cancelled'));
    expect(f.runtime.kernel.state(f.root.scopeId, workflowId)?.tasks[0]?.resultRefs).toEqual([]);
    expect(f.runtime.kernel.state(f.root.scopeId)).toBeUndefined();
  });

  it('rejects target configuration drift while a worker waits for admission', async () => {
    const f = await fixture();
    const releases = await Promise.all([f.pool.acquire(), f.pool.acquire(), f.pool.acquire()]);
    await f.call('run_script', { goal: 'drift', script: 'return await agent("design",{key:"a",harness:"pi"});' });
    await vi.waitFor(() => expect(f.runtime.kernel.state(f.root.scopeId)?.tasks[0]?.status).toBe('starting'), {timeout:5000});
    f.profile.pi!.binaryPath = 'replacement-pi';
    releases.forEach(release => release());
    await vi.waitFor(() => expect(f.runtime.kernel.state(f.root.scopeId)?.tasks[0]?.status).toBe('failed'));
    expect(f.resolveAgent).not.toHaveBeenCalled();
    expect(f.runtime.kernel.state(f.root.scopeId)?.tasks[0]?.resultRefs).toEqual([]);
  });
});
