import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { normalizeInbox } from '../../../src/inbox/config';
import { InboxService } from '../../../src/inbox/service';
import { InboxStore } from '../../../src/inbox/store';
import type { InboxIO, InboxJob, InboxMessage } from '../../../src/inbox/types';

type Decisions = Awaited<ReturnType<NonNullable<InboxIO['triage']>>>;
const services: InboxService[] = [];
beforeEach(() => { vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] }); });
afterEach(async () => { await Promise.all(services.splice(0).map(s => s.close())); vi.useRealTimers(); });

async function setup() {
  let now = 1_000_000;
  const messages: InboxMessage[] = [];
  const batches: { jobs: InboxJob[]; resolve: (value: Decisions) => void; reject: (error: Error) => void }[] = [];
  const config = normalizeInbox({ enabled: true, executorProfile: 'codex', ownerOpenId: 'ou_owner', intakeScope: 'all',
    destination: { chatId: 'oc_target', threadId: 'omt_item', replyTo: 'om_item' } });
  const io: InboxIO = {
    checkOwner: vi.fn(async () => {}),
    collect: vi.fn(async kind => messages.filter(m => m.chatType === (kind === 'p2p' ? 'p2p' : 'group'))),
    context: vi.fn(async () => []), source: vi.fn(async () => ({ name: '同事', type: 'p2p' as const })),
    beginAnalysis: vi.fn(async () => config.destination), deliver: vi.fn(async () => {}),
    analyze: vi.fn(async () => ({ text: '{"replyDraft":"已核对","analysis":"最新上下文","missingInfo":""}', inputTokens: 1, outputTokens: 1 })),
    triage: vi.fn((jobs, signal) => new Promise<Decisions>((resolve, reject) => {
      signal.addEventListener('abort', () => reject(Error('cancelled')), { once: true });
      batches.push({ jobs: structuredClone(jobs), resolve, reject });
    })),
  };
  const store = new InboxStore(join(await mkdtemp(join(tmpdir(), 'inbox-immediate-')), 'state.json'));
  const service = new InboxService(store, config, io, () => now); services.push(service); await service.start();
  const add = (id: string, overrides: Partial<InboxMessage> = {}) => {
    const message: InboxMessage = { id, chatId: 'oc_source', chatName: '同事', chatType: 'p2p', senderId: 'ou_sender',
      senderName: '同事', bot: false, time: now, position: String(messages.length + 1), text: `请确认 ${id}`, mentions: [], ...overrides };
    messages.push(message); return message;
  };
  const complete = async (index: number, state: 'needed' | 'quiet') => {
    const batch = batches[index]!;
    batch.resolve(batch.jobs.map(j => ({ id: j.id, state, reason: '已核对' })));
    await vi.waitFor(() => expect(service.list().some(j => j.attention?.progress)).toBe(false));
    // Progress is hidden as soon as an input becomes stale; also drain the result commit.
    await new Promise(resolve => setTimeout(resolve, 20));
  };
  return { service, store, io, batches, messages, add, complete, advance: (ms = 1000) => { now += ms; } };
}

it('screens the first collected message immediately and combines messages from the same poll', async () => {
  const s = await setup(); s.add('om_one'); s.add('om_two'); s.add('om_three');
  await s.service.tick();
  expect(s.batches).toHaveLength(1); expect(s.store.data.jobs).toHaveLength(1);
  expect(s.batches[0]!.jobs[0]!.messages.map(m => m.id)).toEqual(['om_one', 'om_two', 'om_three']);
  expect(s.batches[0]!.jobs[0]).toMatchObject({ createdAt: 1_000_000, updatedAt: 1_000_000 });
  expect(s.io.analyze).not.toHaveBeenCalled();
});

it('coalesces an in-flight burst into one latest screening and never analyzes the stale decision', async () => {
  const s = await setup(); s.add('om_one'); await s.service.tick();
  for (let batch = 0; batch < 3; batch++) {
    s.advance();
    for (let i = 0; i < 5; i++) s.add(`om_${batch}_${i}`);
    await s.service.tick();
    expect(s.batches).toHaveLength(1); expect(s.store.data.jobs).toHaveLength(1);
  }
  await s.complete(0, 'needed');
  expect(s.store.data.jobs[0]).toMatchObject({ state: 'waiting', analysisRequested: false, attention: { state: 'pending' } });
  expect(s.io.beginAnalysis).not.toHaveBeenCalled(); expect(s.io.analyze).not.toHaveBeenCalled();
  await s.service.tick();
  expect(s.batches).toHaveLength(2); expect(s.batches[1]!.jobs[0]!.messages).toHaveLength(16);
  await s.complete(1, 'needed'); await s.service.tick();
  await vi.waitFor(() => expect(s.store.data.jobs[0]?.state).toBe('ready'));
  s.advance(); await s.service.tick(); await s.service.tick();
  expect(s.batches).toHaveLength(2); expect(s.io.analyze).toHaveBeenCalledTimes(1);
  expect(s.io.beginAnalysis).toHaveBeenCalledTimes(1); expect(s.io.deliver).toHaveBeenCalledTimes(1);
  expect(vi.mocked(s.io.analyze).mock.calls[0]![0].messages).toHaveLength(16);
});

it('rescreens new context immediately after a quiet decision but ignores duplicate polls', async () => {
  const s = await setup(); s.add('om_one'); await s.service.tick(); await s.complete(0, 'quiet');
  s.advance(); await s.service.tick(); expect(s.batches).toHaveLength(1);
  s.advance(); s.add('om_two'); await s.service.tick();
  expect(s.batches).toHaveLength(2); expect(s.store.data.jobs).toHaveLength(1);
  expect(s.batches[1]!.jobs[0]!.messages).toHaveLength(2);
});

it('keeps different topics separate while combining a burst within each topic', async () => {
  const s = await setup();
  for (const topic of ['omt_a', 'omt_b']) for (let i = 0; i < 3; i++) {
    s.add(`om_${topic}_${i}`, { chatType: 'group', threadId: topic });
  }
  await s.service.tick();
  expect(s.store.data.jobs).toHaveLength(2); expect(s.batches).toHaveLength(1);
  expect(s.batches[0]!.jobs.map(j => [j.source.threadId, j.messages.length])).toEqual([['omt_a', 3], ['omt_b', 3]]);
});

it('withdraws a queued stale analysis when the next collection contains more context', async () => {
  const s = await setup(); s.add('om_one'); await s.service.tick(); await s.complete(0, 'needed');
  expect(s.store.data.jobs[0]?.state).toBe('queued');
  s.advance(); s.add('om_two'); s.add('om_three'); await s.service.tick();
  expect(s.io.analyze).not.toHaveBeenCalled(); expect(s.io.beginAnalysis).not.toHaveBeenCalled();
  expect(s.batches).toHaveLength(2); expect(s.batches[1]!.jobs[0]!.messages).toHaveLength(3);
  await s.complete(1, 'quiet'); await s.service.tick();
  expect(s.io.analyze).not.toHaveBeenCalled(); expect(s.store.data.jobs[0]?.attention?.state).toBe('quiet');
});

it('preserves failure backoff when more messages arrive and retries the latest combined context', async () => {
  const s = await setup(); s.add('om_one'); await s.service.tick(); s.batches[0]!.reject(Error('HTTP 429'));
  await vi.waitFor(() => expect(s.store.data.jobs[0]?.attention?.retry).toBeDefined());
  const retry = structuredClone(s.store.data.jobs[0]!.attention!.retry);
  for (let i = 0; i < 3; i++) { s.advance(); s.add(`om_${i}`); await s.service.tick(); }
  expect(s.batches).toHaveLength(1); expect(s.store.data.jobs[0]?.attention?.retry).toEqual(retry);
  s.advance(27_000); await s.service.tick();
  expect(s.batches).toHaveLength(2); expect(s.batches[1]!.jobs[0]!.messages).toHaveLength(4);
});

it('reuses an in-flight announcement for the latest context and only launches one analysis', async () => {
  const s = await setup(); let announce!: () => void;
  vi.mocked(s.io.beginAnalysis!).mockImplementation(() => new Promise(resolve => {
    announce = () => resolve(s.service.config.destination);
  }));
  s.add('om_one'); await s.service.tick(); await s.complete(0, 'needed'); await s.service.tick();
  await vi.waitFor(() => expect(announce).toBeDefined());
  const announcementId = s.store.data.jobs[0]!.startDelivery!.id;
  s.advance(); s.add('om_two'); s.add('om_three'); await s.service.tick(); await s.complete(1, 'needed');
  expect(s.store.data.jobs[0]?.startDelivery?.id).toBe(announcementId);
  announce(); await vi.waitFor(() => expect(s.store.data.jobs[0]?.startDelivery?.confirmed).toBe(true));
  await vi.waitFor(async () => { await s.service.tick(); expect(s.io.analyze).toHaveBeenCalledTimes(1); });
  await vi.waitFor(() => expect(s.store.data.jobs[0]?.replyDraft).toBe('已核对'));
  await s.service.tick();
  expect(s.io.beginAnalysis).toHaveBeenCalledTimes(1); expect(s.io.analyze).toHaveBeenCalledTimes(1);
  expect(vi.mocked(s.io.analyze).mock.calls[0]![0].messages).toHaveLength(3);
  expect(s.io.deliver).toHaveBeenCalledTimes(1);
});

it('keeps an unconfirmed announcement id and retry deadline across new messages', async () => {
  const s = await setup(); vi.mocked(s.io.beginAnalysis!).mockRejectedValueOnce(Error('lost response'));
  s.add('om_one'); await s.service.tick(); await s.complete(0, 'needed'); await s.service.tick();
  await vi.waitFor(() => expect(s.store.data.jobs[0]?.state).toBe('queued'));
  const delivery = structuredClone(s.store.data.jobs[0]!.startDelivery!);
  s.advance(); s.add('om_two'); await s.service.tick(); await s.complete(1, 'needed'); await s.service.tick();
  expect(s.io.beginAnalysis).toHaveBeenCalledTimes(1); expect(s.io.analyze).not.toHaveBeenCalled();
  expect(s.store.data.jobs[0]?.startDelivery).toEqual(delivery);
  s.advance(59_000); await s.service.tick(); await vi.waitFor(() => expect(s.store.data.jobs[0]?.state).toBe('ready'));
  expect(s.io.beginAnalysis).toHaveBeenCalledTimes(2);
  expect(vi.mocked(s.io.beginAnalysis!).mock.calls[1]![0].startDelivery?.id).toBe(delivery.id);
  expect(s.io.analyze).toHaveBeenCalledTimes(1);
  expect(vi.mocked(s.io.analyze).mock.calls[0]![0].messages).toHaveLength(2);
});

it('waits for cancelled analysis to exit, discards its late output and analyzes only the latest burst', async () => {
  const s = await setup(); let finishOld!: () => void;
  vi.mocked(s.io.analyze).mockImplementationOnce(() => new Promise(resolve => {
    finishOld = () => resolve({ text: '{"replyDraft":"过时的回复"}', inputTokens: 1, outputTokens: 1 });
  }));
  s.add('om_one'); await s.service.tick(); await s.complete(0, 'needed'); await s.service.tick();
  await vi.waitFor(() => expect(finishOld).toBeDefined());
  s.advance(); s.add('om_two'); await s.service.tick();
  expect(vi.mocked(s.io.analyze).mock.calls[0]![1].aborted).toBe(true);
  s.advance(); s.add('om_three'); await s.service.tick(); await s.complete(1, 'needed');
  // The second screening also became stale; only its successor can queue the latest analysis.
  await s.service.tick(); await s.complete(2, 'needed'); await s.service.tick();
  expect(s.io.analyze).toHaveBeenCalledTimes(1);
  finishOld();
  await vi.waitFor(async () => { await s.service.tick(); expect(s.io.analyze).toHaveBeenCalledTimes(2); });
  await vi.waitFor(() => expect(s.store.data.jobs[0]?.replyDraft).toBe('已核对'));
  expect(vi.mocked(s.io.analyze).mock.calls[1]![0].messages).toHaveLength(3);
  await s.service.tick();
  expect(s.store.data.jobs).toHaveLength(1); expect(s.io.beginAnalysis).toHaveBeenCalledTimes(1);
  expect(s.io.deliver).toHaveBeenCalledTimes(1);
});
