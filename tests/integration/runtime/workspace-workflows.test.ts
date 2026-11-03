import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBridgeWorkflowRuntime } from '../../../src/workflows/bridge/runtime';
import { RunExecutor } from '../../../src/runtime/run-executor';
import { ProcessPool } from '../../../src/runtime/process-pool';
import { ActiveRuns } from '../../../src/runtime/active-runs';
import { FakeAgentAdapter } from '../../helpers/fake-agent';
import { workspaceCommand } from '../../../src/workflows/engine/workspace-process';
import type { RunPolicyAllow } from '../../../src/policy/run-policy';
import type { AgentEvent, AgentRunOptions } from '../../../src/agent/types';

const closes: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); });
async function git(cwd: string, ...argv: string[]) {
  const result = await workspaceCommand('git', argv, cwd, new AbortController().signal);
  if (result.code) throw new Error(result.stderr); return result.stdout.trim();
}
async function harness(perform?: (opts: AgentRunOptions, index: number) => Promise<string>) {
  const dir = await mkdtemp(join(tmpdir(), 'workspace-runtime-'));
  closes.push(() => rm(dir, { recursive: true, force: true }));
  const repo = join(dir, 'repo'); await mkdir(repo); await git(repo, 'init', '-b', 'main');
  await git(repo, 'config', 'user.name', 'Test'); await git(repo, 'config', 'user.email', 'test@localhost');
  await writeFile(join(repo, 'value.txt'), 'original\n'); await git(repo, 'add', '.'); await git(repo, 'commit', '-m', 'base');
  const root = { scopeId: 'test', profile: 'test', agentKind: 'codex' as const, cwdRealpath: repo, policyFingerprint: 'full', catalogBinding: 'root', modelSettings: {} };
  const policy: RunPolicyAllow = { ok: true, prompt: '', requestedCwd: repo, cwdRealpath: repo, accessMode: 'full', sandbox: 'danger-full-access', permissionMode: 'bypassPermissions', access: { ok: true, reason: 'allowed-user' }, attachments: [], policyFingerprint: 'full', expiresAt: Date.now() + 60_000 };
  const adapter = new FakeAgentAdapter({ id: 'codex', capabilities: { finalAnswer: 'separate-event', input: 'unsupported' } });
  let index = 0;
  const run = adapter.run.bind(adapter);
  adapter.run = opts => {
    const native = run(opts);
    const events = (async function* (): AsyncGenerator<AgentEvent> {
      yield { type: 'system', threadId: opts.threadId ?? randomUUID() };
      const text = await perform?.(opts, ++index) ?? 'done';
      yield { type: 'final_text', content: text }; yield { type: 'done', terminationReason: 'normal' };
    })();
    return { runId: native.runId, events, stop: () => native.stop(), waitForExit: ms => native.waitForExit(ms) };
  };
  const runtime = createBridgeWorkflowRuntime({ path: join(dir, 'workflow.sqlite'), workspaceRoot: join(dir, 'worktrees'),
    executor: new RunExecutor({ resolveAgent: () => adapter, pool: new ProcessPool(() => 4), activeRuns: new ActiveRuns() }),
    resolve: async () => ({ root, policy }), wakeMain: async () => {} });
  await runtime.start();
  closes.push(() => runtime.close());
  const state = () => runtime.kernel.state('test')!;
  const call = (method: string, args: object = {}) => runtime.kernel.call({ kind: 'main', scopeId: 'test', allowStart: true }, method,
    { operationId: randomUUID(), workflowId: state()?.workflowId, expectedStateVersion: state()?.stateVersion, ...(method === 'run_script' ? { goal: 'test workspace', plan: 'isolate and review work' } : {}), ...args });
  const until = async (status: string) => vi.waitFor(async () => { await runtime.tick(); expect(state().script?.status, state().script?.error).toBe(status); }, { timeout: 20_000, interval: 30 });
  return { dir, repo, root, policy, adapter, runtime, call, state, until };
}

const reviewScript = `
  const ws=await createWorkspace({key:'writer'});
  const result=await reviewedAgent('Implement value.txt',{key:'task',criteria:'File must contain correct',maxRounds:2,
    worker:{harness:'codex',model:'writer',workspace:ws.id},reviewer:{harness:'codex',model:'reviewer'}});
  const merged=await integrateChanges({key:'merge',approvals:[result.approval.id]});
  const checks=await checkWorkspace({key:'checks',workspace:merged.workspace.id,commands:[{argv:[args.node,'-e',"if(require('fs').readFileSync('value.txt','utf8').trim()!=='correct')process.exit(1)"]}]});
  const accepted=await acceptIntegration({key:'accept',workspace:merged.workspace.id,checks:checks.id});
  return {result,accepted};`;

describe('workspace script runtime', () => {
  it('runs rework in one member, reviews fixed snapshots independently, integrates and replays', async () => {
    let workers = 0, reviews = 0;
    const h = await harness(async opts => {
      if (opts.model === 'writer') {
        await writeFile(join(opts.cwd!, 'value.txt'), ++workers === 1 ? 'wrong\n' : 'correct\n');
        await git(opts.cwd!, 'add', '.'); await git(opts.cwd!, 'commit', '-m', 'implementation'); return 'Inspect value.txt';
      }
      const value = await readFile(join(opts.cwd!, 'value.txt'), 'utf8'); reviews++;
      return JSON.stringify({ ok: value === 'correct\n', reason: value === 'correct\n' ? 'correct' : 'fix value', evidence: [`Read value.txt: ${value}`] });
    });
    await h.call('run_script', { script: reviewScript, args: { node: process.execPath } }); await h.until('result_ready');
    expect([workers, reviews]).toEqual([2, 2]);
    const result = JSON.parse(h.state().artifacts.at(-1)!.text);
    expect(result.result.rounds).toBe(2); expect(result.accepted.completed).toBe(true);
    expect(await readFile(join(h.repo, 'value.txt'), 'utf8')).toBe('original\n');
    const runs = h.adapter.runOptions;
    expect(runs.every(opts => opts.cwd !== h.repo)).toBe(true);
    expect(runs[0]!.cwd).toBe(runs[2]!.cwd); expect(runs[1]!.cwd).not.toBe(runs[3]!.cwd);
    expect(runs[2]!.threadId).toBeDefined(); expect(runs[1]!.threadId).toBeUndefined();
    await h.call('replay_script'); await h.until('result_ready'); expect(h.adapter.runs).toHaveLength(4);
    expect(JSON.parse(h.state().artifacts.at(-1)!.text)).toEqual(result);
  }, 30_000);

  it('rejects dirty reviewers before recording successful task results', async () => {
    const h = await harness(async opts => {
      if (opts.model === 'writer') { await writeFile(join(opts.cwd!, 'value.txt'), 'correct\n'); await git(opts.cwd!, 'add', '.'); await git(opts.cwd!, 'commit', '-m', 'work'); return 'candidate'; }
      await writeFile(join(opts.cwd!, 'untracked'), 'review contamination');
      return JSON.stringify({ ok: true, reason: 'approved', evidence: ['claimed check'] });
    });
    await h.call('run_script', { script: reviewScript, args: { node: process.execPath } }); await h.until('failed');
    expect(h.state().script!.error).toContain('untracked');
    expect(h.state().tasks.at(-1)!.status).toBe('failed');
  }, 30_000);

  it('requires full authorization and does not change persistent member workspace bindings', async () => {
    const h = await harness(); h.policy.accessMode = 'read-only';
    await h.call('run_script', { script: "return await createWorkspace({key:'a'});" }); await h.until('failed');
    expect(h.state().script!.error).toContain('full-access'); expect(h.adapter.runs).toHaveLength(0);
    h.policy.accessMode = 'full';
    await h.call('replay_script', { plan: 'check workspace member binding', script: `
      const a=await createWorkspace({key:'a'}),b=await createWorkspace({key:'b'});
      await agent('first',{key:'first',member:'writer',workspace:a.id});
      return await agent('second',{key:'second',member:'writer',workspace:b.id});` });
    await h.until('failed'); expect(h.state().script!.error).toContain('workspace'); expect(h.adapter.runs).toHaveLength(1);
  }, 30_000);

  it('reserves workspace keys across all script APIs and rejects simultaneous tasks in one workspace', async () => {
    const h = await harness();
    await h.call('run_script', { script: `const ws=await createWorkspace({key:'a'}); return await agent('task',{key:'a',workspace:ws.id});` });
    await h.until('failed'); expect(h.state().script!.error).toContain('workspace operation');
    await h.call('replay_script', { plan: 'check concurrent ownership', script: `const ws=await createWorkspace({key:'a'});
      await startAgent('first',{key:'first',workspace:ws.id}); return await startAgent('second',{key:'second',workspace:ws.id});` });
    await h.until('failed'); expect(h.state().script!.error).toContain('unfinished task');
  }, 30_000);

  it('retains ownership if the native adapter cannot confirm termination', async () => {
    const h = await harness(); h.adapter.setWaitForExit(false);
    await h.call('run_script', { script: `const ws=await createWorkspace({key:'a'}); return await agent('task',{key:'first',workspace:ws.id});` });
    await h.until('failed'); expect(h.state().script!.error).toContain('termination is uncertain');
    await h.call('replay_script', { plan: 'verify owner retention', script: `const ws=await createWorkspace({key:'a'}); return await freezeWorkspace({key:'freeze',workspace:ws.id});` });
    await h.until('failed'); expect(h.state().script!.error).toContain('Wait for every workspace task');
  }, 30_000);
});
