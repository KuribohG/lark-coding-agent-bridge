import { existsSync, readlinkSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runDown, runUp, type UpDeps } from '../../src/cli/commands/up';
import { runHandover } from '../../src/deploy/handover';
import { processIdentity } from '../../src/deploy/process';
import type { Release } from '../../src/deploy/release';
import { readState } from '../../src/deploy/state';

// Stands in for bin/lark-channel-bridge.mjs: `config check` passes, `run`
// announces its profiles like the real bridge unless FAKE_MODE says crash.
const FAKE_BRIDGE = `
const args = process.argv.slice(2);
if (args[0] === 'config') process.exit(0);
const at = args.findIndex(a => a === '--profile' || a === '--profiles');
const profiles = args.slice(at + 1, args.indexOf('--config'));
if (process.env.FAKE_MODE === 'crash') { console.log('crashing'); process.exit(3); }
for (const p of profiles) console.log('✓ profile「' + p + '」已上线');
process.on('SIGTERM', () => process.exit(0));
setInterval(() => {}, 1000);
`;

describe.skipIf(process.platform === 'win32')('up / down', () => {
  let root: string;
  let configPath: string;
  let release: Release;
  let lines: string[];
  const pids = new Set<number>();

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'deploy-up-'));
    configPath = join(root, 'config.toml');
    release = { dir: join(root, 'release'), label: 'fake', version: '1.0.0' };
    await mkdir(join(release.dir, 'bin'), { recursive: true });
    await writeFile(join(release.dir, 'bin', 'lark-channel-bridge.mjs'), FAKE_BRIDGE);
    await config('ok');
    lines = [];
  });

  afterEach(async () => {
    for (const state of [readState(join(root, 'deploy'))]) {
      for (const instance of [state.current, state.previous]) if (instance) pids.add(instance.pid);
    }
    for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    pids.clear();
    process.exitCode = undefined;
    await rm(root, { recursive: true, force: true });
  });

  async function config(mode: string): Promise<void> {
    await writeFile(configPath, `version = 3
[deploy]
root = "deploy"
cwd = "${root}"
ready_timeout_seconds = 10
env = { FAKE_MODE = "${mode}" }

[profiles.alpha]
agent = "claude"

[profiles.beta]
agent = "codex"
`);
  }

  const deps = (): UpDeps => ({
    say: line => lines.push(line),
    spawnHandover: async (planPath) => { void runHandover(planPath); },
    resolveRelease: async () => release,
    stableMs: 200,
    stopTimeoutMs: 5000,
    pollMs: 50,
  });

  const current = () => readState(join(root, 'deploy')).current;

  it('starts, keeps, replaces, rolls back and stops the bridge', async () => {
    await runUp({ config: configPath }, deps());
    const first = current()!;
    pids.add(first.pid);
    expect(lines.some(line => line.includes('已上线：pid'))).toBe(true);
    expect(processIdentity(first.pid)).toBe(first.identity);
    expect(first).toMatchObject({ release: release.dir, profiles: ['alpha'], launch: { cwd: root } });
    expect(first.launch.argv.slice(1)).toEqual([join(release.dir, 'bin', 'lark-channel-bridge.mjs'), 'run', '--profile', 'alpha', '--config', configPath]);
    expect(readlinkSync(join(root, 'deploy', 'current'))).toBe(release.dir);
    expect(await readFile(join(root, 'deploy', 'bridge.log'), 'utf8')).toContain('profile「alpha」已上线');

    lines = [];
    await runUp({ config: configPath }, deps());
    expect(lines.at(-1)).toContain('已是最新');
    expect(current()!.pid).toBe(first.pid);

    // A launch setting changed, but the new process never comes online.
    await config('crash');
    lines = [];
    await runUp({ config: configPath, plan: true }, deps());
    expect(lines.at(-1)).toContain('替换运行中的 bridge');
    expect(current()!.pid).toBe(first.pid);
    await runUp({ config: configPath }, deps());
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
    expect(lines.at(-1)).toMatch(/已恢复旧进程/);
    expect(processIdentity(first.pid)).toBeUndefined();
    const restored = current()!;
    pids.add(restored.pid);
    expect(restored.pid).not.toBe(first.pid);
    expect(processIdentity(restored.pid)).toBe(restored.identity);

    // The restored bridge already runs the reverted config; replacing it takes --restart.
    await config('ok');
    lines = [];
    await runUp({ config: configPath }, deps());
    expect(lines.at(-1)).toContain('已是最新');
    await runUp({ config: configPath, restart: true }, deps());
    const replaced = readState(join(root, 'deploy'));
    pids.add(replaced.current!.pid);
    expect(lines.some(line => line.includes(`pid ${replaced.current!.pid}`))).toBe(true);
    expect(replaced.previous?.pid).toBe(restored.pid);
    expect(processIdentity(restored.pid)).toBeUndefined();

    lines = [];
    await runDown({ config: configPath }, { say: line => lines.push(line), stopTimeoutMs: 5000 });
    expect(lines).toEqual([`已停止 pid ${replaced.current!.pid}（alpha）`]);
    expect(processIdentity(replaced.current!.pid)).toBeUndefined();
    expect(readState(join(root, 'deploy'))).toEqual({ previous: replaced.current });
    expect(existsSync(join(root, 'deploy', 'handover'))).toBe(true);
  }, 60_000);

  it('goes back to the previous release on request', async () => {
    await runUp({ config: configPath }, deps());
    const first = current()!;
    pids.add(first.pid);
    const second: Release = { dir: join(root, 'release-2'), label: 'fake-2', version: '2.0.0' };
    await mkdir(join(second.dir, 'bin'), { recursive: true });
    await writeFile(join(second.dir, 'bin', 'lark-channel-bridge.mjs'), FAKE_BRIDGE);
    await runUp({ config: configPath }, { ...deps(), resolveRelease: async () => second });
    pids.add(current()!.pid);
    expect(current()).toMatchObject({ release: second.dir, version: '2.0.0' });

    await runUp({ config: configPath, rollback: true }, deps());
    pids.add(current()!.pid);
    expect(current()).toMatchObject({ release: release.dir, version: '1.0.0' });
    expect(readState(join(root, 'deploy')).previous).toMatchObject({ release: second.dir });
  }, 60_000);
});
