import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { normalizeInbox } from '../../../src/inbox/config';
import { InboxService } from '../../../src/inbox/service';
import { InboxStore } from '../../../src/inbox/store';
import type { InboxIO, InboxJob, InboxMessage } from '../../../src/inbox/types';
import { InboxAnalysisQueue } from '../../../src/inbox/task-source';
import { workItemTarget } from '../../../src/inbox/lark-target';

type Decision = Awaited<ReturnType<NonNullable<InboxIO['triage']>>>;
const services: InboxService[] = [];
beforeEach(() => { vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] }); });
afterEach(async () => { await Promise.all(services.splice(0).map(s => s.close())); vi.useRealTimers(); });

async function setup(queue?: InboxAnalysisQueue) {
  let now = 1_000_000;
  const messages: InboxMessage[] = [];
  const screens: { item: InboxJob; resolve: (value: Decision) => void; reject: (error: Error) => void }[] = [];
  const config = normalizeInbox({ enabled: true, executorProfile: 'codex', recipientKey: 'ou_owner', intakeScope: 'all',
    target: workItemTarget({ chatId: 'oc_target', threadId: 'omt_item', replyTo: 'om_item' }) });
  const io: InboxIO = {
    checkOwner: vi.fn(async () => {}),
    collect: vi.fn(async kind => messages.filter(m => m.containerKind === (kind === 'p2p' ? 'direct' : 'group'))),
    context: vi.fn(async () => []), source: vi.fn(async () => ({ name: '同事', type: 'p2p' as const })),
    beginAnalysis: vi.fn(async () => config.target), deliver: vi.fn(async () => {}),
    analyze: vi.fn(async () => ({ text: '{"replyDraft":"已核对","analysis":"最新上下文","missingInfo":""}', inputTokens: 1, outputTokens: 1 })),
    triage: vi.fn((item, signal) => new Promise<Decision>((resolve, reject) => {
      signal.addEventListener('abort', () => reject(Error('cancelled')), { once: true });
      screens.push({ item: structuredClone(item), resolve, reject });
    })),
  };
  const store = new InboxStore(join(await mkdtemp(join(tmpdir(), 'inbox-immediate-')), 'state.json'));
  const service = new InboxService(store, config, io, () => now, queue); services.push(service); await service.start();
  const add = (id: string, overrides: Partial<InboxMessage> = {}) => {
    const message: InboxMessage = { id, containerId: 'oc_source', containerName: '同事', containerKind: 'direct',
      senderId: 'ou_sender', senderName: '同事', senderBot: false, time: now, sequence: String(messages.length + 1),
      text: `请确认 ${id}`, mentions: [], ...overrides };
    messages.push(message); return message;
  };
  const complete = async (index: number, state: 'needed' | 'quiet', followUp?: Decision['followUp']) => {
    const screening = screens[index]!;
    screening.resolve({ id: screening.item.id, state, reason: '已核对', followUp });
    await vi.waitFor(() => expect(service.list().some(j => j.attention?.progress)).toBe(false));
    // Progress is hidden as soon as an input becomes stale; also drain the result commit.
    await new Promise(resolve => setTimeout(resolve, 20));
  };
  return { service, store, io, screens, messages, add, complete, advance: (ms = 1000) => { now += ms; } };
}

it('screens the first collected message immediately and combines messages from the same poll', async () => {
  const s = await setup(); s.add('om_one'); s.add('om_two'); s.add('om_three');
  await s.service.tick();
  expect(s.screens).toHaveLength(1); expect(s.store.data.jobs).toHaveLength(1);
  expect(s.screens[0]!.item.messages.map(m => m.id)).toEqual(['om_one', 'om_two', 'om_three']);
  expect(s.screens[0]!.item).toMatchObject({ createdAt: 1_000_000, updatedAt: 1_000_000 });
  expect(s.io.analyze).not.toHaveBeenCalled();
});

it('coalesces an in-flight burst into one latest screening and never analyzes the stale decision', async () => {
  const s = await setup(); s.add('om_one'); await s.service.tick();
  for (let batch = 0; batch < 3; batch++) {
    s.advance();
    for (let i = 0; i < 5; i++) s.add(`om_${batch}_${i}`);
    await s.service.tick();
    expect(s.screens).toHaveLength(1); expect(s.store.data.jobs).toHaveLength(1);
  }
  await s.complete(0, 'needed');
  expect(s.store.data.jobs[0]).toMatchObject({ state: 'waiting', analysisRequested: false, attention: { state: 'pending' } });
  expect(s.io.beginAnalysis).not.toHaveBeenCalled(); expect(s.io.analyze).not.toHaveBeenCalled();
  await s.service.tick();
  expect(s.screens).toHaveLength(2); expect(s.screens[1]!.item.messages).toHaveLength(16);
  await s.complete(1, 'needed'); await s.service.tick();
  await vi.waitFor(() => expect(['ready', 'done']).toContain(s.store.data.jobs[0]?.state));
  s.advance(); await s.service.tick(); await s.service.tick();
  expect(s.screens).toHaveLength(2); expect(s.io.analyze).toHaveBeenCalledTimes(1);
  expect(s.io.beginAnalysis).toHaveBeenCalledTimes(1); expect(s.io.deliver).toHaveBeenCalledTimes(1);
  expect(vi.mocked(s.io.analyze).mock.calls[0]![0].messages).toHaveLength(16);
});

it('rescreens new context immediately after a quiet decision but ignores duplicate polls', async () => {
  const s = await setup(); s.add('om_one'); await s.service.tick(); await s.complete(0, 'quiet');
  s.advance(); await s.service.tick(); expect(s.screens).toHaveLength(1);
  s.advance(); s.add('om_two'); await s.service.tick();
  expect(s.screens).toHaveLength(2); expect(s.store.data.jobs).toHaveLength(1);
  expect(s.screens[1]!.item.messages).toHaveLength(2);
});

it('keeps different topics separate while combining a burst within each topic', async () => {
  const s = await setup();
  for (const topic of ['omt_a', 'omt_b']) for (let i = 0; i < 3; i++) {
    s.add(`om_${topic}_${i}`, { containerKind: 'group', threadId: topic });
  }
  await s.service.tick();
  expect(s.store.data.jobs).toHaveLength(2); expect(s.screens).toHaveLength(2);
  expect(s.screens.map(({ item }) => [item.sourceRef.threadId, item.messages.length])).toEqual([['omt_a', 3], ['omt_b', 3]]);
});

it('withdraws a queued stale analysis when the next collection contains more context', async () => {
  const s = await setup(new InboxAnalysisQueue(1)); let finishBusy!: () => void;
  vi.mocked(s.io.analyze).mockImplementationOnce((_job, signal) => new Promise((resolve, reject) => {
    finishBusy = () => resolve({ text: '{"analysis":"完成"}', inputTokens: 1, outputTokens: 1 });
    signal.addEventListener('abort', () => reject(Error('cancelled')), { once: true });
  }));
  s.add('om_busy', { containerId: 'oc_busy' }); await s.service.tick(); await s.complete(0, 'needed');
  await vi.waitFor(() => expect(finishBusy).toBeDefined());
  s.advance(); s.add('om_one'); await s.service.tick(); await s.complete(1, 'needed');
  const target = s.store.data.jobs.find(j => j.sourceRef.containerId === 'oc_source')!;
  expect(target.state).toBe('queued');
  s.advance(); s.add('om_two'); s.add('om_three'); await s.service.tick();
  expect(s.io.analyze).toHaveBeenCalledTimes(1); expect(s.io.beginAnalysis).toHaveBeenCalledTimes(1);
  expect(target).toMatchObject({ state: 'waiting', analysisRequested: false });
  expect(s.screens).toHaveLength(3);
  expect(s.screens[2]!.item.messages).toHaveLength(3);
  await s.complete(2, 'quiet'); finishBusy(); await s.service.tick();
  expect(s.io.analyze).toHaveBeenCalledTimes(1); expect(target.attention?.state).toBe('quiet');
});

it('preserves failure backoff when more messages arrive and retries the latest combined context', async () => {
  const s = await setup(); s.add('om_one'); await s.service.tick(); s.screens[0]!.reject(Error('HTTP 429'));
  await vi.waitFor(() => expect(s.store.data.jobs[0]?.attention?.retry).toBeDefined());
  const retry = structuredClone(s.store.data.jobs[0]!.attention!.retry);
  for (let i = 0; i < 3; i++) { s.advance(); s.add(`om_${i}`); await s.service.tick(); }
  expect(s.screens).toHaveLength(1); expect(s.store.data.jobs[0]?.attention?.retry).toEqual(retry);
  s.advance(27_000); await s.service.tick();
  expect(s.screens).toHaveLength(2); expect(s.screens[1]!.item.messages).toHaveLength(4);
});

it('reuses an in-flight announcement for the latest context and only launches one analysis', async () => {
  const s = await setup(); let announce!: () => void;
  vi.mocked(s.io.beginAnalysis!).mockImplementation(() => new Promise(resolve => {
    announce = () => resolve(s.service.config.target);
  }));
  s.add('om_one'); await s.service.tick(); await s.complete(0, 'needed'); await s.service.tick();
  await vi.waitFor(() => expect(announce).toBeDefined());
  const announcementId = s.store.data.jobs[0]!.startDelivery!.id;
  s.advance(); s.add('om_two'); s.add('om_three'); await s.service.tick();
  expect(s.screens).toHaveLength(1);
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
  s.advance(59_000); await s.service.tick();
  await vi.waitFor(() => expect(['ready', 'done']).toContain(s.store.data.jobs[0]?.state), { timeout: 3000 });
  expect(s.io.beginAnalysis).toHaveBeenCalledTimes(2);
  expect(vi.mocked(s.io.beginAnalysis!).mock.calls[1]![0].startDelivery?.id).toBe(delivery.id);
  expect(s.io.analyze).toHaveBeenCalledTimes(1);
  expect(vi.mocked(s.io.analyze).mock.calls[0]![0].messages).toHaveLength(2);
});

it('finishes the current analysis then reviews a burst once before supplemental analysis', async () => {
  const s = await setup(); let finishOld!: () => void;
  vi.mocked(s.io.analyze).mockImplementationOnce(() => new Promise(resolve => {
    finishOld = () => resolve({ text: '{"replyDraft":"第一轮回复","analysis":"已有证据","missingInfo":""}', inputTokens: 1, outputTokens: 1 });
  }));
  s.add('om_one'); await s.service.tick(); await s.complete(0, 'needed'); await s.service.tick();
  await vi.waitFor(() => expect(finishOld).toBeDefined());
  s.advance(); s.add('om_two'); await s.service.tick();
  expect(vi.mocked(s.io.analyze).mock.calls[0]![1].aborted).toBe(false);
  s.advance(); s.add('om_three'); await s.service.tick();
  expect(s.screens).toHaveLength(1);
  expect(s.io.analyze).toHaveBeenCalledTimes(1);
  finishOld();
  await vi.waitFor(() => expect(s.screens).toHaveLength(2));
  expect(s.screens[1]!.item).toMatchObject({ replyDraft: '第一轮回复', analysis: '已有证据', draftStale: true });
  expect(s.io.deliver).not.toHaveBeenCalled();
  await s.complete(1, 'needed', 'reanalyze');
  await vi.waitFor(async () => { await s.service.tick(); expect(s.io.analyze).toHaveBeenCalledTimes(2); }, { timeout: 3000 });
  await vi.waitFor(() => expect(s.store.data.jobs[0]?.replyDraft).toBe('已核对'));
  expect(vi.mocked(s.io.analyze).mock.calls[1]![0].messages).toHaveLength(3);
  expect(vi.mocked(s.io.analyze).mock.calls[1]![0].analysis).toBe('已有证据');
  await s.service.tick();
  expect(s.store.data.jobs).toHaveLength(1); expect(s.io.beginAnalysis).toHaveBeenCalledTimes(1);
  expect(s.io.deliver).toHaveBeenCalledTimes(1);
});
