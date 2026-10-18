import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { InboxService } from '../../../src/inbox/service';
import { InboxStore } from '../../../src/inbox/store';
import { normalizeInbox } from '../../../src/inbox/config';
import type { InboxIO, InboxJob } from '../../../src/inbox/types';

const result = { text: JSON.stringify({ replyDraft: '已核实', analysis: '核查结果', missingInfo: '' }), inputTokens: 1, outputTokens: 1 };
const services: InboxService[] = [];
beforeEach(() => vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] }));
afterEach(async () => { await Promise.all(services.splice(0).map(s => s.close())); vi.useRealTimers(); });

function gate<T>(signal: AbortSignal) {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res, reject) => {
    resolve = res;
    if (signal.aborted) reject(Error('cancelled'));
    else signal.addEventListener('abort', () => reject(Error('cancelled')), { once: true });
  });
  return { resolve, promise, signal };
}

async function setup() {
  let now = 1_000_000;
  const config = normalizeInbox({ enabled: true, ownerOpenId: 'ou_owner', executorProfile: 'codex',
    destination: { chatId: 'oc_target', threadId: 'omt_item', replyTo: 'om_item' } });
  const store = new InboxStore(join(await mkdtemp(join(tmpdir(), 'inbox-concurrency-')), 'state.json'));
  let started!: () => void;
  const analysisStarted = new Promise<void>(resolve => { started = resolve; });
  const analyses: ReturnType<typeof gate<typeof result>>[] = [];
  const screenings: ReturnType<typeof gate<Awaited<ReturnType<NonNullable<InboxIO['triage']>>>>>[] = [];
  const io: InboxIO = { checkOwner: vi.fn(async () => {}), collect: vi.fn(async () => []), context: vi.fn(async () => []),
    source: vi.fn(async () => ({ name: '群', type: 'p2p' as const })), deliver: vi.fn(async () => {}),
    beginAnalysis: vi.fn(async () => config.destination),
    analyze: vi.fn((_job, signal) => { const run = gate<typeof result>(signal); analyses.push(run); started(); return run.promise; }),
    triage: vi.fn((_jobs, signal) => { const run = gate<Awaited<ReturnType<NonNullable<InboxIO['triage']>>>>(signal); screenings.push(run); return run.promise; }) };
  const service = new InboxService(store, config, io, () => now); services.push(service); await service.start();
  const add = (id: string, state: 'queued' | 'waiting') => {
    const job: InboxJob = { id, ownerOpenId: 'ou_owner', profile: 'codex', destination: config.destination,
      source: { chatId: `oc_${id}`, name: id, type: 'p2p' }, state, automatic: false, alert: false,
      analysisRequested: state === 'queued', attention: { state: state === 'queued' ? 'needed' : 'pending', reason: '请求处理' },
      createdAt: now - 120_000, updatedAt: now - 120_000, messages: [{ id: `om_${id}`, chatId: `oc_${id}`, chatName: id,
        chatType: 'p2p', senderId: 'ou_sender', senderName: '同事', bot: false, time: now - 120_000, text: '请确认', mentions: [] }] };
    store.data.jobs.push(job); return job;
  };
  return { service, io, store, analysisStarted, analyses, screenings, add, advance: () => { now += 120_000; } };
}

it('runs one analysis and one screening concurrently while continuing collection and queueing', async () => {
  const s = await setup(); s.add('analysis', 'queued'); s.add('screening', 'waiting');
  await s.service.tick(); await s.analysisStarted;
  expect(s.screenings).toHaveLength(1);
  s.add('next', 'queued'); s.advance(); await s.service.tick(); await s.service.tick();
  expect(s.analyses).toHaveLength(1); expect(s.screenings).toHaveLength(1);
  expect(s.io.collect).toHaveBeenCalledTimes(4);
  s.screenings[0]!.resolve([{ id: 'screening', state: 'needed', reason: '有新请求' }]);
  await vi.waitFor(() => expect(s.store.data.jobs.find(j => j.id === 'screening')?.state).toBe('queued'));
  s.add('third', 'waiting'); await s.service.tick();
  expect(s.screenings).toHaveLength(2); expect(s.analyses).toHaveLength(1);
  s.analyses[0]!.resolve(result); await vi.waitFor(() => expect(s.store.data.jobs[0]?.state).toBe('ready'));
  await s.service.tick(); await vi.waitFor(() => expect(s.analyses).toHaveLength(2));
  expect(s.screenings[1]!.signal.aborted).toBe(false);
});

it.each(['analysis', 'screening'] as const)('cancels only the %s task when its item is ignored', async kind => {
  const s = await setup(); s.add('analysis', 'queued'); s.add('screening', 'waiting');
  await s.service.tick(); await s.analysisStarted;
  await s.service.decide(kind, 'ignore', 'ou_owner');
  expect(s.analyses[0]!.signal.aborted).toBe(kind === 'analysis');
  expect(s.screenings[0]!.signal.aborted).toBe(kind === 'screening');
});

it.each(['off', 'scope', 'close'] as const)('cancels both independent tasks on %s', async action => {
  const s = await setup(); s.add('analysis', 'queued'); s.add('screening', 'waiting');
  await s.service.tick(); await s.analysisStarted;
  if (action === 'off') await s.service.setMode('off');
  if (action === 'scope') await s.service.setScope('private');
  if (action === 'close') await s.service.close();
  expect(s.analyses[0]!.signal.aborted).toBe(true); expect(s.screenings[0]!.signal.aborted).toBe(true);
  expect(s.io.deliver).not.toHaveBeenCalled();
});

it('does not let a late screening overwrite manual analysis of the same item', async () => {
  const s = await setup(); s.add('manual', 'waiting');
  await s.service.tick(); expect(s.screenings).toHaveLength(1);
  await s.service.decide('manual', 'process', 'ou_owner'); await s.service.tick();
  await s.analysisStarted;
  s.screenings[0]!.resolve([{ id: 'manual', state: 'needed', reason: 'stale decision' }]);
  await vi.waitFor(() => expect(s.service.list()[0]?.attention?.progress).toBeUndefined());
  expect(s.store.data.jobs[0]).toMatchObject({ state: 'running', attempt: 1, automatic: false });
  s.analyses[0]!.resolve(result); await vi.waitFor(() => expect(s.store.data.jobs[0]?.state).toBe('ready'));
  await s.service.tick(); expect(s.analyses).toHaveLength(1); expect(s.io.deliver).toHaveBeenCalledTimes(1);
});

it('keeps analysis and unrelated screening running when a message is updated', async () => {
  const s = await setup(); const job = s.add('analysis', 'queued'); s.add('screening', 'waiting');
  await s.service.tick(); await s.analysisStarted;
  vi.mocked(s.io.collect).mockResolvedValue([{ ...job.messages[0]!, text: '新的问题', time: 1_120_000 }]);
  s.advance(); await s.service.tick();
  expect(s.analyses[0]!.signal.aborted).toBe(false); expect(s.screenings[0]!.signal.aborted).toBe(false);
  expect(job.state).toBe('running'); expect(job.messages[0]?.text).toBe('新的问题');
  s.analyses[0]!.resolve(result);
  await vi.waitFor(() => expect(job.state).toBe('waiting'));
  expect(job.replyDraft).toBe('已核实'); expect(job.attention?.state).toBe('pending');
});
