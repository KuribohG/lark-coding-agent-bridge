import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { callWorkflow, type WorkflowRoot } from '@kuribohg/agent-workflows';
import { ClaudeAdapter } from '../../src/agent/claude/adapter';
import type { RunPolicyAllow } from '../../src/policy/run-policy';
import { ActiveRuns } from '../../src/runtime/active-runs';
import { ProcessPool } from '../../src/runtime/process-pool';
import { RunExecutor } from '../../src/runtime/run-executor';
import { createBridgeWorkflowRuntime } from '../../src/workflows/bridge/runtime';
import { createTmpProfile, type TmpProfile } from '../helpers/tmp-profile';

// A stream-json worker that records each process it runs as and finishes only once the test releases it.
const FAKE_CLAUDE = `
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const dir = process.env.FAKE_DIR;
const out = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
appendFileSync(dir + '/pids.log', process.pid + '\\n');
writeFileSync(dir + '/env.json', JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([name]) => name.startsWith('AGENT_WORKFLOW_')))));
out({ type: 'system', subtype: 'init', session_id: 'worker-session' });
const uuids = [];
createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.type === 'user') {
    uuids.push(message.uuid);
    out({ type: 'user', isReplay: true, uuid: message.uuid, message: message.message });
  }
});
process.stdin.on('end', () => process.exit(0));
const timer = setInterval(() => {
  if (!existsSync(dir + '/release')) return;
  clearInterval(timer);
  out({ type: 'result', subtype: 'success', result: 'worker finished after restart', session_id: 'worker-session', user_message_uuids: uuids });
}, 20);
`;

describe.skipIf(process.platform === 'win32')('workflow workers under run hosts', () => {
  let tmp: TmpProfile;
  let previousRoot: string | undefined;
  const closers: Array<() => Promise<void>> = [];

  beforeEach(async () => {
    tmp = await createTmpProfile('workflow-run-host-');
    previousRoot = process.env.LARK_RUN_HOST_DIR;
    process.env.LARK_RUN_HOST_DIR = join(tmp.root, 'hosts');
  });

  afterEach(async () => {
    await writeFile(join(tmp.root, 'release'), '').catch(() => {});
    for (const close of closers.splice(0).reverse()) await close().catch(() => {});
    if (previousRoot === undefined) delete process.env.LARK_RUN_HOST_DIR;
    else process.env.LARK_RUN_HOST_DIR = previousRoot;
    await tmp.cleanup();
  });

  it('keeps a running worker across a bridge restart and delivers its result to the replayed script', async () => {
    const binary = join(tmp.root, 'fake-claude.mjs');
    await writeFile(binary, `#!${process.execPath}\n${FAKE_CLAUDE}`, { mode: 0o700 });
    const adapter = new ClaudeAdapter({ binary, env: { FAKE_DIR: tmp.root } });
    const root: WorkflowRoot = { scopeId: 'topic', profile: 'default', agentKind: 'claude', cwdRealpath: tmp.workspace,
      policyFingerprint: 'policy', catalogBinding: 'root', modelSettings: {} };
    const policy: RunPolicyAllow = { ok: true, prompt: '', requestedCwd: tmp.workspace, cwdRealpath: tmp.workspace,
      accessMode: 'full', sandbox: 'danger-full-access', permissionMode: 'bypassPermissions',
      access: { ok: true, reason: 'allowed-user' }, attachments: [], policyFingerprint: 'policy', expiresAt: Date.now() + 600_000 };
    const notify = vi.fn(async (_state: unknown, _text: string) => {});
    const create = () => createBridgeWorkflowRuntime({
      path: join(tmp.profile, 'workflows.sqlite'), notify, wakeMain: async () => {},
      executor: new RunExecutor({ resolveAgent: () => adapter, pool: new ProcessPool(() => 4), activeRuns: new ActiveRuns() }),
      resolve: async () => ({ root, policy }),
      resolveWorker: async (current, selection) => ({ policy, execution: { agentKind: selection.agentKind, profile: current.profile,
        configurationFingerprint: 'claude', policyFingerprint: 'policy', modelSettings: {} } }),
    });
    let runtime = create();
    await runtime.start();
    closers.push(() => runtime.close());
    const state = () => runtime.kernel.state(root.scopeId)!;
    const until = (check: () => void | Promise<void>) =>
      vi.waitFor(async () => { await runtime.tick(); await check(); }, { timeout: 10_000, interval: 50 });
    const pids = async () => (await readFile(join(tmp.root, 'pids.log'), 'utf8')).trim().split('\n');

    const main = runtime.bindMain(root.scopeId, 'start');
    await callWorkflow('run_script', { operationId: randomUUID(), goal: 'hosted worker', plan: 'One Claude worker runs until released.',
      script: 'return await agent("long task", {key:"long"});' }, main.env);
    main.release();
    await until(async () => expect(await pids()).toHaveLength(1));
    const workerEnv = JSON.parse(await readFile(join(tmp.root, 'env.json'), 'utf8')) as Record<string, string>;
    expect(workerEnv.AGENT_WORKFLOW_ENDPOINT_FILE).toBe(join(tmp.profile, 'workflows.sqlite.endpoint.json'));
    await until(() => expect(state().tasks[0]?.status).toBe('running'));

    await runtime.close();
    runtime = create();
    await runtime.start();
    expect(notify.mock.calls.at(-1)![1]).toContain('已自动续跑');

    // The original process, still running under its host, answers the worker's tool calls on the new endpoint.
    await until(() => expect(state().tasks.at(-1)?.status).toBe('running'));
    await expect(callWorkflow('task_status', {}, workerEnv)).resolves.toBeTruthy();
    await appendFile(join(tmp.root, 'release'), '');
    await until(() => expect(state().script?.status).toBe('result_ready'));
    expect(await pids()).toHaveLength(1);
    const result = state().artifacts.find(artifact => artifact.ref === state().script!.resultRef)!;
    expect(JSON.parse(result.text)).toBe('worker finished after restart');
    expect(state().tasks.at(-1)!.attempts.at(-1)!.result).toBe('completed');
    // The finished turn released its host.
    await until(() => expect(readdirSync(process.env.LARK_RUN_HOST_DIR!)).toEqual([]));
  }, 40_000);
});
