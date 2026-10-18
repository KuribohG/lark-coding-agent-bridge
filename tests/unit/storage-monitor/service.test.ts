import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseStorageConfig } from '../../../src/monitoring/sources/storage/config';
import { StorageMonitorService } from '../../../src/monitoring/sources/storage/service';
import type { StorageProvider, TaskRun } from '../../../src/monitoring/sources/storage/provider';
import * as atomic from '../../../src/platform/atomic-write';
import type { WorkItemEvent } from '../../../src/work-items/events';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const fn of cleanup.splice(0).reverse()) await fn(); });
async function setup(options: { user?: boolean; declared?: boolean; latency?: boolean } = {}) {
  const folder = await mkdtemp(join(tmpdir(), 'storage-monitor-')); cleanup.push(() => rm(folder, { recursive: true, force: true }));
  let now = 1_800_000_000_000; let failures = 0; let chunks = 100; let latencyMs = 0; let unavailable = false; let stale = false; let platformDown = false; let busy = false;
  let runs: TaskRun[] = [{ id: '123', chainId: 'chain', user: 'alice', status: 'scheduled', nodes: ['n'], pods: ['alice-123-0'] }];
  const config = parseStorageConfig({ outputDir: join(folder, 'evidence'), pollSeconds: 30, recoverySeconds: 60, sustainSeconds: 60,
    latencyMs: options.latency ? 100 : 0, reanalyzeSeconds: 60,
    clusters: [{ id: 'c', datasource: 'metrics', database: 'db' }], platforms: [{ id: 'p', datasource: 'tasks' }],
    watches: [options.user ? { id: 'w', kind: 'user', platform: 'p', uid: 42, clusters: options.declared === false ? [] : ['c'] } : { id: 'w', kind: 'cluster', cluster: 'c' }],
  });
  const provider: StorageProvider = {
    cluster: vi.fn(async () => { if (unavailable) throw new Error('offline'); return { id: 'c', at: now - (stale ? 999000 : 0), connectedNodes: 10,
      io: chunks || failures ? [{ pod: `alice-${runs[0]?.id ?? '123'}-0`, at: now, failures, chunks, latencyMs }] : [] }; }),
    tasks: vi.fn(async () => { if (platformDown) throw new Error('platform offline'); return structuredClone(runs); }),
  };
  const events: WorkItemEvent[] = []; const submit = vi.fn(async (e: WorkItemEvent) => { events.push(structuredClone(e)); });
  const make = () => { const s = new StorageMonitorService(join(folder, 'state.json'), config, provider, submit, () => now, () => busy); cleanup.push(() => s.close()); return s; };
  const service = make(); await service.start(); await service.poll();
  return { folder, config, provider, events, submit, service, make,
    tick: async (delta = 30_000) => { now += delta; await service.poll(); },
    change: (v: { failures?: number; chunks?: number; latencyMs?: number; unavailable?: boolean; stale?: boolean; platformDown?: boolean; busy?: boolean; runs?: TaskRun[] }) => {
      failures = v.failures ?? failures; chunks = v.chunks ?? chunks; latencyMs = v.latencyMs ?? latencyMs;
      unavailable = v.unavailable ?? unavailable; stale = v.stale ?? stale; platformDown = v.platformDown ?? platformDown; busy = v.busy ?? busy; runs = v.runs ?? runs;
    },
  };
}

it('emits no model work while healthy, alerts once on failures, then resolves after fresh recovery windows', async () => {
  const h = await setup(); expect(h.events).toHaveLength(0);
  h.change({ failures: 2 }); await h.tick(); expect(h.events).toHaveLength(1);
  expect(h.events[0]).toMatchObject({ priority: 'high', operation: 'upsert', revision: 1 });
  for (let i = 0; i < 5; i++) await h.tick(); expect(h.events).toHaveLength(1);
  h.change({ failures: 0 }); await h.tick(); await h.tick(); expect(h.events).toHaveLength(1);
  await h.tick(); expect(h.events[1]).toMatchObject({ key: h.events[0]!.key, operation: 'resolve', revision: 2 });
  h.change({ failures: 1 }); await h.tick(); expect(h.events[2]).toMatchObject({ key: h.events[0]!.key, revision: 3 });
});
it('does not use stale data, outages or zero traffic as recovery evidence', async () => {
  const h = await setup(); h.change({ failures: 1 }); await h.tick();
  h.change({ failures: 0, unavailable: true }); for (let i = 0; i < 4; i++) await h.tick();
  expect(h.service.state.statuses['cluster:c']?.state).toBe('unknown');
  h.change({ unavailable: false, stale: true }); await h.tick();
  h.change({ stale: false, chunks: 0 }); for (let i = 0; i < 4; i++) await h.tick();
  expect(h.events).toHaveLength(1);
});
it('requires sustained loaded latency and does not count identical timestamps twice', async () => {
  const h = await setup({ latency: true }); h.change({ latencyMs: 500 });
  await h.tick(); await h.tick(0); await h.tick(0); expect(h.events).toHaveLength(0);
  await h.tick(); expect(h.events).toHaveLength(0); await h.tick(); expect(h.events).toHaveLength(1);
});
it('follows a UID through a new run with the same Chain and discovers additional Chains', async () => {
  const h = await setup({ user: true }); h.change({ failures: 1 }); await h.tick();
  h.change({ runs: [{ id: '124', chainId: 'chain', user: 'alice', status: 'scheduled', nodes: ['n2'], pods: ['alice-124-0'] },
    { id: '125', chainId: 'new-chain', user: 'alice', status: 'queued', nodes: [], pods: [] }] });
  await h.tick(60_000);
  expect(h.service.state.tasks.w?.chains.chain?.history).toEqual(['123', '124']);
  expect(h.service.state.tasks.w?.chains['new-chain']?.run.id).toBe('125');
  expect(h.events[1]).toMatchObject({ key: h.events[0]!.key, data: { tasks: [{ id: '124' }] } });
  expect(h.service.state.statuses['task:p:new-chain']?.state).toBe('unknown');
});
it('reports undeclared coverage and platform failure without fabricating resolution', async () => {
  const h = await setup({ user: true, declared: false }); expect(h.service.state.statuses['watch:w']?.state).toBe('unknown');
  h.change({ failures: 1 }); await h.tick();
  h.change({ failures: 0, platformDown: true }); for (let i = 0; i < 5; i++) await h.tick();
  expect(h.events).toHaveLength(1); expect(h.service.state.statuses['watch:w']?.state).toBe('unknown');
});
it('replays a persisted outbox with exactly the same observation after restart', async () => {
  const h = await setup(); h.submit.mockRejectedValueOnce(new Error('source disconnected'));
  h.change({ failures: 2 }); await h.tick();
  const disk = JSON.parse(await readFile(join(h.folder, 'state.json'), 'utf8'));
  const pending = Object.values(disk.incidents).find((i: any) => i.event) as any;
  expect(pending.event.revision).toBe(1);
  await h.service.close(); const restarted = h.make(); await restarted.start(); await restarted.poll();
  expect(h.events).toHaveLength(1); expect(h.events[0]).toEqual(pending.event);
});
it('does not forget a tracked Chain when an incomplete scan returns no runs', async () => {
  const h = await setup({ user: true }); h.change({ runs: [] }); await h.tick();
  expect(h.service.state.tasks.w?.chains.chain?.run.id).toBe('123');
  expect(h.service.state.statuses['watch:w']?.state).toBe('unknown');
});

it('coalesces material changes while analysis is running and submits them after it finishes', async () => {
  const h = await setup({ user: true }); h.change({ failures: 1 }); await h.tick();
  h.change({ busy: true, runs: [{ id: '124', chainId: 'chain', user: 'alice', status: 'scheduled', nodes: ['n'], pods: ['alice-124-0'] }] });
  await h.tick(60_000); expect(h.events).toHaveLength(1);
  h.change({ busy: false }); await h.tick(); expect(h.events).toHaveLength(2);
});
it('does not lose the alert if writing its evidence file fails', async () => {
  const h = await setup(); const write = atomic.writeFileAtomic;
  const spy = vi.spyOn(atomic, 'writeFileAtomic').mockImplementation((path, data, options) => path.endsWith('/1.json') ? Promise.reject(new Error('disk full')) : write(path, data, options));
  h.change({ failures: 1 }); await h.tick(); expect(h.events).toHaveLength(0);
  spy.mockRestore(); await h.tick(); expect(h.events[0]?.revision).toBe(1);
});
it('does not replace the current run with an older replica observation', async () => {
  const h = await setup({ user: true });
  h.change({ runs: [{ id: '122', chainId: 'chain', user: 'alice', status: 'scheduled', nodes: ['n'], pods: ['alice-122-0'] }] });
  await h.tick(); expect(h.service.state.tasks.w?.chains.chain?.run.id).toBe('123');
  expect(h.service.state.statuses['watch:w']?.state).toBe('unknown');
});
