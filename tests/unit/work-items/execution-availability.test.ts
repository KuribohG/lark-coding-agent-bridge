import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { WorkItemService } from '../../../src/work-items/service';
import { WorkItemStore } from '../../../src/work-items/store';
import { EventSource } from '../../../src/work-items/event-source';
import { WorkItemScheduler } from '../../../src/work-items/scheduler';
import type { WorkItemConfig } from '../../../src/work-items/config';
import type { WorkItemRuntime } from '../../../src/work-items/contracts';
import { workItemTarget } from '../../../src/inbox/lark-target';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const result = { text: JSON.stringify({ replyDraft: 'draft', analysis: 'evidence', missingInfo: '' }), inputTokens: 1, outputTokens: 2 };
const event = { key: 'issue', title: 'issue', reason: 'failure', time: 1000, url: '', eventId: '1', revision: 1, data: {} };
async function setup(extra: Partial<WorkItemRuntime> = {}, queue?: WorkItemScheduler) {
  const dir = await mkdtemp(join(tmpdir(), 'execution-availability-')); cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'state.json');
  const config: WorkItemConfig = { enabled: true, executorProfile: 'local', ownerKey: 'local:owner',
    target: workItemTarget({ chatId: 'oc_local', threadId: 'omt_local', replyTo: 'om_local' }),
    autoAnalyze: false, dailyTriageLimit: 0 };
  let available = false;
  const investigate = vi.fn(async () => result);
  const create = async () => {
    const store = new WorkItemStore(path);
    const service = new WorkItemService(store, config, { source: new EventSource('fixture', () => true),
      dailyAnalysisLimit: 10, checkAccess: async () => {}, canInvestigate: () => available, investigate, ...extra }, () => 1000, queue);
    cleanups.push(() => service.close()); await service.start(); return { service, store };
  };
  return { ...await create(), create, path, investigate, available: (value: boolean) => { available = value; } };
}

it('persists queued evidence without attempts or quota use, then resumes after restart while preserving a manual pause', async () => {
  const h = await setup();
  const pending = await h.service.observe(event);
  const paused = await h.service.observe({ ...event, key: 'paused' });
  await h.service.review({ id: paused.id, revision: paused.revision, replyDraft: 'human draft' }, 'local:owner', 'edit');
  await h.service.tick();
  expect(h.investigate).not.toHaveBeenCalled();
  expect(h.service.get(pending.id)).toMatchObject({ state: 'queued', external: { analysisAttempts: 0 } });
  expect(h.store.data.autoUsage).toEqual({});
  const saved = JSON.parse(await readFile(h.path, 'utf8'));
  expect(saved.jobs.find((job: { id: string }) => job.id === pending.id).state).toBe('queued');
  await h.service.close();
  const restarted = await h.create(); h.available(true); await restarted.service.tick();
  await vi.waitFor(() => expect(restarted.service.get(pending.id)?.state).toBe('ready'));
  await restarted.service.tick();
  expect(h.investigate).toHaveBeenCalledTimes(1);
  expect(restarted.service.get(paused.id)).toMatchObject({ analysisPaused: true, replyDraft: 'human draft' });
  expect(restarted.service.get(pending.id)).toMatchObject({ state: 'done', analysis: 'evidence' });
  expect(restarted.service.get(pending.id)?.deliveredAt).toBeUndefined();
  expect(restarted.service.get(pending.id)?.resultDelivery).toBeUndefined();
});

it('returns work to the durable queue and refunds reserved quota when the executor disappears while waiting for a slot', async () => {
  const queue = new WorkItemScheduler(1); let release!: () => void;
  const blocker = queue.run(new AbortController().signal, () => new Promise<void>(resolve => { release = resolve; }));
  await vi.waitFor(() => expect(release).toBeDefined());
  const h = await setup({}, queue); h.available(true);
  try {
    const item = await h.service.observe(event); await h.service.tick();
    expect(h.service.get(item.id)?.state).toBe('running');
    h.available(false); release(); await blocker;
    await vi.waitFor(() => expect(h.service.get(item.id)?.state).toBe('queued'));
    expect(h.investigate).not.toHaveBeenCalled();
    expect(h.service.get(item.id)?.external?.analysisAttempts).toBe(0);
    expect(h.store.data.autoUsage['1970-01-01']).toBe(0);
    h.available(true); await h.service.tick();
    await vi.waitFor(() => expect(h.investigate).toHaveBeenCalledTimes(1));
  } finally { release(); await blocker; }
});

it('continues source notices with no executor and never acknowledges a failed delivery', async () => {
  const notifyChange = vi.fn(async () => { throw new Error('transport unavailable'); });
  const h = await setup({ notifyChange });
  const item = await h.service.observe({ ...event, notice: 'alert' }); await h.service.tick();
  await vi.waitFor(() => expect(notifyChange).toHaveBeenCalledTimes(1));
  expect(h.investigate).not.toHaveBeenCalled();
  expect(h.service.get(item.id)).toMatchObject({ state: 'queued', sourceNotices: [{ id: '1', attempts: 1 }] });
  expect(h.service.get(item.id)?.sourceNotices?.[0]?.sentAt).toBeUndefined();
});
