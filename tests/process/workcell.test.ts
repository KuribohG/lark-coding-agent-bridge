import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureRuntimeArchive, normalizeWorkcell, WorkcellPool, workcellRuntimeLayout } from '../../src/agent/pi-sdk/workcell';

const providerFixture = fileURLToPath(new URL('../fixtures/pi-sdk/fake-workcell-provider.mjs', import.meta.url));
const dirs: string[] = [];
const pools: WorkcellPool[] = [];

afterEach(async () => {
  for (const pool of pools.splice(0)) await pool.close();
  delete process.env.FAKE_WORKCELL_RECORD;
  delete process.env.FAKE_WORKCELL_PUSH_FAILURE;
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })));
});

function fixtureProvider(dir: string): string {
  // A shell wrapper keeps the fixture's node path independent of PATH.
  const path = join(dir, 'provider.sh');
  writeFileSync(path, `#!/bin/sh\nexec '${process.execPath}' '${providerFixture}' "$@"\n`, { mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
}

async function harness(options: { pushFailure?: string; archive?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'workcell-'));
  dirs.push(dir);
  const record = join(dir, 'provider-record.json');
  process.env.FAKE_WORKCELL_RECORD = record;
  if (options.pushFailure) process.env.FAKE_WORKCELL_PUSH_FAILURE = options.pushFailure;
  const modulesDir = join(dir, 'rt', 'node_modules');
  mkdirSync(join(modulesDir, 'node', 'bin'), { recursive: true });
  writeFileSync(join(modulesDir, 'node', 'bin', 'node'), '');
  writeFileSync(join(dir, 'rt', 'sdk.js'), '');
  const pool = new WorkcellPool({
    config: { provider: fixtureProvider(dir), cpu: 4, memoryGb: 8, ttlSeconds: 600, image: 'image:tag' },
    runtime: workcellRuntimeLayout({
      nodePath: join(modulesDir, 'node', 'bin', 'node'),
      sdkPath: join(dir, 'rt', 'sdk.js'),
      hostScript: '/bridge/bin/pi-host.mjs',
      ...(options.archive ? { archiveCacheDir: join(dir, 'archive-cache') } : {}),
    }),
    agentFiles: [join(dir, 'auth.json')],
    sessionDir: join(dir, 'sessions'),
  });
  pools.push(pool);
  return {
    dir,
    pool,
    async calls(): Promise<Array<Record<string, unknown>>> {
      try {
        return JSON.parse(readFileSync(record, 'utf8'));
      } catch {
        return [];
      }
    },
  };
}

describe('workcell configuration', () => {
  it('accepts a provider and the optional sizing fields', () => {
    expect(normalizeWorkcell({ provider: '/bin/provider', image: 'img', cpu: 4, memoryGb: 8, ttlSeconds: 3600 }))
      .toEqual({ provider: '/bin/provider', image: 'img', cpu: 4, memoryGb: 8, ttlSeconds: 3600 });
  });

  it.each([
    [{}, /provider/],
    [{ provider: '/bin/provider', cpu: 0 }, /cpu/],
    [{ provider: '/bin/provider', memoryGb: '8' }, /memoryGb/],
    [{ provider: '/bin/provider', image: '' }, /image/],
    [{ provider: '/bin/provider', unknownKey: 1 }, /unknownKey/],
  ])('rejects %j', (input, message) => {
    expect(() => normalizeWorkcell(input)).toThrow(message);
  });
});

describe('workcell runtime layout', () => {
  it('keeps the package layout so the SDK can resolve its siblings', () => {
    const layout = workcellRuntimeLayout({
      nodePath: '/rt/node_modules/node/bin/node',
      sdkPath: '/rt/node_modules/@earendil-works/pi-coding-agent/dist/index.js',
      hostScript: '/bridge/bin/pi-host.mjs',
    });
    expect(layout.pushes).toEqual([{ local: '/bridge/bin', remote: '/opt/lark-workcell/bin' }]);
    expect(layout.modules).toEqual({ local: '/rt/node_modules', remote: '/opt/lark-workcell/node_modules' });
    expect(layout.archive).toBeUndefined();
    expect(layout.nodePath).toBe('/opt/lark-workcell/node_modules/node/bin/node');
    expect(layout.sdkPath).toBe('/opt/lark-workcell/node_modules/@earendil-works/pi-coding-agent/dist/index.js');
    expect(layout.hostScript).toBe('/opt/lark-workcell/bin/pi-host.mjs');
  });
});

describe('workcell runtime archive', () => {
  it('describes a cached archive when a cache directory is given', () => {
    const layout = workcellRuntimeLayout({
      nodePath: '/rt/node_modules/node/bin/node',
      sdkPath: '/rt/node_modules/@earendil-works/pi-coding-agent/dist/index.js',
      hostScript: '/bridge/bin/pi-host.mjs',
      archiveCacheDir: '/state/workcell-runtime',
    });
    expect(layout.archive).toMatchObject({
      cacheDir: '/state/workcell-runtime',
      modulesDir: '/rt/node_modules',
      remote: '/opt/lark-workcell/runtime.tar.gz',
      extractTo: '/opt/lark-workcell',
    });
    expect(layout.archive?.key).toMatch(/^[0-9a-f]{16}$/);
  });

  it('packs the runtime once and reuses the archive', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'workcell-archive-'));
    dirs.push(dir);
    const modulesDir = join(dir, 'node_modules');
    mkdirSync(join(modulesDir, 'pkg'), { recursive: true });
    writeFileSync(join(modulesDir, 'pkg', 'index.js'), 'module.exports = 1;\n');
    const archive = { cacheDir: join(dir, 'cache'), key: 'testkey', modulesDir, remote: '/opt/lark-workcell/runtime.tar.gz', extractTo: '/opt/lark-workcell' };

    const first = await ensureRuntimeArchive(archive);
    const second = await ensureRuntimeArchive(archive);
    expect(first?.bytes).toBeGreaterThan(0);
    expect(second).toEqual(first);
    expect(existsSync(join(archive.cacheDir, 'runtime-testkey.tar.gz'))).toBe(true);
  });
});

describe('workcell pool', () => {
  it('provisions once per key, pushes the runtime and exposes a host port', async () => {
    const h = await harness();
    const first = await h.pool.acquire('member-a');
    const again = await h.pool.acquire('member-a');
    const second = await h.pool.acquire('member-b');

    expect(again.id).toBe(first.id);
    expect(second.id).not.toBe(first.id);
    expect(first.hostPort).toBe(40_001);
    expect(second.hostPort).toBe(40_002);

    const calls = await h.calls();
    const ops = calls.map((call) => call.op);
    expect(ops.filter((op) => op === 'create')).toHaveLength(2);
    // Runtime directories plus the agent file, per workcell.
    expect(calls.filter((call) => call.op === 'push').map((call) => call.remote)).toEqual([
      '/opt/lark-workcell/node_modules',
      '/opt/lark-workcell/bin',
      '/opt/lark-workcell/agent/auth.json',
      '/opt/lark-workcell/node_modules',
      '/opt/lark-workcell/bin',
      '/opt/lark-workcell/agent/auth.json',
    ]);
    expect(calls.find((call) => call.op === 'create')?.spec).toEqual({
      cpu: 4, memoryGb: 8, ttlSeconds: 600, image: 'image:tag', labels: { key: 'member-a' },
    });
  });

  it('starts the host inside the workcell and tears the cell down on release', async () => {
    const h = await harness();
    const cell = await h.pool.acquire('member-a');
    await h.pool.startHost(cell, 'exec node/bin/node bin/pi-host.mjs', { PI_TELEMETRY: '0' });
    await h.pool.release('member-a');

    const calls = await h.calls();
    const exec = calls.find((call) => call.op === 'exec');
    expect(exec).toMatchObject({
      workcell: cell.id,
      script: 'exec node/bin/node bin/pi-host.mjs',
      env: { PI_TELEMETRY: '0' },
      detach: true,
    });
    expect(calls.filter((call) => call.op === 'stop')).toEqual([{ id: expect.any(Number), op: 'stop', workcell: cell.id }]);

    // A released key provisions a fresh workcell rather than reusing a dead one.
    const next = await h.pool.acquire('member-a');
    expect(next.id).not.toBe(cell.id);
  });

  it('restores archived sessions into a new unit for the same key', async () => {
    const h = await harness();
    const archive = join(h.dir, 'sessions', 'member-a');
    mkdirSync(archive, { recursive: true });
    writeFileSync(join(archive, 'session.jsonl'), '{}');

    await h.pool.acquire('member-a');
    const pushes = (await h.calls()).filter((call) => call.op === 'push');
    expect(pushes).toContainEqual(expect.objectContaining({
      workcell: 'cell-1',
      local: archive,
      remote: '/opt/lark-workcell/agent/sessions',
    }));
  });

  it('drops a half-provisioned workcell when a push fails', async () => {
    const h = await harness({ pushFailure: '/opt/lark-workcell/bin' });
    await expect(h.pool.acquire('member-a')).rejects.toThrow(/cannot push/);
    const calls = await h.calls();
    expect(calls.filter((call) => call.op === 'stop')).toHaveLength(1);
    expect(calls.some((call) => call.op === 'forward')).toBe(false);
  });
});
