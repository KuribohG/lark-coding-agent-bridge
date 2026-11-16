import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { normalizeWorkcell, WorkcellPool, workcellRuntimeLayout } from '../../src/agent/pi-sdk/workcell';

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

async function harness(options: { pushFailure?: string } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'workcell-'));
  dirs.push(dir);
  const record = join(dir, 'provider-record.json');
  process.env.FAKE_WORKCELL_RECORD = record;
  if (options.pushFailure) process.env.FAKE_WORKCELL_PUSH_FAILURE = options.pushFailure;
  const pool = new WorkcellPool({
    config: { provider: fixtureProvider(dir), cpu: 4, memoryGb: 8, ttlSeconds: 600, image: 'image:tag' },
    runtime: workcellRuntimeLayout({
      nodePath: '/rt/node_modules/node/bin/node',
      sdkPath: '/rt/node_modules/@earendil-works/pi-coding-agent/dist/index.js',
      hostScript: '/bridge/bin/pi-host.mjs',
    }),
    agentFiles: [join(dir, 'auth.json')],
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
    expect(layout.pushes).toEqual([
      { local: '/rt/node_modules/node', remote: '/opt/lark-workcell/node_modules/node' },
      { local: '/rt/node_modules/@earendil-works', remote: '/opt/lark-workcell/node_modules/@earendil-works' },
      { local: '/bridge/bin', remote: '/opt/lark-workcell/bin' },
    ]);
    expect(layout.nodePath).toBe('/opt/lark-workcell/node_modules/node/bin/node');
    expect(layout.sdkPath).toBe('/opt/lark-workcell/node_modules/@earendil-works/pi-coding-agent/dist/index.js');
    expect(layout.hostScript).toBe('/opt/lark-workcell/bin/pi-host.mjs');
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
      '/opt/lark-workcell/node_modules/node',
      '/opt/lark-workcell/node_modules/@earendil-works',
      '/opt/lark-workcell/bin',
      '/opt/lark-workcell/agent/auth.json',
      '/opt/lark-workcell/node_modules/node',
      '/opt/lark-workcell/node_modules/@earendil-works',
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

  it('drops a half-provisioned workcell when a push fails', async () => {
    const h = await harness({ pushFailure: '/opt/lark-workcell/bin' });
    await expect(h.pool.acquire('member-a')).rejects.toThrow(/cannot push/);
    const calls = await h.calls();
    expect(calls.filter((call) => call.op === 'stop')).toHaveLength(1);
    expect(calls.some((call) => call.op === 'forward')).toBe(false);
  });
});
