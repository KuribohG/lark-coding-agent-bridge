import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { normalizeInbox } from '../../../src/inbox/config';
import { InboxService } from '../../../src/inbox/service';
import { InboxStore } from '../../../src/inbox/store';
import { analysisChanges } from '../../../src/inbox/updates';
import { processingPrompt } from '../../../src/inbox/processor';
import type { InboxIO, InboxJob, InboxMessage, TriageDecision } from '../../../src/inbox/types';

const result = { text: JSON.stringify({ replyDraft: '原建议', analysis: '已核实的证据', missingInfo: '' }), inputTokens: 1, outputTokens: 1 };
const services: InboxService[] = [];
beforeEach(() => vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] }));
afterEach(async () => { await Promise.all(services.splice(0).map(s => s.close())); vi.useRealTimers(); });

function gate<T>(signal: AbortSignal) {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  signal.addEventListener('abort', () => reject(Error('cancelled')), { once: true });
  return { resolve, reject, promise, signal };
}

async function setup() {
  let now = 1_000_000;
  const messages: InboxMessage[] = [];
  const screens: (ReturnType<typeof gate<TriageDecision[]>> & { jobs: InboxJob[] })[] = [];
  const analyses: (ReturnType<typeof gate<typeof result>> & { job: InboxJob })[] = [];
  const config = normalizeInbox({ enabled: true, executorProfile: 'codex', ownerOpenId: 'ou_owner', intakeScope: 'all',
    destination: { chatId: 'oc_target', threadId: 'omt_item', replyTo: 'om_item' } });
  const io: InboxIO = {
    checkOwner: vi.fn(async () => {}), source: vi.fn(async () => ({ name: '告警', type: 'group' as const })),
    collect: vi.fn(async kind => kind === 'group' ? structuredClone(messages) : []), context: vi.fn(async () => []),
    beginAnalysis: vi.fn(async () => config.destination), deliver: vi.fn(async () => {}),
    analyze: vi.fn((job, signal) => { const run = { ...gate<typeof result>(signal), job }; analyses.push(run); return run.promise; }),
    triage: vi.fn((jobs, signal) => { const run = { ...gate<TriageDecision[]>(signal), jobs }; screens.push(run); return run.promise; }),
  };
  const store = new InboxStore(join(await mkdtemp(join(tmpdir(), 'inbox-updates-')), 'state.json'));
  const service = new InboxService(store, config, io, () => now); services.push(service); await service.start();
  const add = async (text: string, id = `om_${messages.length}`) => {
    now += 1000;
    const m: InboxMessage = { id, chatId: 'oc_source', chatName: '告警', chatType: 'group', senderId: 'ou_sender', senderName: '告警助手',
      bot: true, time: now, text, mentions: ['ou_owner'] };
    const at = messages.findIndex(m => m.id === id);
    if (at < 0) messages.push(m); else messages[at] = m;
    await service.tick();
  };
  const screen = (index: number, state: TriageDecision['state'], followUp?: TriageDecision['followUp']) => {
    screens[index]!.resolve(screens[index]!.jobs.map(job => ({ id: job.id, state, followUp, reason: '有明确证据' })));
  };
  await add('你的任务需要处理'); screen(0, 'needed');
  await vi.waitFor(() => expect(analyses).toHaveLength(1));
  return { service, store, config, io, messages, screens, analyses, add, screen, now: () => now, job: () => store.data.jobs[0]! };
}

it('retains an actionable result through unrelated bursts and delivers it only once', async () => {
  const s = await setup();
  for (let i = 0; i < 12; i++) await s.add(`其他任务告警 ${i}`);
  expect(s.analyses[0]!.signal.aborted).toBe(false); expect(s.screens).toHaveLength(1);
  expect(s.job().messages).toHaveLength(13); expect(s.analyses[0]!.job.messages).toHaveLength(1);
  s.analyses[0]!.resolve(result);
  await vi.waitFor(() => expect(s.screens).toHaveLength(2));
  expect(analysisChanges(s.screens[1]!.jobs[0]!)).toHaveLength(12);
  expect(s.job()).toMatchObject({ replyDraft: '原建议', draftStale: true, state: 'waiting' });
  await s.service.tick(); expect(s.io.deliver).not.toHaveBeenCalled();
  s.screen(1, 'quiet', 'unchanged');
  await vi.waitFor(() => expect(s.job().state).toBe('ready'));
  expect(s.job().attention?.state).toBe('needed'); expect(s.job().draftStale).toBe(false);
  await s.service.tick(); await s.add('其他任务新增告警');
  expect(s.screens).toHaveLength(3); expect(analysisChanges(s.screens[2]!.jobs[0]!)).toHaveLength(1);
  s.screen(2, 'needed', 'unchanged');
  await vi.waitFor(() => expect(s.job().state).toBe('done')); await s.service.tick();
  expect(s.analyses).toHaveLength(1); expect(s.io.beginAnalysis).toHaveBeenCalledTimes(1);
  expect(s.io.deliver).toHaveBeenCalledTimes(1); expect(s.store.data.jobs).toHaveLength(1);
});

it('rejects a stale incremental decision and reuses prior evidence for one supplemental analysis', async () => {
  const s = await setup(); await s.add('告警重复'); s.analyses[0]!.resolve(result);
  await vi.waitFor(() => expect(s.screens).toHaveLength(2));
  await s.add('同一任务出现数据丢失'); s.screen(1, 'needed', 'unchanged');
  await vi.waitFor(() => expect(s.screens).toHaveLength(3));
  expect(s.job().state).toBe('waiting'); expect(s.io.deliver).not.toHaveBeenCalled();
  s.screen(2, 'needed', 'reanalyze'); await vi.waitFor(() => expect(s.analyses).toHaveLength(2));
  const input = s.analyses[1]!.job;
  expect(analysisChanges(input).map(m => m.text)).toEqual(['告警重复', '同一任务出现数据丢失']);
  expect(processingPrompt(input, '')).toContain('已核实的证据');
  expect(processingPrompt(input, '')).toContain('不要从头重复已完成的调查');
  await s.add('另一条重复告警'); expect(s.analyses[1]!.signal.aborted).toBe(false);
  s.analyses[1]!.resolve({ ...result, text: JSON.stringify({ replyDraft: '补充建议', analysis: '新证据', missingInfo: '' }) });
  await vi.waitFor(() => expect(s.screens).toHaveLength(4));
  expect(analysisChanges(s.screens[3]!.jobs[0]!).map(m => m.text)).toEqual(['另一条重复告警']);
  s.screen(3, 'needed', 'unchanged'); await vi.waitFor(() => expect(s.job().state).toBe('ready'));
  await s.service.tick(); expect(s.job().replyDraft).toBe('补充建议');
  expect(s.analyses).toHaveLength(2); expect(s.io.beginAnalysis).toHaveBeenCalledTimes(1); expect(s.io.deliver).toHaveBeenCalledTimes(1);
});

it('suppresses an obsolete draft when the issue is resolved, including later unchanged updates', async () => {
  const s = await setup(); await s.add('原任务已恢复，无需操作'); s.analyses[0]!.resolve(result);
  await vi.waitFor(() => expect(s.screens).toHaveLength(2)); s.screen(1, 'quiet', 'resolved');
  await vi.waitFor(() => expect(s.job().state).toBe('done')); await s.service.tick();
  expect(s.job()).toMatchObject({ attention: { state: 'quiet' }, draftStale: true, replyDraft: '原建议' });
  await s.add('无关任务告警'); s.screen(2, 'quiet', 'unchanged');
  await vi.waitFor(() => expect(s.job().attention?.state).toBe('quiet')); await s.service.tick();
  expect(s.io.deliver).not.toHaveBeenCalled(); expect(s.analyses).toHaveLength(1);
});

it('retains an edited message and compares its new text with the analysis snapshot', async () => {
  const s = await setup(); await s.add('任务的损坏范围已扩大', 'om_0');
  s.analyses[0]!.resolve(result); await vi.waitFor(() => expect(s.screens).toHaveLength(2));
  expect(s.job().messages).toHaveLength(1);
  expect(analysisChanges(s.screens[1]!.jobs[0]!)[0]?.text).toBe('任务的损坏范围已扩大');
  expect(s.analyses[0]!.job.messages[0]?.text).toBe('你的任务需要处理');
});

it('retries an incomplete follow-up decision without discarding the completed analysis', async () => {
  const s = await setup(); await s.add('补充'); s.analyses[0]!.resolve(result);
  await vi.waitFor(() => expect(s.screens).toHaveLength(2)); s.screen(1, 'needed');
  await vi.waitFor(() => expect(s.job().attention?.retry).toBeDefined());
  expect(s.job().replyDraft).toBe('原建议'); expect(s.job().draftStale).toBe(true);
  await s.add('再补充'); expect(s.screens).toHaveLength(2); expect(s.analyses).toHaveLength(1);
});

it.each(['failure', 'off', 'edit'] as const)('new messages cannot restart an analysis after %s until explicit processing', async action => {
  const s = await setup(); await s.add('运行期间补充');
  if (action === 'failure') { s.analyses[0]!.reject(Error('cancelled')); await vi.waitFor(() => expect(s.job().state).toBe('failed')); }
  if (action === 'off') { await s.service.setMode('off'); await s.service.setMode('on'); }
  if (action === 'edit') await s.service.review({ id: s.job().id, revision: s.job().revision, replyDraft: '人工草稿' }, 'ou_owner', 'edit');
  expect(s.job().analysisPaused).toBe(true);
  await s.add('停止之后新消息'); await vi.waitFor(() => expect(s.screens).toHaveLength(2)); s.screen(1, 'needed');
  await vi.waitFor(() => expect(s.job().attention?.state).toBe('needed')); await s.service.tick();
  expect(s.analyses).toHaveLength(1);
  if (action === 'edit') expect(s.job().replyDraft).toBe('人工草稿');
  await s.service.decide(s.job().id, 'process', 'ou_owner'); await s.service.tick();
  await vi.waitFor(() => expect(s.analyses).toHaveLength(2)); expect(s.job().analysisPaused).toBe(false);
});

it('persists the completed result and unreviewed additions across a restart', async () => {
  const s = await setup(); await s.add('待补筛内容'); s.analyses[0]!.resolve(result);
  await vi.waitFor(() => expect(s.screens).toHaveLength(2)); await s.service.close();
  const store = new InboxStore(s.store.path);
  const restarted = new InboxService(store, s.config, s.io, s.now); services.push(restarted); await restarted.start(); await restarted.tick();
  await vi.waitFor(() => expect(s.screens).toHaveLength(3));
  expect(s.screens[2]!.jobs[0]?.replyDraft).toBe('原建议');
  expect(analysisChanges(s.screens[2]!.jobs[0]!)[0]?.text).toBe('待补筛内容');
  s.screen(2, 'needed', 'unchanged'); await vi.waitFor(() => expect(store.data.jobs[0]?.state).toBe('ready'));
  await restarted.tick(); expect(s.analyses).toHaveLength(1); expect(s.io.deliver).toHaveBeenCalledTimes(1);
});

it('requires an explicit retry after loading an interrupted run with new messages', async () => {
  const s = await setup(); await s.add('中断前补充');
  const recovered = new InboxStore(join(await mkdtemp(join(tmpdir(), 'inbox-recovered-')), 'state.json'));
  recovered.data = structuredClone(s.store.data); await recovered.save(); await recovered.load();
  expect(recovered.data.jobs[0]).toMatchObject({ state: 'failed', analysisPaused: true, analysisRequested: false });
  expect(recovered.data.jobs[0]?.messages).toHaveLength(2);
});
