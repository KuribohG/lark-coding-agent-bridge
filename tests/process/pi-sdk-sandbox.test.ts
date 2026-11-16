import { existsSync } from 'node:fs';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PiSdkAdapter } from '../../src/agent/pi-sdk/adapter';
import type { AgentEvent } from '../../src/agent/types';
import type { PiConfig } from '../../src/agent/pi/config';
import { DEFAULT_EXEC_SANDBOX } from '../../src/platform/exec-sandbox';

// A shared SDK host serves every session from one process, so the profile
// sandbox is one static Landlock domain applied when the host starts. These
// cases use the compiled launcher and the kernel's own rules: a probe path that
// the test user can normally write must be denied inside the domain, and the
// same probe must succeed without one.

vi.mock('../../src/agent/preflight', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/agent/preflight')>(),
  checkAgentAvailability: vi.fn(async () => ({ ok: true as const, version: 'v22.23.3' })),
}));

const fixtureHost = fileURLToPath(new URL('../fixtures/pi-sdk/fake-host.mjs', import.meta.url));
const launcher = fileURLToPath(new URL('../../bin/landlock-exec', import.meta.url));
// The launcher is a build artifact (`npm run build:native`) and Linux-only.
const sandboxAvailable = process.platform === 'linux' && existsSync(launcher);

const adapters: PiSdkAdapter[] = [];
const dirs: string[] = [];
const envKeys = ['FAKE_HOST_RECORD', 'FAKE_HOST_EVENTS', 'FAKE_HOST_PROBE_UNWRITABLE'];

afterEach(async () => {
  for (const adapter of adapters.splice(0)) await adapter.shutdown();
  for (const key of envKeys) delete process.env[key];
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })));
});

interface Probe {
  dir: string;
  probePath: string;
  adapter: PiSdkAdapter;
  events(): Promise<AgentEvent[]>;
  record(): Promise<{ calls: Array<{ cmd: string }>; probe?: { blocked: boolean; code?: string } }>;
}

/** The probe sits in the home directory: writable for the test user, outside every default sandbox root. */
async function probe(sandbox: boolean): Promise<Probe> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'pi-sdk-sandbox-')));
  dirs.push(dir);
  const recordPath = join(dir, 'host-record.json');
  const probePath = join(homedir(), `.pi-sdk-sandbox-probe-${process.pid}-${Date.now()}-${sandbox ? 'sandboxed' : 'control'}`);
  Object.assign(process.env, {
    FAKE_HOST_RECORD: recordPath,
    FAKE_HOST_EVENTS: JSON.stringify([{ type: 'agent_settled', aborted: false }]),
    FAKE_HOST_PROBE_UNWRITABLE: probePath,
  });
  const config: PiConfig = {
    binaryPath: join(dir, 'pi'),
    transport: 'sdk',
    sdkPath: fixtureHost,
    nodePath: process.execPath,
    hostScript: fixtureHost,
    agentDir: join(dir, 'agent'),
  };
  const adapter = new PiSdkAdapter({
    config,
    systemPrompt: 'PROBE',
    stopGraceMs: 1000,
    ...(sandbox
      ? { sandbox: { settings: { ...DEFAULT_EXEC_SANDBOX, enabled: true, requireLandlock: true }, roots: [dir], launcher } }
      : {}),
  });
  adapters.push(adapter);
  return {
    dir,
    probePath,
    adapter,
    async events() {
      const run = (await adapter.prepareRun({ runId: 'probe', prompt: 'go', cwd: dir })).start();
      const all: AgentEvent[] = [];
      for await (const event of run.events) all.push(event);
      return all;
    },
    async record() {
      return JSON.parse(await readFile(recordPath, 'utf8'));
    },
  };
}

describe.skipIf(!sandboxAvailable)('pi SDK host under a profile Landlock domain', () => {
  it('fails the profile preflight when it requires Landlock and the launcher is gone', async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'pi-sdk-sandbox-')));
    dirs.push(dir);
    const adapter = new PiSdkAdapter({
      config: {
        binaryPath: join(dir, 'pi'),
        transport: 'sdk',
        sdkPath: fixtureHost,
        nodePath: process.execPath,
        hostScript: fixtureHost,
        agentDir: join(dir, 'agent'),
      },
      sandbox: {
        settings: { ...DEFAULT_EXEC_SANDBOX, enabled: true, requireLandlock: true },
        roots: [dir],
        launcher: '/definitely/missing/landlock-exec',
      },
    });
    adapters.push(adapter);
    expect(await adapter.checkAvailability()).toMatchObject({ ok: false });
  });

  it('denies a write outside the profile roots that the same host may make without a domain', async () => {
    // Control: the probe path is writable for this user, so a later denial can
    // only come from the kernel domain, not from ordinary permissions.
    const control = await probe(false);
    expect((await control.events()).at(-1)).toMatchObject({ type: 'done' });
    expect((await control.record()).probe).toEqual({ blocked: false });
    await rm(control.probePath, { force: true });

    const sandboxed = await probe(true);
    const events = await sandboxed.events();
    // The host still serves the session from inside the domain.
    expect(events.at(-1)).toMatchObject({ type: 'done' });
    const record = await sandboxed.record();
    expect(record.probe?.blocked).toBe(true);
    expect(record.probe?.code).toMatch(/EACCES|EPERM/);
    expect(existsSync(sandboxed.probePath)).toBe(false);
    // Its own record file lives under the temp root and stays writable.
    expect(record.calls.map((call) => call.cmd)).toContain('session.open');
  }, 60_000);
});
