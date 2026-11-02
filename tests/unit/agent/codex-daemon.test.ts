import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  daemonEnvironmentFingerprint,
  ensureCodexAppServerDaemon,
  attachedDaemonRuns,
  onDaemonIdle,
  trackDaemonRun,
} from '../../../src/agent/codex/daemon';
import { CodexAdapter } from '../../../src/agent/codex/adapter';
import type { AgentEvent, AgentRun } from '../../../src/agent/types';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

/** Fake `codex app-server daemon ...` that keeps its state in CODEX_HOME. */
async function fakeCodex(running: boolean) {
  const home = await mkdtemp(join(tmpdir(), 'codex-daemon-')); dirs.push(home);
  const binary = join(home, 'codex');
  await writeFile(binary, `#!/bin/sh
echo "$3" >> "$CODEX_HOME/calls"
case "$3" in
  version) if [ -f "$CODEX_HOME/running" ]; then echo '{"status":"running","socketPath":"/tmp/codex.sock","pid":42}'; exit 0; fi; exit 1;;
  start) touch "$CODEX_HOME/running";;
  stop) rm -f "$CODEX_HOME/running";;
esac
`);
  await chmod(binary, 0o755);
  if (running) await writeFile(join(home, 'running'), '');
  const env = { PATH: process.env.PATH, CODEX_HOME: home };
  const calls = async () => (await readFile(join(home, 'calls'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean);
  return { home, binary, env, calls };
}

function controllableRun(): { run: AgentRun; finish(): void } {
  let finish!: () => void;
  const done = new Promise<void>(resolve => { finish = resolve; });
  const run = {
    runId: 'r', stop: async () => {}, waitForExit: async () => true,
    events: (async function* (): AsyncGenerator<AgentEvent> { await done; })(),
  } as AgentRun;
  return { run, finish };
}

describe('codex app-server daemon environment', () => {
  it('adopts a daemon started before fingerprints existed', async () => {
    const codex = await fakeCodex(true);
    const status = await ensureCodexAppServerDaemon({ binary: codex.binary, env: codex.env, fingerprint: 'a' });
    expect(status.socketPath).toBe('/tmp/codex.sock');
    expect(await codex.calls()).toEqual(['version']);
    expect((await readFile(join(codex.home, '.bridge-app-server-env'), 'utf8')).trim()).toBe('a');
  });

  it('restarts an idle daemon whose launch environment changed', async () => {
    const codex = await fakeCodex(true);
    await writeFile(join(codex.home, '.bridge-app-server-env'), 'old\n');
    await ensureCodexAppServerDaemon({ binary: codex.binary, env: codex.env, fingerprint: 'new' });
    expect(await codex.calls()).toEqual(['version', 'stop', 'start', 'version']);
    expect((await readFile(join(codex.home, '.bridge-app-server-env'), 'utf8')).trim()).toBe('new');
  });

  it('defers the restart while runs are attached and restarts once they finish', async () => {
    const codex = await fakeCodex(true);
    await writeFile(join(codex.home, '.bridge-app-server-env'), 'old\n');
    const { run, finish } = controllableRun();
    const tracked = trackDaemonRun({ binary: codex.binary, env: codex.env }, run);
    const consumed = (async () => { for await (const _ of tracked.events) { /* drain */ } })();
    await ensureCodexAppServerDaemon({ binary: codex.binary, env: codex.env, fingerprint: 'new' });
    expect(await codex.calls()).toEqual(['version']);

    finish(); await consumed;
    await ensureCodexAppServerDaemon({ binary: codex.binary, env: codex.env, fingerprint: 'new' });
    expect(await codex.calls()).toEqual(['version', 'version', 'stop', 'start', 'version']);
  });

  it('keeps run methods bound to the original run', async () => {
    const codex = await fakeCodex(false);
    class Run {
      readonly runId = 'r';
      #stopped = false;
      events = (async function* (): AsyncGenerator<AgentEvent> {})();
      async stop() { this.#stopped = true; }
      get stopped() { return this.#stopped; }
      async waitForExit() { return true; }
    }
    const original = new Run();
    const tracked = trackDaemonRun({ binary: codex.binary, env: codex.env }, original as unknown as AgentRun);
    await tracked.stop();
    expect(original.stopped).toBe(true);
  });

  it('fingerprints only defined values, independent of key order', () => {
    expect(daemonEnvironmentFingerprint({ B: '2', A: '1', C: undefined }))
      .toBe(daemonEnvironmentFingerprint({ A: '1', B: '2' }));
    expect(daemonEnvironmentFingerprint({ A: '1' })).not.toBe(daemonEnvironmentFingerprint({ A: '2' }));
  });

  it('blocks replacing a busy daemon adapter only when the daemon would have to restart', async () => {
    const codex = await fakeCodex(true);
    const adapter = (env: Record<string, string>) => new CodexAdapter({ binary: codex.binary, appServerMode: 'daemon',
      codexHome: codex.home, profileStateDir: codex.home, env, systemPrompt: '' });
    const current = adapter({ A: '1' });
    expect(await current.replacementBlocker(adapter({ A: '2' }), { providersChanged: false })).toBeUndefined();
    const { run, finish } = controllableRun();
    const tracked = trackDaemonRun({ binary: codex.binary, env: { CODEX_HOME: codex.home } }, run);
    const consumed = (async () => { for await (const _ of tracked.events) { /* drain */ } })();
    const idle = vi.fn();
    const stop = onDaemonIdle(idle);
    expect(await current.replacementBlocker(adapter({ A: '1' }), { providersChanged: false })).toBeUndefined();
    expect(await current.replacementBlocker(adapter({ A: '2' }), { providersChanged: false })).toContain('1 个任务');
    expect(await current.replacementBlocker(adapter({ A: '1' }), { providersChanged: true })).toContain('1 个任务');
    finish(); await consumed; stop();
    expect(idle).toHaveBeenCalledOnce();
    expect(await current.replacementBlocker(adapter({ A: '2' }), { providersChanged: true })).toBeUndefined();
  });

  it('defers even a provider-driven restart while runs are attached', async () => {
    const codex = await fakeCodex(true);
    const { run } = controllableRun();
    const tracked = trackDaemonRun({ binary: codex.binary, env: codex.env }, run);
    const status = await ensureCodexAppServerDaemon({ binary: codex.binary, env: codex.env, restart: true });
    expect(status.restartDeferred).toBe(true);
    expect(await codex.calls()).toEqual(['version']);
    await tracked.stop();
    const restarted = await ensureCodexAppServerDaemon({ binary: codex.binary, env: codex.env, restart: true });
    expect(restarted.restartDeferred).toBeUndefined();
    expect(await codex.calls()).toEqual(['version', 'version', 'stop', 'start', 'version']);
  });

  it('releases an attached run whose events are never consumed once it exits', async () => {
    const codex = await fakeCodex(false);
    const { run } = controllableRun();
    const tracked = trackDaemonRun({ binary: codex.binary, env: codex.env }, run);
    expect(attachedDaemonRuns(codex.binary, codex.home)).toBe(1);
    expect(await tracked.waitForExit(10)).toBe(true);
    expect(attachedDaemonRuns(codex.binary, codex.home)).toBe(0);
    await tracked.stop();
    expect(attachedDaemonRuns(codex.binary, codex.home)).toBe(0);
  });
});
