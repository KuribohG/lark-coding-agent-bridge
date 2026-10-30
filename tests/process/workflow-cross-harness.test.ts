import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  const main = runtime.bindMain(root.scopeId);
  const call = (method: string, args: Record<string, unknown> = {}) => callWorkflow(method,
    { operationId: randomUUID(), expectedStateVersion: runtime.kernel.state(root.scopeId)?.stateVersion, ...args }, main.env);
  await call('start', { pluginId: 'architecture-review', goal: 'Cross-harness design' });
  return { runtime, root, profile, call, main, record, resolveAgent, pool, wakeMain };
}

describe('Codex-root workflow with Pi process workers', () => {
  it('routes Pi results back to the root and continues the same Pi session', async () => {
    const f = await fixture();
    await f.call('delegate', { role: 'designer-b', taskKey: 'b', actorKey: 'b', objective: 'independent design',
      execution: { agentKind: 'pi', model: 'pi-only-model', reasoningEffort: 'high' } });
    f.main.release();
    await vi.waitFor(() => expect(f.runtime.kernel.state(f.root.scopeId)?.tasks[0]?.status).toBe('result_ready'));
    const state = f.runtime.kernel.state(f.root.scopeId)!;
    expect(state.sessions[0]).toMatchObject({ nativeIdKind: 'sessionId', nativeSessionId: 'pi-child',
      execution: { agentKind: 'pi', modelSettings: { model: 'pi-only-model' } } });
    expect(state.artifacts.at(-1)?.text).toBe('Pi proposal');
    expect(state.root).toEqual(f.root);
    await f.runtime.kernel.tick(); expect(f.wakeMain).toHaveBeenCalledWith('codex-topic');
    const resumed = f.runtime.bindMain(f.root.scopeId);
    await callWorkflow('send', { operationId: randomUUID(), expectedStateVersion: f.runtime.kernel.state(f.root.scopeId)!.stateVersion,
      taskId: state.tasks[0]!.taskId, inputId: 'follow-up', text: 'follow-up on failure handling' }, resumed.env);
    await vi.waitFor(() => expect(f.runtime.kernel.state(f.root.scopeId)?.tasks[0]?.resultRefs).toHaveLength(2));
    expect(f.runtime.kernel.state(f.root.scopeId)?.artifacts.at(-1)?.text).toBe('revised proposal');
    const runs = (await readFile(f.record, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(runs).toHaveLength(2);
    expect(runs[1].session).toBe('pi-child');
    expect(runs[1].argv).toContain('--session');
    expect(runs.every(run => run.argv.includes('pi-only-model') && !run.argv.includes('codex-only-model'))).toBe(true);
  });

  it('cancels a running Pi process without accepting its progress', async () => {
    const f = await fixture();
    await f.call('delegate', { role: 'designer-a', taskKey: 'a', actorKey: 'a', objective: 'WAIT_FOR_CANCEL', execution: { agentKind: 'pi' } });
    await vi.waitFor(() => expect(f.runtime.kernel.state(f.root.scopeId)?.sessions[0]?.nativeSessionId).toBe('pi-child'));
    const workflowId = f.runtime.kernel.state(f.root.scopeId)!.workflowId;
    await f.call('cancel');
    await vi.waitFor(() => expect(f.runtime.kernel.state(f.root.scopeId, workflowId)?.tasks[0]?.status).toBe('cancelled'));
    expect(f.runtime.kernel.state(f.root.scopeId, workflowId)?.tasks[0]?.resultRefs).toEqual([]);
    expect(f.runtime.kernel.state(f.root.scopeId)).toBeUndefined();
  });

  it('rejects target configuration drift while a worker waits for admission', async () => {
    const f = await fixture();
    const releases = await Promise.all([f.pool.acquire(), f.pool.acquire(), f.pool.acquire()]);
    await f.call('delegate', { role: 'designer-a', taskKey: 'a', actorKey: 'a', objective: 'design', execution: { agentKind: 'pi' } });
    await vi.waitFor(() => expect(f.runtime.kernel.state(f.root.scopeId)?.tasks[0]?.status).toBe('starting'));
    f.profile.pi!.binaryPath = 'replacement-pi';
    releases.forEach(release => release());
    await vi.waitFor(() => expect(f.runtime.kernel.state(f.root.scopeId)?.tasks[0]?.status).toBe('failed'));
    expect(f.resolveAgent).not.toHaveBeenCalled();
    expect(f.runtime.kernel.state(f.root.scopeId)?.tasks[0]?.resultRefs).toEqual([]);
  });
});
