import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { normalizeInbox } from '../../../src/inbox/config';
import { WorkItemService } from '../../../src/work-items/service';
import { WorkItemStore } from '../../../src/work-items/store';
import { EventSource } from '../../../src/work-items/event-source';
import { AnalysisScheduler } from '../../../src/work-items/scheduler';
import { WorkItemSources } from '../../../src/work-items/registry';
import type { WorkItemRuntime } from '../../../src/work-items/contracts';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });
const result = { text: JSON.stringify({ replyDraft: 'summary', analysis: 'evidence', missingInfo: '' }), inputTokens: 1, outputTokens: 1 };
const topic = { chatId: 'oc_out', threadId: 'omt_out', replyTo: 'om_out' };
const event = { key: 'c', title: 'cluster', reason: 'I/O error', url: '', time: 1000, eventId: '1', revision: 1, data: {}, notice: 'first alert' };
async function setup(io: Partial<WorkItemRuntime> = {}, queue?: AnalysisScheduler) {
  const folder = await mkdtemp(join(tmpdir(), 'source-notices-')); cleanups.push(() => rm(folder, { recursive: true, force: true }));
  const store = new WorkItemStore(join(folder, 'state.json'));
  const runtime: WorkItemRuntime = { source: new EventSource('test', () => true), checkAccess: async () => {},
    investigate: vi.fn(async () => result), deliver: vi.fn(async () => {}), notifyChange: vi.fn(async () => topic), ...io };
  const config = normalizeInbox({ enabled: true, executorProfile: 'p', ownerOpenId: 'ou_owner' });
  let now = 1000;
  const service = new WorkItemService(store, config, runtime, () => now, queue);
  cleanups.push(() => service.close()); await service.start();
  return { service, store, runtime, config, advance: (n: number) => { now += n; } };
}

it('sends an alert before acquiring an analysis slot, and does not duplicate a replay', async () => {
  const queue = new AnalysisScheduler(); let release!: () => void;
  const blocker = queue.run(new AbortController().signal, () => new Promise(resolve => { release = resolve; }));
  await vi.waitFor(() => expect(release).toBeDefined());
  const h = await setup({}, queue);
  try {
    await h.service.observe(event); await h.service.observe(event); await h.service.tick();
    expect(h.runtime.notifyChange).toHaveBeenCalledTimes(1); expect(h.runtime.investigate).not.toHaveBeenCalled();
    release(); await blocker; await vi.waitFor(() => expect(h.runtime.investigate).toHaveBeenCalledTimes(1));
  } finally { release(); await blocker; }
});
it('continues analysis when alert delivery fails, then delivers result into the confirmed topic', async () => {
  const notifyChange = vi.fn().mockRejectedValueOnce(new Error('delivery unavailable')).mockResolvedValue(topic);
  const h = await setup({ notifyChange }); const item = await h.service.observe(event); await h.service.tick();
  await vi.waitFor(() => expect(h.service.get(item.id)?.state).toBe('ready'));
  await h.service.tick(); expect(h.runtime.deliver).not.toHaveBeenCalled();
  h.advance(60_000); await h.service.tick();
  await vi.waitFor(() => expect(h.service.get(item.id)?.analysisTopic).toEqual(topic));
  await h.service.tick();
  expect(h.runtime.deliver).toHaveBeenCalledTimes(1);
  await h.service.observe({ ...event, eventId: '2', revision: 2, operation: 'resolve', notice: 'recovered' });
  await h.service.tick();
  await vi.waitFor(() => expect(notifyChange).toHaveBeenCalledTimes(3));
  expect(notifyChange.mock.calls[2]![0].analysisTopic).toEqual(topic);
  expect(h.runtime.investigate).toHaveBeenCalledTimes(1);
});
it('retains alerts and work items at zero daily model budget', async () => {
  const h = await setup({ dailyAnalysisLimit: 0 }); const item = await h.service.observe(event); await h.service.tick();
  expect(h.runtime.notifyChange).toHaveBeenCalledTimes(1); expect(h.runtime.investigate).not.toHaveBeenCalled();
  expect(h.service.get(item.id)?.state).toBe('queued');
  await h.service.decide(item.id, 'process', 'ou_owner'); await h.service.tick();
  await vi.waitFor(() => expect(h.runtime.investigate).toHaveBeenCalledTimes(1));
});
it('resumes interrupted storage work within budget but preserves a manual pause', async () => {
  const h = await setup({ resumeInterrupted: true }); const item = await h.service.observe(event);
  const paused = await h.service.observe({ ...event, key: 'other', eventId: 'other' });
  const current = h.service.get(paused.id)!;
  await h.service.review({ id: paused.id, revision: current.revision, replyDraft: 'human draft' }, 'ou_owner', 'stop');
  await h.service.close();
  const job = h.store.data.jobs.find(j => j.id === item.id)!; job.state = 'running'; job.external!.analysisAttempts = 1;
  await writeFile(h.store.path, JSON.stringify(h.store.data));
  const restarted = new WorkItemService(new WorkItemStore(h.store.path), h.config,
    { ...h.runtime, source: new EventSource('test', () => true) }, () => 1000);
  cleanups.push(() => restarted.close()); await restarted.start();
  expect(restarted.get(item.id)).toMatchObject({ state: 'queued', analysisPaused: false });
  expect(restarted.get(paused.id)).toMatchObject({ analysisPaused: true, replyDraft: 'human draft' });
});
it('gives incident sources an independent slot while the ordinary queue is occupied', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'source-lanes-')); cleanups.push(() => rm(folder, { recursive: true, force: true }));
  const sources = new WorkItemSources(join(folder, 'config.json'));
  let release!: () => void;
  const blocker = sources.queue.run(new AbortController().signal, () => new Promise(resolve => { release = resolve; }));
  await vi.waitFor(() => expect(release).toBeDefined());
  try {
    const connect = (id: string, lane?: 'incident') => sources.connect({ id, label: id, lane,
      config: normalizeInbox({ enabled: true, executorProfile: 'p', ownerOpenId: 'local:p' }),
      source: new EventSource(id, () => true), runtime: { checkAccess: async () => {}, investigate: async () => result } });
    const normal = await connect('ordinary'); const incident = await connect('urgent', 'incident');
    await normal.observe(event); await incident.observe(event);
    await vi.waitFor(() => expect(sources.list().find(j => j.external?.source === 'urgent')?.external?.analysisAttempts).toBe(1), { timeout: 3500 });
    expect(sources.list().find(j => j.external?.source === 'ordinary')?.external?.analysisAttempts).toBe(0);
  } finally { release(); await blocker; await sources.close(); }
});

it('a slow notification cannot occupy the lifecycle lock or stop investigation', async () => {
  let finish!: (value: typeof topic) => void;
  const h = await setup({ notifyChange: () => new Promise(resolve => { finish = resolve; }) });
  const item = await h.service.observe(event); await h.service.tick();
  try {
    await vi.waitFor(() => expect(h.service.get(item.id)?.state).toBe('ready'));
    expect(finish).toBeDefined();
    await h.service.observe({ ...event, key: 'another', eventId: 'another', notice: undefined });
    expect(h.service.list()).toHaveLength(2);
  } finally { finish(topic); }
});
