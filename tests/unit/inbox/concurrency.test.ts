import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { InboxService } from '../../../src/inbox/service';
import { InboxStore } from '../../../src/inbox/store';
import { normalizeInbox } from '../../../src/inbox/config';
import type { InboxIO, InboxJob } from '../../../src/inbox/types';
import { InboxAnalysisQueue } from '../../../src/inbox/task-source';

const result = { text: JSON.stringify({ replyDraft: '已核实', analysis: '核查结果', missingInfo: '' }), inputTokens: 1, outputTokens: 1 };
const services: InboxService[] = [];
beforeEach(() => vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] }));
afterEach(async () => { await Promise.all(services.splice(0).map(s => s.close())); vi.useRealTimers(); });

function gate<T>(signal: AbortSignal) {
  let resolve!: (value: T) => void;
  let fail!: (error: Error) => void;
  const promise = new Promise<T>((res, reject) => {
    resolve = res; fail = reject;
    if (signal.aborted) reject(Error('cancelled'));
    else signal.addEventListener('abort', () => reject(Error('cancelled')), { once: true });
  });
  return { resolve, reject: fail, promise, signal };
}

async function setup(queue?: InboxAnalysisQueue, triageQueue?: InboxAnalysisQueue) {
  let now = 1_000_000;
  const config = normalizeInbox({ enabled: true, ownerOpenId: 'ou_owner', executorProfile: 'codex',
    destination: { chatId: 'oc_target', threadId: 'omt_item', replyTo: 'om_item' } });
  const store = new InboxStore(join(await mkdtemp(join(tmpdir(), 'inbox-concurrency-')), 'state.json'));
  let started!: () => void;
  const analysisStarted = new Promise<void>(resolve => { started = resolve; });
  const analyses: (ReturnType<typeof gate<typeof result>> & { id: string })[] = [];
  const screenings: (ReturnType<typeof gate<Awaited<ReturnType<NonNullable<InboxIO['triage']>>>>> & { id: string })[] = [];
  const io: InboxIO = { checkOwner: vi.fn(async () => {}), collect: vi.fn(async () => []), context: vi.fn(async () => []),
    source: vi.fn(async () => ({ name: '群', type: 'p2p' as const })), deliver: vi.fn(async () => {}),
    beginAnalysis: vi.fn(async () => config.destination),
    analyze: vi.fn((job, signal) => { const run = gate<typeof result>(signal); analyses.push({ ...run, id: job.id }); started(); return run.promise; }),
    triage: vi.fn<NonNullable<InboxIO['triage']>>((job, signal) => { const run = gate<Awaited<ReturnType<NonNullable<InboxIO['triage']>>>>(signal); screenings.push({ ...run, id: job.id }); return run.promise; }) };
  const service = new InboxService(store, config, io, () => now, queue, triageQueue); services.push(service); await service.start();
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

it('runs five analyses alongside independent screening and refills without waiting for collection', async () => {
  const s = await setup();
  for (let i = 0; i < 7; i++) s.add(`analysis-${i}`, 'queued');
  s.add('screening', 'waiting');
  await s.service.tick(); await vi.waitFor(() => expect(s.analyses).toHaveLength(5));
  expect(s.screenings).toHaveLength(1);
  s.advance(); await Promise.all([s.service.tick(), s.service.tick()]);
  expect(s.analyses).toHaveLength(5); expect(s.screenings).toHaveLength(1);
  expect(s.io.collect).toHaveBeenCalledTimes(4);
  expect(s.store.data.jobs.filter(j => j.state === 'queued')).toHaveLength(2);
  s.screenings[0]!.resolve({ id: 'screening', state: 'needed', reason: '有新请求' });
  await vi.waitFor(() => expect(s.store.data.jobs.find(j => j.id === 'screening')?.state).toBe('queued'));
  s.add('third', 'waiting'); await s.service.tick();
  expect(s.screenings).toHaveLength(2); expect(s.analyses).toHaveLength(5);
  s.analyses[3]!.resolve(result);
  await vi.waitFor(() => expect(s.analyses).toHaveLength(6));
  expect(s.analyses[5]!.id).toBe('analysis-5');
  s.analyses[1]!.reject(Error('model unavailable'));
  await vi.waitFor(() => expect(s.analyses).toHaveLength(7));
  expect(s.analyses[6]!.id).toBe('analysis-6');
  expect(s.service.get('analysis-1')?.state).toBe('failed');
  expect(s.store.data.jobs.filter(j => j.state === 'running')).toHaveLength(5);
  expect(s.screenings[1]!.signal.aborted).toBe(false);
});

it.each(['analysis', 'screening'] as const)('cancels only the %s task when its item is ignored', async kind => {
  const s = await setup(); s.add('analysis', 'queued'); s.add('screening', 'waiting');
  for (let i = 0; i < 4; i++) s.add(`other-${i}`, 'queued');
  await s.service.tick(); await vi.waitFor(() => expect(s.analyses).toHaveLength(5));
  await s.service.decide(kind, 'ignore', 'ou_owner');
  expect(s.analyses[0]!.signal.aborted).toBe(kind === 'analysis');
  expect(s.analyses.slice(1).every(run => !run.signal.aborted)).toBe(true);
  expect(s.screenings[0]!.signal.aborted).toBe(kind === 'screening');
});

it.each(['off', 'scope', 'close'] as const)('cancels all analyses and screening on %s', async action => {
  const s = await setup(); s.add('analysis', 'queued'); s.add('screening', 'waiting');
  for (let i = 0; i < 6; i++) s.add(`other-${i}`, 'queued');
  await s.service.tick(); await vi.waitFor(() => expect(s.analyses).toHaveLength(5));
  if (action === 'off') await s.service.setMode('off');
  if (action === 'scope') await s.service.setScope('private');
  if (action === 'close') await s.service.close();
  expect(s.analyses.every(run => run.signal.aborted)).toBe(true); expect(s.screenings[0]!.signal.aborted).toBe(true);
  if (action !== 'scope') { await s.service.tick(); expect(s.analyses).toHaveLength(5); }
  expect(s.io.deliver).not.toHaveBeenCalled();
});

it('does not let a late screening overwrite manual analysis of the same item', async () => {
  const s = await setup(); s.add('manual', 'waiting');
  await s.service.tick(); expect(s.screenings).toHaveLength(1);
  await s.service.decide('manual', 'process', 'ou_owner'); await s.service.tick();
  await s.analysisStarted;
  s.screenings[0]!.resolve({ id: 'manual', state: 'needed', reason: 'stale decision' });
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

it('shares five execution slots across sources and promptly cancels a queued item', async () => {
  const queue = new InboxAnalysisQueue(5);
  const a = await setup(queue); const b = await setup(queue);
  for (let i = 0; i < 3; i++) a.add(`a-${i}`, 'queued');
  for (let i = 0; i < 5; i++) b.add(`b-${i}`, 'queued');
  await a.service.tick(); await vi.waitFor(() => expect(a.analyses).toHaveLength(3));
  await b.service.tick(); await vi.waitFor(() => expect(b.analyses).toHaveLength(2));
  await b.service.decide('b-2', 'ignore', 'ou_owner');
  a.analyses[1]!.resolve(result);
  await vi.waitFor(() => expect(b.analyses).toHaveLength(3));
  expect(b.analyses[2]!.id).toBe('b-3');
  expect(a.analyses.filter(run => run.signal.aborted)).toHaveLength(0);
  expect(b.analyses.some(run => run.id === 'b-2')).toBe(false);
});

it('waits for a stopped attempt to settle before retrying the same item', async () => {
  const s = await setup(); s.add('analysis', 'queued'); s.add('other', 'queued');
  let finish!: (value: typeof result) => void;
  let signal!: AbortSignal;
  vi.mocked(s.io.analyze).mockImplementationOnce((_job, current) => {
    signal = current; return new Promise(resolve => { finish = resolve; });
  });
  await s.service.tick(); await vi.waitFor(() => expect(finish).toBeDefined());
  await s.service.review({ id: 'analysis', revision: s.service.get('analysis')?.revision ?? 0, replyDraft: '人工草稿' }, 'ou_owner', 'edit');
  expect(signal.aborted).toBe(true);
  await s.service.decide('analysis', 'process', 'ou_owner'); await s.service.tick();
  expect(s.io.analyze).toHaveBeenCalledTimes(2);
  finish(result);
  await vi.waitFor(() => expect(s.io.analyze).toHaveBeenCalledTimes(3));
  expect(s.service.get('analysis')).toMatchObject({ state: 'running', attempt: 2, replyDraft: '人工草稿' });
  expect(s.analyses[0]!.signal.aborted).toBe(false);
});

it('runs fifty single-item screenings alongside five analyses and refills each pool independently', async () => {
  const s = await setup();
  for (let i = 0; i < 53; i++) s.add(`screen-${i}`, 'waiting');
  for (let i = 0; i < 7; i++) s.add(`analysis-${i}`, 'queued');
  await s.service.tick(); await vi.waitFor(() => expect(s.screenings).toHaveLength(50));
  expect(s.analyses).toHaveLength(5);
  expect(new Set(s.screenings.map(run => run.id)).size).toBe(50);
  await s.service.tick(); expect(s.screenings).toHaveLength(50);
  s.screenings[17]!.resolve({ id: 'screen-17', state: 'needed', reason: '需要处理' });
  await vi.waitFor(() => expect(s.screenings).toHaveLength(51));
  expect(s.screenings[50]!.id).toBe('screen-50'); expect(s.analyses).toHaveLength(5);
  expect(s.service.get('screen-17')?.state).toBe('queued');
  s.analyses[3]!.resolve(result); await vi.waitFor(() => expect(s.analyses).toHaveLength(6));
  expect(s.analyses[5]!.id).toBe('screen-17');
  s.screenings[4]!.reject(Error('HTTP 429'));
  await vi.waitFor(() => expect(s.screenings).toHaveLength(52));
  expect(s.service.get('screen-4')?.attention?.retry?.error).toBe('模型服务限流');
  expect(s.screenings[51]!.id).toBe('screen-51');
  expect(s.screenings.every(run => !run.signal.aborted)).toBe(true);
});

it('cancels one screening without affecting another and fills only that released slot', async () => {
  const s = await setup(undefined, new InboxAnalysisQueue(2));
  for (let i = 0; i < 3; i++) s.add(`screen-${i}`, 'waiting');
  await s.service.tick(); await vi.waitFor(() => expect(s.screenings).toHaveLength(2));
  await s.service.decide('screen-0', 'ignore', 'ou_owner');
  await vi.waitFor(() => expect(s.screenings).toHaveLength(3));
  expect(s.screenings[0]!.signal.aborted).toBe(true);
  expect(s.screenings[1]!.signal.aborted).toBe(false);
  expect(s.screenings[2]!.id).toBe('screen-2');
});

it('shares the screening limit across sources independently of occupied analysis slots', async () => {
  const queue = new InboxAnalysisQueue(1), triageQueue = new InboxAnalysisQueue(2);
  const a = await setup(queue, triageQueue), b = await setup(queue, triageQueue);
  a.add('a-0', 'waiting'); a.add('a-1', 'waiting'); a.add('analysis-a', 'queued');
  b.add('b-0', 'waiting'); b.add('b-1', 'waiting'); b.add('analysis-b', 'queued');
  await a.service.tick(); await vi.waitFor(() => expect(a.screenings).toHaveLength(2));
  await vi.waitFor(() => expect(a.analyses).toHaveLength(1));
  await b.service.tick(); expect(b.screenings).toHaveLength(0); expect(b.analyses).toHaveLength(0);
  await b.service.decide('b-0', 'ignore', 'ou_owner');
  a.screenings[1]!.resolve({ id: 'a-1', state: 'quiet', reason: '无需处理' });
  await vi.waitFor(() => expect(b.screenings).toHaveLength(1));
  expect(b.screenings[0]!.id).toBe('b-1'); expect(b.analyses).toHaveLength(0);
  expect(a.analyses[0]!.signal.aborted).toBe(false);
});

it('resizes screening independently and drains existing items without cancelling them', async () => {
  const queue = new InboxAnalysisQueue(1), triageQueue = new InboxAnalysisQueue(1);
  const s = await setup(queue, triageQueue);
  for (let i = 0; i < 4; i++) s.add(`screen-${i}`, 'waiting');
  s.add('analysis-0', 'queued'); s.add('analysis-1', 'queued');
  await s.service.tick(); await vi.waitFor(() => expect(s.screenings).toHaveLength(1));
  triageQueue.resize(3); await s.service.tick();
  await vi.waitFor(() => expect(s.screenings).toHaveLength(3)); expect(s.analyses).toHaveLength(1);
  triageQueue.resize(1);
  for (let i = 0; i < 2; i++) s.screenings[i]!.resolve({ id: `screen-${i}`, state: 'quiet', reason: '无需处理' });
  await vi.waitFor(() => expect(s.service.get('screen-1')?.attention?.state).toBe('quiet'));
  await s.service.tick(); expect(s.screenings).toHaveLength(3);
  expect(s.screenings[2]!.signal.aborted).toBe(false);
  queue.resize(2); await s.service.tick(); await vi.waitFor(() => expect(s.analyses).toHaveLength(2));
  expect(s.screenings).toHaveLength(3);
  s.screenings[2]!.resolve({ id: 'screen-2', state: 'quiet', reason: '无需处理' });
  await vi.waitFor(() => expect(s.screenings).toHaveLength(4));
});

it('waits for a cancelled screening to settle before rescreening the restored item', async () => {
  const s = await setup(); s.add('screen', 'waiting'); s.add('other', 'waiting');
  let finish!: (value: Awaited<ReturnType<NonNullable<InboxIO['triage']>>>) => void;
  let signal!: AbortSignal;
  vi.mocked(s.io.triage!).mockImplementationOnce((_job, current) => {
    signal = current; return new Promise(resolve => { finish = resolve; });
  });
  await s.service.tick(); await vi.waitFor(() => expect(finish).toBeDefined());
  await s.service.decide('screen', 'ignore', 'ou_owner');
  await s.service.review({ id: 'screen', revision: s.service.get('screen')?.revision ?? 0, handlingState: 'open' }, 'ou_owner', 'restore');
  await s.service.tick(); expect(signal.aborted).toBe(true); expect(s.io.triage).toHaveBeenCalledTimes(2);
  finish({ id: 'screen', state: 'needed', reason: '过期判断' });
  await vi.waitFor(() => expect(s.io.triage).toHaveBeenCalledTimes(3));
  expect(s.service.get('screen')?.attention?.state).toBe('pending');
  expect(s.screenings[0]!.signal.aborted).toBe(false);
});

it('counts each screening attempt against the daily budget', async () => {
  const s = await setup(); s.service.config.dailyTriageLimit = 2;
  for (let i = 0; i < 5; i++) s.add(`screen-${i}`, 'waiting');
  await s.service.tick(); await vi.waitFor(() => expect(s.screenings).toHaveLength(2));
  expect(s.store.data.triageUsage?.['1970-01-01']).toBe(2);
  expect(s.store.data.jobs.filter(job => job.attention?.retry)).toHaveLength(3);
});

it('stops one running item and one queued item while preserving the other analyses and screening', async () => {
  const s = await setup();
  for (let i = 0; i < 6; i++) s.add(`analysis-${i}`, 'queued');
  s.add('screening', 'waiting');
  await s.service.tick(); await vi.waitFor(() => expect(s.analyses).toHaveLength(5));
  await s.service.stopAnalysis({ id: 'analysis-5', revision: s.service.get('analysis-5')?.revision ?? 0 }, 'ou_owner', 'stop-queued');
  await s.service.stopAnalysis({ id: 'analysis-2', revision: s.service.get('analysis-2')?.revision ?? 0 }, 'ou_owner', 'stop-running');
  await vi.waitFor(() => expect(s.analyses[2]!.signal.aborted).toBe(true));
  expect(s.analyses.filter(run => run.signal.aborted).map(run => run.id)).toEqual(['analysis-2']);
  expect(s.screenings[0]!.signal.aborted).toBe(false);
  await s.service.tick(); expect(s.analyses).toHaveLength(5);
  for (const id of ['analysis-2', 'analysis-5']) expect(s.service.get(id)).toMatchObject({
    state: 'waiting', analysisRequested: false, analysisPaused: true, analysisStoppedAt: expect.any(Number),
  });
});
