import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { appendFile, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { callWorkflow, type WorkflowRoot } from '@kuribohg/agent-workflows';
import { ClaudeAdapter } from '../../src/agent/claude/adapter';
import { PiAdapter } from '../../src/agent/pi/adapter';
import type { RunPolicyAllow } from '../../src/policy/run-policy';
import { ActiveRuns } from '../../src/runtime/active-runs';
import { ProcessPool } from '../../src/runtime/process-pool';
import { RunExecutor } from '../../src/runtime/run-executor';
import { createBridgeWorkflowRuntime } from '../../src/workflows/bridge/runtime';
import { runHostRootFor } from '../helpers/run-hosts';
import { createTmpProfile, type TmpProfile } from '../helpers/tmp-profile';

// A stream-json worker that records each process it runs as and finishes only once the test releases it.
const FAKE_CLAUDE = `
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const dir = process.env.FAKE_DIR;
const out = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
appendFileSync(dir + '/pids.log', process.pid + '\\n');
appendFileSync(dir + '/cwd.log', process.cwd() + '\\n');
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

// The same worker as a Pi CLI in RPC mode: it takes commands from stdin, answers
// the session query, and keeps running until the test releases it.
const FAKE_PI = `
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
if (process.argv.includes('--version')) { console.log('pi 999.0.0'); process.exit(0); }
const dir = process.env.FAKE_DIR;
const out = (value, done) => process.stdout.write(JSON.stringify(value) + '\\n', done);
appendFileSync(dir + '/pids.log', process.pid + '\\n');
appendFileSync(dir + '/cwd.log', process.cwd() + '\\n');
writeFileSync(dir + '/env.json', JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([name]) => name.startsWith('AGENT_WORKFLOW_')))));
let pending = '';
function handle(command) {
  if (command.type === 'get_state') {
    out({ id: command.id, type: 'response', command: 'get_state', success: true, data: { sessionId: 'worker-session', isStreaming: true } });
  } else if (command.type === 'steer') {
    out({ id: command.id, type: 'response', command: 'steer', success: true, data: { disposition: 'queued' } });
  } else if (command.type === 'abort') {
    out({ id: command.id, type: 'response', command: 'abort', success: true });
    out({ type: 'agent_settled', aborted: true });
  } else if (command.type === 'clear_queue') {
    out({ id: command.id, type: 'response', command: 'clear_queue', success: true, data: { steering: [], followUp: [] } });
  }
}
process.stdin.on('data', chunk => {
  pending += chunk;
  for (let newline = pending.indexOf('\\n'); newline >= 0; newline = pending.indexOf('\\n')) {
    const line = pending.slice(0, newline);
    pending = pending.slice(newline + 1);
    if (line.trim()) handle(JSON.parse(line));
  }
});
process.stdin.on('end', () => process.exit(0));
const timer = setInterval(() => {
  if (!existsSync(dir + '/release')) return;
  clearInterval(timer);
  out({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'worker finished after restart' }] } });
  out({ type: 'agent_settled', aborted: false }, () => process.exit(0));
}, 20);
`;

describe.skipIf(process.platform === 'win32')('workflow workers under run hosts', () => {
  let tmp: TmpProfile;
  let previousRoot: string | undefined;
  let hostsRoot: string;
  const closers: Array<() => Promise<void>> = [];

  beforeEach(async () => {
    tmp = await createTmpProfile('workflow-run-host-');
    previousRoot = process.env.LARK_RUN_HOST_DIR;
    hostsRoot = runHostRootFor(join(tmp.root, 'hosts'));
    process.env.LARK_RUN_HOST_DIR = hostsRoot;
  });

  afterEach(async () => {
    await writeFile(join(tmp.root, 'release'), '').catch(() => {});
    for (const close of closers.splice(0).reverse()) await close().catch(() => {});
    if (previousRoot === undefined) delete process.env.LARK_RUN_HOST_DIR;
    else process.env.LARK_RUN_HOST_DIR = previousRoot;
    rmSync(hostsRoot, { recursive: true, force: true });
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
    await expect(callWorkflow('read_context', {}, workerEnv)).resolves.toBeTruthy();
    await appendFile(join(tmp.root, 'release'), '');
    await until(() => expect(state().script?.status).toBe('result_ready'));
    expect(await pids()).toHaveLength(1);
    const result = state().artifacts.find(artifact => artifact.ref === state().script!.resultRef)!;
    expect(JSON.parse(result.text)).toBe('worker finished after restart');
    expect(state().tasks.at(-1)!.attempts.at(-1)!.result).toBe('completed');
    // The finished turn released its host.
    await until(() => expect(readdirSync(process.env.LARK_RUN_HOST_DIR!)).toEqual([]));
  }, 40_000);

  it.each(['claude', 'pi'] as const)('keeps a %s worker running in its managed worktree across a bridge restart, and holds the worktree for it meanwhile', async kind => {
    const git = async (cwd: string, ...argv: string[]) => (await promisify(execFile)('git', argv, { cwd })).stdout.trim();
    const repo = join(await realpath(tmp.root), 'repo');
    await mkdir(repo);
    await git(repo, 'init', '-b', 'main'); await git(repo, 'config', 'user.name', 'Test'); await git(repo, 'config', 'user.email', 'test@localhost');
    await writeFile(join(repo, 'README'), 'base\n'); await git(repo, 'add', '.'); await git(repo, 'commit', '-m', 'base');
    const binary = join(tmp.root, `fake-${kind}.mjs`);
    await writeFile(binary, `#!${process.execPath}\n${kind === 'pi' ? FAKE_PI : FAKE_CLAUDE}`, { mode: 0o700 });
    const adapter = kind === 'pi' ? new PiAdapter({ binary, env: { FAKE_DIR: tmp.root } }) : new ClaudeAdapter({ binary, env: { FAKE_DIR: tmp.root } });
    const root: WorkflowRoot = { scopeId: 'topic', profile: 'default', agentKind: kind, cwdRealpath: repo,
      policyFingerprint: 'policy', catalogBinding: 'root', modelSettings: {} };
    const policy: RunPolicyAllow = { ok: true, prompt: '', requestedCwd: repo, cwdRealpath: repo,
      accessMode: 'full', sandbox: 'danger-full-access', permissionMode: 'bypassPermissions',
      access: { ok: true, reason: 'allowed-user' }, attachments: [], policyFingerprint: 'policy', expiresAt: Date.now() + 600_000 };
    const path = join(tmp.profile, 'workflows.sqlite');
    const create = () => createBridgeWorkflowRuntime({
      path, workspaceRoot: join(repo, '..', 'worktrees'), wakeMain: async () => {},
      executor: new RunExecutor({ resolveAgent: () => adapter, pool: new ProcessPool(() => 4), activeRuns: new ActiveRuns() }),
      resolve: async () => ({ root, policy }),
      resolveWorker: async (current, selection) => ({ policy, execution: { agentKind: selection.agentKind, profile: current.profile,
        configurationFingerprint: kind, policyFingerprint: 'policy', modelSettings: {} } }),
    });
    let runtime = create();
    await runtime.start();
    closers.push(() => runtime.close());
    const state = () => runtime.kernel.state(root.scopeId)!;
    const until = (check: () => void | Promise<void>) =>
      vi.waitFor(async () => { await runtime.tick(); await check(); }, { timeout: 10_000, interval: 50 });
    const lines = async (name: string) => (await readFile(join(tmp.root, name), 'utf8')).trim().split('\n');
    /** Who holds the worktree, as the next bridge process will find it. */
    const holder = () => {
      const db = new Database(path + '.workspaces.sqlite', { readonly: true });
      try {
        const row = db.prepare("SELECT data FROM workspace_records WHERE kind='workspace'").get() as { data: string };
        return (JSON.parse(row.data) as { busy?: { hostKey?: string } }).busy;
      } finally { db.close(); }
    };

    const main = runtime.bindMain(root.scopeId, 'start');
    await callWorkflow('run_script', { operationId: randomUUID(), goal: 'hosted worktree worker', plan: 'One Claude worker runs in a worktree until released.',
      script: 'const ws = await createWorkspace({key:"w"}); return await agent("long task", {key:"long", workspace: ws.id});' }, main.env);
    main.release();
    await until(async () => expect(await lines('pids.log')).toHaveLength(1));
    await until(() => expect(state().tasks[0]?.status).toBe('running'));
    const worktree = (await lines('cwd.log'))[0]!;
    expect(worktree.startsWith(join(repo, '..', 'worktrees'))).toBe(true);
    // Beside the host of a Pi run lies the directory of the files it was started with.
    const hosts = readdirSync(process.env.LARK_RUN_HOST_DIR!).filter(name => !name.includes('.'));
    expect(hosts, JSON.stringify({ pids: await lines('pids.log').catch(() => []), hosts: hosts.map(name => {
      const dir = join(process.env.LARK_RUN_HOST_DIR!, name);
      const read = (file: string) => {
        try { return readFileSync(join(dir, file), 'utf8').slice(0, 300); } catch { return undefined; }
      };
      let entries: string[] = [];
      try { entries = readdirSync(dir); } catch { /* gone */ }
      let stat: { isDir: boolean; isFile: boolean; isSocket: boolean; size: number; mode: string; mtimeMs: number } | undefined;
      try {
        const value = statSync(dir);
        stat = { isDir: value.isDirectory(), isFile: value.isFile(), isSocket: value.isSocket(),
          size: value.size, mode: value.mode.toString(8), mtimeMs: value.mtimeMs };
      } catch { /* gone */ }
      let content: string | undefined;
      if (stat?.isFile && stat.size < 200) { try { content = readFileSync(dir, 'utf8'); } catch { /* raced */ } }
      return { name, length: name.length, ...stat, content, entries, spec: read('spec.json'), host: read('host.json') };
    }) })).toHaveLength(1);
    await until(() => expect(holder()).toMatchObject({ hostKey: hosts[0] }));
    const workerEnv = JSON.parse(await readFile(join(tmp.root, 'env.json'), 'utf8')) as Record<string, string>;

    await runtime.close();
    // No bridge runs, and the worker goes on: it commits in its worktree, which nobody else may take.
    expect(holder()).toMatchObject({ hostKey: hosts[0] });
    await writeFile(join(worktree, 'work.txt'), 'done while the bridge was down\n');
    await git(worktree, 'add', '.'); await git(worktree, '-c', 'user.name=Worker', '-c', 'user.email=worker@localhost', 'commit', '-m', 'work');
    // What it asks the bridge meanwhile is answered once the next bridge has taken its turn up.
    const asked = callWorkflow('read_context', {}, workerEnv);
    runtime = create();
    await runtime.start();
    await expect(asked).resolves.toBeTruthy();
    await until(() => expect(state().tasks.at(-1)?.status).toBe('running'));
    expect(holder()).toMatchObject({ hostKey: hosts[0], taskId: state().tasks.at(-1)!.taskId });

    await appendFile(join(tmp.root, 'release'), '');
    await until(() => expect(state().script?.status).toBe('result_ready'));
    expect(await lines('pids.log')).toHaveLength(1);
    const result = state().artifacts.find(artifact => artifact.ref === state().script!.resultRef)!;
    expect(JSON.parse(result.text)).toBe('worker finished after restart');
    expect(holder()).toBeUndefined();
    expect(await git(worktree, 'log', '-1', '--format=%s')).toBe('work');
    await until(() => expect(readdirSync(process.env.LARK_RUN_HOST_DIR!)).toEqual([]));
  }, 60_000);
});
