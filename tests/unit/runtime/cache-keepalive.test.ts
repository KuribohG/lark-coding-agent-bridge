import { expect, it, vi } from 'vitest';
import { CacheKeepalive, type CachePing } from '../../../src/runtime/cache-keepalive';
import type { CacheKeepaliveSettings } from '../../../src/config/schema';

const MIN = 60_000;
const T0 = 1_000_000_000_000;
const hit: CachePing = { promptTokens: 300_000, cachedTokens: 299_000 };

function setup(over: { settings?: CacheKeepaliveSettings | undefined; ping?: () => Promise<CachePing | undefined> } = {}) {
  const world = { now: T0, idle: true, waiting: true, last: T0 as number | undefined,
    settings: 'settings' in over ? over.settings : { intervalMs: 50 * MIN, maxPings: 3, minContextTokens: 100_000 } };
  const ping = vi.fn(over.ping ?? (async () => hit));
  const keepalive = new CacheKeepalive({
    scopes: () => world.waiting ? ['topic'] : [], settings: () => world.settings, isIdle: () => world.idle,
    lastActivity: async () => world.last, ping, now: () => world.now,
  });
  const at = async (minutes: number) => { world.now = T0 + minutes * MIN; await keepalive.tick(); };
  return { world, ping, at };
}

it('re-reads the cache once per interval and gives up after the configured number of requests', async () => {
  const { ping, at } = setup();
  await at(49);
  expect(ping).not.toHaveBeenCalled();
  await at(50);
  await at(51);
  expect(ping).toHaveBeenCalledTimes(1);
  await at(100);
  await at(150);
  await at(200);
  await at(250);
  expect(ping).toHaveBeenCalledTimes(3);
});

it('starts a new idle period after each turn, timed from when the turn was last seen running', async () => {
  const { world, ping, at } = setup();
  await at(50);
  world.idle = false;
  await at(70);
  world.idle = true;
  await at(71);
  await at(119);
  expect(ping).toHaveBeenCalledTimes(1);
  await at(120);
  expect(ping).toHaveBeenCalledTimes(2);
});

it.each([
  ['the request missed the cache', async () => ({ promptTokens: 300_000, cachedTokens: 20_000 })],
  ['the session is too small to be worth it', async () => ({ promptTokens: 40_000, cachedTokens: 40_000 })],
  ['no request could be made', async () => undefined],
  ['the request failed', async () => { throw new Error('spawn failed'); }],
])('stops for the rest of the idle period when %s', async (_name, result) => {
  const { ping, at } = setup({ ping: result as () => Promise<CachePing | undefined> });
  await at(50);
  await at(100);
  await at(150);
  expect(ping).toHaveBeenCalledTimes(1);
});

it('does not send a request the cache has probably not survived', async () => {
  const { world, ping, at } = setup();
  await at(56);
  expect(ping).not.toHaveBeenCalled();
  await at(106);
  expect(ping).not.toHaveBeenCalled();
  // The next turn makes the cache warm again.
  world.idle = false;
  await at(110);
  world.idle = true;
  await at(160);
  expect(ping).toHaveBeenCalledTimes(1);
});

it('stays quiet while switched off, without a known last turn, or once the workflow is over', async () => {
  const off = setup({ settings: undefined });
  await off.at(50);
  expect(off.ping).not.toHaveBeenCalled();

  const unknown = setup();
  unknown.world.last = undefined;
  await unknown.at(50);
  expect(unknown.ping).not.toHaveBeenCalled();

  const done = setup();
  done.world.waiting = false;
  await done.at(50);
  expect(done.ping).not.toHaveBeenCalled();
});

it('ignores the answer of a request that a new turn overtook', async () => {
  let release!: (value: CachePing) => void;
  let calls = 0;
  const { world, ping, at } = setup({ ping: () => calls++ ? Promise.resolve(hit) : new Promise<CachePing>(resolve => { release = resolve; }) });
  const first = at(50);
  await vi.waitFor(() => expect(ping).toHaveBeenCalledTimes(1));
  world.idle = false;
  world.now = T0 + 51 * MIN;
  release({ promptTokens: 300_000, cachedTokens: 0 });
  await first;
  await at(52);
  world.idle = true;
  // The miss belonged to the previous idle period; this one still gets its request.
  await at(102);
  expect(ping).toHaveBeenCalledTimes(2);
});
