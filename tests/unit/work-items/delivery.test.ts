import { afterEach, expect, it, vi } from 'vitest';
import { normalizeInbox } from '../../../src/inbox/config';
import { WorkItemService } from '../../../src/work-items/service';
import { WorkItemStore } from '../../../src/work-items/store';
import { EventSource } from '../../../src/work-items/event-source';
import type { WorkItemRuntime } from '../../../src/work-items/contracts';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const services: WorkItemService[] = [];
afterEach(async () => { await Promise.all(services.splice(0).map(service => service.close())); });
const topic = { chatId: 'oc_out', threadId: 'omt_out', replyTo: 'om_out' };
const event = { key: 'issue', title: 'incident', reason: 'failure', url: '', time: 1000, eventId: '1', revision: 1, data: {} };
async function setup(overrides: Partial<WorkItemRuntime> = {}) {
  const store = new WorkItemStore('unused');
  vi.spyOn(store, 'load').mockResolvedValue();
  const save = vi.spyOn(store, 'save').mockResolvedValue();
  const poll = vi.fn(async () => {});
  const runtime: WorkItemRuntime = { source: Object.assign(new EventSource('test', () => true), { poll }),
    checkAccess: async () => {}, investigate: vi.fn(), dailyAnalysisLimit: 0, deliver: vi.fn(async () => {}), ...overrides };
  let now = 1000;
  const service = new WorkItemService(store, normalizeInbox({ enabled: true, ownerOpenId: 'owner', executorProfile: 'test' }), runtime, () => now);
  services.push(service); await service.start();
  return { service, store, runtime, save, poll, advance: () => { now += 60_000; } };
}
const ready = { state: 'ready' as const, analysisTopic: topic, result: 'old report', replyDraft: 'old draft' };

it('keeps collection and human edits responsive during a result send, with one in-flight attempt', async () => {
  const sending = deferred(); const finish = deferred();
  const h = await setup({ deliver: vi.fn(async () => { sending.resolve(); await finish.promise; }) });
  const job = await h.service.observe({ ...event, initial: ready });
  const tick = h.service.tick(); await sending.promise;
  try {
    await h.service.review({ id: job.id, revision: job.revision, replyDraft: 'human draft' }, 'owner', 'edit');
    await h.service.observe({ ...event, key: 'another' });
    const polled = deferred(); h.poll.mockImplementationOnce(async () => { polled.resolve(); });
    const second = h.service.tick(); await polled.promise;
    expect(h.runtime.deliver).toHaveBeenCalledTimes(1);
    finish.resolve(); await Promise.all([tick, second]);
    expect(h.service.get(job.id)).toMatchObject({ replyDraft: 'human draft', draftEdited: true, analysisPaused: true,
      resultDelivery: { attempts: 1, confirmedAt: 1000 } });
    expect(h.service.get(job.id)?.deliveredAt).toBeUndefined();
  } finally { finish.resolve(); await tick; }
});

it('does not apply an old result receipt to a replacement observation', async () => {
  const sending = deferred(); const finish = deferred();
  const h = await setup({ deliver: vi.fn(async () => { sending.resolve(); await finish.promise; }) });
  const job = await h.service.observe({ ...event, initial: ready });
  const tick = h.service.tick(); await sending.promise;
  try { await h.service.observe({ ...event, revision: 2, eventId: '2', data: { newer: true } }); }
  finally { finish.resolve(); await tick; }
  expect(h.service.get(job.id)).toMatchObject({ state: 'queued', evidenceVersion: 2 });
  expect(h.service.get(job.id)?.deliveredAt).toBeUndefined();
  expect(h.service.get(job.id)?.resultDelivery).toBeUndefined();
});

it('retains a confirmed receipt after handling and waits for it during shutdown', async () => {
  const sending = deferred(); const finish = deferred();
  const h = await setup({ deliver: vi.fn(async () => { sending.resolve(); await finish.promise; }) });
  const job = await h.service.observe({ ...event, initial: ready });
  const tick = h.service.tick(); await sending.promise;
  await h.service.batchReview({ items: [{ id: job.id, revision: job.revision }], handlingState: 'handled' }, 'owner');
  let closed = false; const closing = h.service.close().then(() => { closed = true; });
  await Promise.resolve(); expect(closed).toBe(false);
  finish.resolve(); await Promise.all([tick, closing]);
  expect(h.service.get(job.id)).toMatchObject({ state: 'claimed', resultDelivery: { confirmedAt: 1000 } });
});

it.each(['reservation', 'receipt'])('pauses on %s persistence failure and never starts an unreserved send', async phase => {
  const h = await setup(); await h.service.observe({ ...event, initial: ready });
  h.save.mockImplementation(async () => {
    const delivery = h.store.data.jobs[0]?.resultDelivery;
    if (delivery && (phase === 'reservation' || delivery.confirmedAt !== undefined)) throw Error('disk failure');
  });
  await h.service.tick();
  expect(h.runtime.deliver).toHaveBeenCalledTimes(phase === 'reservation' ? 0 : 1);
  expect(h.service.lastError).toContain('状态保存失败');
  await h.service.tick(); expect(h.runtime.deliver).toHaveBeenCalledTimes(phase === 'reservation' ? 0 : 1);
});

it('sends a digest snapshot outside the lock and does not notify newer evidence with its receipt', async () => {
  const sending = deferred(); const finish = deferred();
  const h = await setup({ notifyAttention: vi.fn(async () => { sending.resolve(); await finish.promise; }) });
  const job = await h.service.observe(event); const tick = h.service.tick(); await sending.promise;
  try {
    await h.service.observe({ ...event, eventId: '2', revision: 2, data: { newer: true } });
    expect(vi.mocked(h.runtime.notifyAttention!).mock.calls[0]![0][0]?.evidenceVersion).toBe(1);
  } finally { finish.resolve(); await tick; }
  expect(h.service.get(job.id)?.notifiedAt).toBeUndefined();
  expect(h.store.data.notificationOutbox).toBeUndefined();
});
