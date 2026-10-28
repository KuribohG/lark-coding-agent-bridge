import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { normalizeInbox } from '../../../src/inbox/config';
import { InboxService } from '../../../src/inbox/service';
import { InboxStore } from '../../../src/inbox/store';
import type { InboxIO, InboxJob, InboxMessage } from '../../../src/inbox/types';
import { workItemTarget } from '../../../src/inbox/lark-target';

function gate<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const services: InboxService[] = [];
const messages: InboxMessage[] = [];
beforeEach(() => { messages.length = 0; vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] }); });
afterEach(async () => { await Promise.all(services.splice(0).map(s => s.close())); vi.useRealTimers(); });

async function setup() {
  let now = 1_000_000;
  const config = normalizeInbox({ enabled: true, executorProfile: 'codex', recipientKey: 'ou_owner',
    target: workItemTarget({ chatId: 'oc_target', threadId: 'omt_target', replyTo: 'om_target' }) });
  const store = new InboxStore(join(await mkdtemp(join(tmpdir(), 'inbox-scheduler-')), 'state.json'));
  const io: InboxIO = {
    checkOwner: vi.fn(async () => {}), collect: vi.fn(async kind => kind === 'p2p' ? [...messages] : []),
    context: vi.fn(async () => []), source: vi.fn(async () => ({ name: '同事', type: 'p2p' as const })),
    triage: vi.fn<NonNullable<InboxIO['triage']>>(async j => ({ id: j.id, state: 'quiet', reason: '已核对' })),
    beginAnalysis: vi.fn(async () => config.target), deliver: vi.fn(async () => {}),
    analyze: vi.fn(async () => ({ text: '{"analysis":"已完成","replyDraft":"草稿","missingInfo":""}', inputTokens: 1, outputTokens: 1 })),
  };
  const service = new InboxService(store, config, io, () => now); services.push(service); await service.start();
  const message = (id: string, containerId = 'oc_fresh'): InboxMessage => ({ id, containerId, containerName: '同事',
    containerKind: 'direct', senderId: 'ou_sender', senderName: '同事', senderBot: false,
    time: now, text: id, mentions: [] });
  const old = (id = 'old') => {
    const m = message(`om_${id}`, `oc_${id}`); m.time = now - 120_000;
    const job: InboxJob = { id, sourceRef: { transport: 'lark', containerId: m.containerId, name: '旧会话', kind: 'direct' }, ownerKey: config.ownerKey,
      profile: config.executorProfile, target: config.target, state: 'waiting', analysisRequested: false,
      automatic: true, alert: false, attention: { state: 'quiet', reason: '无需关注' }, messages: [m], createdAt: m.time, updatedAt: m.time };
    store.data.jobs.push(job); return job;
  };
  return { service, store, io, message, old, advance: (ms = 1000) => { now += ms; } };
}

it('keeps collecting and screening while one history refresh is blocked, without overlapping refreshes', async () => {
  const s = await setup(); s.old(); const history = gate<InboxMessage[]>();
  vi.mocked(s.io.context).mockReturnValue(history.promise);
  try {
    await s.service.tick(); await vi.waitFor(() => expect(s.io.context).toHaveBeenCalledTimes(1));
    messages.push(s.message('om_fresh')); s.advance(); await s.service.tick();
    await vi.waitFor(() => expect(s.io.triage).toHaveBeenCalledTimes(1));
    expect(vi.mocked(s.io.triage!).mock.calls[0]![0].messages[0]!.id).toBe('om_fresh');
    for (let i = 0; i < 3; i++) { s.advance(); await s.service.tick(); }
    expect(s.io.collect).toHaveBeenCalledTimes(10); expect(s.io.context).toHaveBeenCalledTimes(1);
    expect(s.store.data.cursors['context:oc_old']).toBeUndefined();
    history.resolve([]);
    await vi.waitFor(() => expect(s.store.data.cursors['context:oc_old']).toBe(1_000_000));
  } finally { history.resolve([]); }
});

it('dispatches a completed screening while the next collection is still blocked', async () => {
  const s = await setup(); const screening = gate<Awaited<ReturnType<NonNullable<InboxIO['triage']>>>>();
  const collection = gate<InboxMessage[]>();
  vi.mocked(s.io.triage!).mockReturnValue(screening.promise); messages.push(s.message('om_fresh'));
  await s.service.tick(); const job = s.store.data.jobs[0]!;
  vi.mocked(s.io.collect).mockReturnValueOnce(collection.promise); s.advance(); const tick = s.service.tick();
  try {
    await vi.waitFor(() => expect(s.io.collect).toHaveBeenCalledTimes(3));
    screening.resolve({ id: job.id, state: 'needed', reason: '需要处理' });
    await vi.waitFor(() => expect(s.io.analyze).toHaveBeenCalledTimes(1));
    expect(s.io.beginAnalysis).toHaveBeenCalledTimes(1);
    expect(s.store.data.cursors.p2p).toBe(1_000_000);
  } finally { collection.resolve([]); await tick; }
});

it('dispatches history discoveries before the rest of the history batch has finished', async () => {
  const s = await setup(); const first = s.old('first'); s.old('second'); const later = gate<InboxMessage[]>();
  const reply = s.message('om_reply', first.sourceRef.containerId);
  vi.mocked(s.io.context).mockResolvedValueOnce([reply]).mockReturnValueOnce(later.promise);
  try {
    await s.service.tick(); await vi.waitFor(() => expect(s.io.context).toHaveBeenCalledTimes(2));
    expect(s.io.triage).toHaveBeenCalledTimes(1);
    expect(vi.mocked(s.io.triage!).mock.calls[0]![0].messages.some(m => m.id === reply.id)).toBe(true);
  } finally { later.resolve([]); }
});

it('backs off failed history refresh independently without advancing its cursor or stopping intake', async () => {
  const s = await setup(); s.old(); vi.mocked(s.io.context).mockRejectedValueOnce(Error('history unavailable'));
  await s.service.tick(); await vi.waitFor(() => expect(s.service.lastError).toBe('history unavailable'));
  expect(s.store.data.cursors['context:oc_old']).toBeUndefined();
  messages.push(s.message('om_fresh')); s.advance(); await s.service.tick();
  expect(s.io.collect).toHaveBeenCalledTimes(4); expect(s.io.context).toHaveBeenCalledTimes(1);
  expect(s.service.lastError).toBe('history unavailable');
  s.advance(59_000); await s.service.tick();
  await vi.waitFor(() => expect(s.store.data.cursors['context:oc_old']).toBe(1_060_000));
  expect(s.io.context).toHaveBeenCalledTimes(2);
});

it.each(['off', 'scope', 'close'] as const)('discards late history after %s and never dispatches it', async action => {
  const s = await setup(); s.old(); const history = gate<InboxMessage[]>();
  vi.mocked(s.io.context).mockReturnValue(history.promise);
  await s.service.tick(); await vi.waitFor(() => expect(s.io.context).toHaveBeenCalledTimes(1));
  let closing: Promise<void> | undefined;
  if (action === 'off') await s.service.setMode('off');
  if (action === 'scope') await s.service.setScope('private');
  if (action === 'close') closing = s.service.close();
  history.resolve([s.message('om_late', 'oc_old')]);
  await closing;
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(s.store.data.jobs.flatMap(j => j.messages).some(m => m.id === 'om_late')).toBe(false);
  expect(s.io.triage).not.toHaveBeenCalled(); expect(s.io.analyze).not.toHaveBeenCalled();
  expect(s.store.data.cursors['context:oc_old']).toBeUndefined();
});

it('does not let an older history response undo a freshly collected edit', async () => {
  const s = await setup(); const old = s.old(); const history = gate<InboxMessage[]>();
  vi.mocked(s.io.context).mockReturnValueOnce(history.promise);
  await s.service.tick(); await vi.waitFor(() => expect(s.io.context).toHaveBeenCalledTimes(1));
  messages.push({ ...old.messages[0]!, text: 'new edit' }); s.advance(); await s.service.tick();
  expect(old.messages[0]!.text).toBe('new edit');
  history.resolve([{ ...messages[0]!, text: 'stale edit' }]);
  await vi.waitFor(() => expect(s.store.data.cursors['context:oc_old']).toBe(1_000_000));
  expect(old.messages[0]!.text).toBe('new edit');
});

it('does not let an older collection response undo an edit found by history', async () => {
  const s = await setup(); const old = s.old(); const history = gate<InboxMessage[]>(); const collection = gate<InboxMessage[]>();
  vi.mocked(s.io.context).mockReturnValueOnce(history.promise);
  await s.service.tick(); await vi.waitFor(() => expect(s.io.context).toHaveBeenCalledTimes(1));
  vi.mocked(s.io.collect).mockReturnValueOnce(collection.promise); s.advance(); const tick = s.service.tick();
  try {
    await vi.waitFor(() => expect(s.io.collect).toHaveBeenCalledTimes(3));
    history.resolve([{ ...old.messages[0]!, text: 'new edit' }]);
    await vi.waitFor(() => expect(old.messages[0]!.text).toBe('new edit'));
    collection.resolve([{ ...old.messages[0]!, text: 'stale edit' }]); await tick;
    expect(old.messages[0]!.text).toBe('new edit');
  } finally { history.resolve([]); collection.resolve([]); await tick; }
});
