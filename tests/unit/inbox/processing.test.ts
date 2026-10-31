import { preparedRun } from '../../../src/agent/prepared-run';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { AgentAdapter, AgentEvent } from '../../../src/agent/types';
import { normalizeInbox } from '../../../src/inbox/config';
import { InboxAnalysisError } from '../../../src/inbox/analysis-error';
import { InboxLark } from '../../../src/inbox/lark';
import { processInbox } from '../../../src/monitoring/sources/lark/processor';
import { InboxService } from '../../../src/inbox/service';
import { InboxStore } from '../../../src/inbox/store';
import { InboxAnalysisQueue } from '../../../src/inbox/task-source';
import { executeInboxCommand } from '../../../src/inbox/workbench';
import type { InboxIO, InboxMessage } from '../../../src/inbox/types';
import { workItemTarget } from '../../../src/inbox/lark-target';

const executionCapabilities = { finalAnswer: 'separate-event', input: 'unsupported' } as const;

const topic = workItemTarget({ chatId: 'oc_target', threadId: 'omt_item', replyTo: 'om_item' });
const config = () => normalizeInbox({ enabled: true, executorProfile: 'codex', recipientKey: 'ou_owner', deliveryMode: 'new_topic',
  target: workItemTarget({ chatId: 'oc_target', threadId: 'omt_menu', replyTo: 'om_menu' }), gui: { publicUrl: 'https://gui.example', apiKeyFile: '/key' } });
const message: InboxMessage = { id: 'om_source', containerId: 'oc_source', containerName: '项目群',
  containerKind: 'direct', senderId: 'ou_sender', senderName: '同事', senderBot: false,
  time: 1_000_000, text: '请确认这个问题并回复', mentions: [] };
const result = { text: JSON.stringify({ replyDraft: '已确认，请按这个方案继续。', analysis: '已核对相关记录。', missingInfo: '' }), inputTokens: 10, outputTokens: 20 };
const services: InboxService[] = [];
afterEach(async () => { await Promise.all(services.splice(0).map(s => s.close())); });

async function setup(overrides: Partial<InboxIO> = {}, queue?: InboxAnalysisQueue) {
  let now = 1_000_000;
  const io: InboxIO = { checkOwner: vi.fn(async () => {}), collect: vi.fn(async kind => kind === 'p2p' ? [message] : []),
    context: vi.fn(async () => [message]), source: vi.fn(async () => ({ name: '项目群', type: 'p2p' as const })),
    beginAnalysis: vi.fn(async () => topic), deliver: vi.fn(async () => {}), analyze: vi.fn(async () => result),
    notifyAttention: vi.fn(async () => {}), triage: vi.fn<NonNullable<InboxIO['triage']>>(async j => ({ id: j.id, state: 'needed', reason: '需要回复方案' })), ...overrides };
  const store = new InboxStore(join(await mkdtemp(join(tmpdir(), 'inbox-processing-')), 'state.json'));
  const service = new InboxService(store, config(), io, () => now, queue); services.push(service); await service.start();
  await service.tick();
  await vi.waitFor(() => expect(service.list()[0]?.attention?.state).toBe('needed'));
  return { service, store, io, advance: (ms: number) => { now += ms; } };
}

it('stops the selected agent through the workbench command and rejects late output without delivering a failure', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const run = { runId: 'stoppable', capabilities: executionCapabilities, events: (async function* (): AsyncGenerator<AgentEvent> {
    await gate; yield { type: 'final_text', content: result.text }; yield { type: 'done', terminationReason: 'normal' };
  })(), stop: vi.fn(async () => { release(); }), waitForExit: vi.fn(async () => true) };
  const agent = { capabilities: executionCapabilities, prepareRun: vi.fn(async () => preparedRun({}, () => run)) } as unknown as AgentAdapter;
  const cwd = await mkdtemp(join(tmpdir(), 'inbox-stop-'));
  const s = await setup({ analyze: (job, signal) => processInbox(job, agent, cwd, '', signal) });
  await s.service.tick(); await vi.waitFor(() => expect(agent.prepareRun).toHaveBeenCalledOnce());
  const job = s.service.list()[0]!;
  s.store.data.jobs[0]!.replyDraft = '保留已有草稿';
  const stopped = await executeInboxCommand(s.service, {} as InboxLark, {
    id: '01234567-0123-4123-8123-0123456789ab', action: 'stop', target: JSON.stringify({ id: job.id, revision: job.revision }),
  });
  expect(stopped).toMatchObject({ state: 'waiting', handlingState: 'open', analysisStoppedAt: expect.any(Number), replyDraft: '保留已有草稿' });
  await vi.waitFor(() => expect(run.stop).toHaveBeenCalledOnce());
  await s.service.close();
  expect(s.service.list()[0]).toMatchObject({ state: 'waiting', analysisRequested: false, analysisTarget: topic, replyDraft: '保留已有草稿' });
  expect(s.service.list()[0]?.result).toBeUndefined(); expect(s.service.list()[0]?.error).toBeUndefined();
  expect(s.io.deliver).not.toHaveBeenCalled();
});

it('keeps a queued cancellation across restart and new messages until the owner explicitly retries', async () => {
  const s = await setup(); const job = s.service.list()[0]!;
  const input = { id: job.id, revision: job.revision };
  await s.service.stopAnalysis(input, 'ou_owner', 'stop-1');
  await s.service.stopAnalysis(input, 'ou_owner', 'stop-1');
  await s.service.tick(); expect(s.io.analyze).not.toHaveBeenCalled();
  await s.service.close();
  const store = new InboxStore(s.store.path);
  const resumed = new InboxService(store, config(), s.io, () => 2_000_000); services.push(resumed); await resumed.start();
  const newMessage = { ...message, id: 'om_update', replyTo: message.id, time: 2_000_000, text: '再补充一些信息' };
  vi.mocked(s.io.collect).mockResolvedValue([newMessage]); vi.mocked(s.io.context).mockResolvedValue([newMessage]);
  await resumed.tick(); await vi.waitFor(() => expect(resumed.list()[0]?.attention?.state).toBe('needed'));
  await resumed.tick(); expect(s.io.analyze).not.toHaveBeenCalled();
  expect(resumed.list()[0]).toMatchObject({ id: job.id, state: 'waiting', analysisStoppedAt: expect.any(Number) });
  await resumed.decide(job.id, 'process', 'ou_owner');
  // Replayed or stale stop requests must not cancel a newly requested analysis.
  await resumed.stopAnalysis(input, 'ou_owner', 'stop-1');
  await expect(resumed.stopAnalysis(input, 'ou_owner', 'stop-2')).rejects.toThrow('已更新');
  expect(resumed.list()[0]?.state).toBe('queued'); expect(resumed.list()[0]?.analysisStoppedAt).toBeUndefined();
  await resumed.tick(); await vi.waitFor(() => expect(s.io.analyze).toHaveBeenCalledOnce());
});

it('preserves a late-created topic but never starts the model after stopping its announcement', async () => {
  let finish!: (value: typeof topic) => void;
  const s = await setup({ beginAnalysis: vi.fn(() => new Promise<typeof topic>(resolve => { finish = resolve; })) });
  await s.service.tick(); await vi.waitFor(() => expect(finish).toBeDefined());
  const job = s.service.list()[0]!;
  await s.service.stopAnalysis({ id: job.id, revision: job.revision }, 'ou_owner');
  finish(topic); await s.service.close();
  expect(s.service.list()[0]).toMatchObject({ state: 'waiting', analysisTarget: topic, analysisRequested: false });
  expect(s.io.analyze).not.toHaveBeenCalled(); expect(s.io.deliver).not.toHaveBeenCalled();
});

it('validates ownership and revision and rolls back a failed save before cancelling the agent', async () => {
  let signal!: AbortSignal;
  const s = await setup({ analyze: vi.fn(async (_job, abort) => {
    signal = abort; await new Promise<void>(resolve => abort.addEventListener('abort', () => resolve(), { once: true })); return result;
  }) });
  await s.service.tick(); await vi.waitFor(() => expect(signal).toBeDefined());
  const job = s.service.list()[0]!; const input = { id: job.id, revision: job.revision };
  await expect(s.service.stopAnalysis(input, 'ou_other')).rejects.toThrow('forbidden');
  await expect(s.service.stopAnalysis({ ...input, revision: -1 }, 'ou_owner')).rejects.toThrow('无效');
  await expect(s.service.stopAnalysis({ ...input, revision: (job.revision ?? 0) + 1 }, 'ou_owner')).rejects.toThrow('已更新');
  vi.spyOn(s.store, 'save').mockRejectedValueOnce(Error('disk full'));
  await expect(s.service.stopAnalysis(input, 'ou_owner')).rejects.toThrow('disk full');
  expect(signal.aborted).toBe(false); expect(s.service.list()[0]).toEqual(job);
  await s.service.stopAnalysis(input, 'ou_owner'); expect(signal.aborted).toBe(true);
});

it('does not abort another analysis or concurrent screening when removing a queued item', async () => {
  let analysisSignal!: AbortSignal, triageSignal!: AbortSignal;
  const s = await setup({ analyze: vi.fn(async (_job, signal) => {
    analysisSignal = signal; await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })); return result;
  }) }, new InboxAnalysisQueue(1));
  await s.service.tick(); await vi.waitFor(() => expect(analysisSignal).toBeDefined());
  const job = s.store.data.jobs[0]!;
  s.store.data.jobs.push({ ...structuredClone(job), id: 'queued', state: 'queued' },
    { ...structuredClone(job), id: 'screening', state: 'waiting', analysisRequested: false, attention: { state: 'pending', reason: '等待筛选' } });
  vi.mocked(s.io.triage!).mockImplementationOnce(async (item, signal) => {
    triageSignal = signal; await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })); return { id: item.id, state: 'needed', reason: '需要处理' };
  });
  s.advance(61_000); await s.service.tick(); await vi.waitFor(() => expect(triageSignal).toBeDefined());
  await s.service.stopAnalysis({ id: 'queued', revision: job.revision }, 'ou_owner');
  expect(analysisSignal.aborted).toBe(false); expect(triageSignal.aborted).toBe(false);
  await s.service.stopAnalysis({ id: job.id, revision: job.revision }, 'ou_owner');
  expect(analysisSignal.aborted).toBe(true); expect(triageSignal.aborted).toBe(false);
});

it('does not discard an already completed result for a late stop command', async () => {
  const s = await setup(); await s.service.tick(); await vi.waitFor(() => expect(s.service.list()[0]?.state).toBe('ready'));
  const job = s.service.list()[0]!;
  await expect(s.service.stopAnalysis({ id: job.id, revision: job.revision }, 'ou_owner')).rejects.toThrow('没有正在');
  expect(s.service.list()[0]).toEqual(job);
});

it('announces once before Flash runs, persists its topic and replies there with a draft even with GUI enabled', async () => {
  const s = await setup();
  await s.service.tick(); await vi.waitFor(() => expect(s.service.list()[0]?.state).toBe('ready'));
  expect(s.io.beginAnalysis).toHaveBeenCalledTimes(1);
  expect(vi.mocked(s.io.beginAnalysis!).mock.calls[0]![1]).toContain('已开始分析');
  expect(vi.mocked(s.io.beginAnalysis!).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(s.io.analyze).mock.invocationCallOrder[0]!);
  expect(vi.mocked(s.io.analyze).mock.calls[0]![0].analysisTarget).toEqual(topic);
  expect(s.io.notifyAttention).not.toHaveBeenCalled();
  const saved = new InboxStore(s.store.path); await saved.load(); expect(saved.data.jobs[0]?.analysisTarget).toEqual(topic);
  await s.service.tick(); await s.service.tick();
  expect(s.io.deliver).toHaveBeenCalledTimes(1);
  expect(vi.mocked(s.io.deliver).mock.calls[0]![0]).toMatchObject({ analysisTarget: topic, replyDraft: '已确认，请按这个方案继续。' });
  expect(s.service.list()[0]).toMatchObject({ state: 'done', handlingState: 'open' });
  expect(s.io.analyze).toHaveBeenCalledTimes(1);
});

it('persists an idempotent announcement before sending and never analyzes when creation fails', async () => {
  const beginAnalysis = vi.fn<NonNullable<InboxIO['beginAnalysis']>>().mockRejectedValueOnce(Error('lost response')).mockResolvedValue(topic);
  const s = await setup({ beginAnalysis });
  await s.service.tick(); await vi.waitFor(() => expect(s.service.list()[0]?.state).toBe('queued'));
  expect(s.io.analyze).not.toHaveBeenCalled();
  const first = s.service.list()[0]!.startDelivery!;
  const saved = new InboxStore(s.store.path); await saved.load(); expect(saved.data.jobs[0]?.startDelivery).toEqual(first);
  await s.service.tick(); expect(beginAnalysis).toHaveBeenCalledTimes(1);
  s.advance(60_000); await s.service.tick(); await vi.waitFor(() => expect(s.service.list()[0]?.state).toBe('ready'));
  expect(beginAnalysis.mock.calls[1]![0].startDelivery?.id).toBe(first.id);
  expect(beginAnalysis.mock.calls[1]![1]).toBe(beginAnalysis.mock.calls[0]![1]);
  expect(s.io.analyze).toHaveBeenCalledTimes(1);
});

it.each([new InboxAnalysisError('rate_limit'), Error('provider failed with private diagnostic')])(
  'persists and delivers a safe analysis failure reason (%s)', async error => {
    const s = await setup({ analyze: vi.fn(async () => { throw error; }) });
    await s.service.tick(); await vi.waitFor(() => expect(s.service.list()[0]?.state).toBe('failed'));
    const expected = error instanceof InboxAnalysisError ? error.message : '分析执行失败，详情已记录；请在工作台重试';
    const saved = new InboxStore(s.store.path); await saved.load();
    expect(saved.data.jobs[0]?.error).toBe(expected);
    await s.service.tick();
    expect(s.io.deliver).toHaveBeenCalledTimes(1);
    expect(vi.mocked(s.io.deliver).mock.calls[0]![0]).toMatchObject({ error: expected, analysisTarget: topic });
  });

it('only processes confirmed needed items, leaving quiet and uncertain items out of the agent queue', async () => {
  const messages = [message, { ...message, id: 'om_quiet', containerId: 'oc_quiet' },
    { ...message, id: 'om_uncertain', containerId: 'oc_uncertain' }];
  const s = await setup({ collect: vi.fn(async kind => kind === 'p2p' ? messages : []), context: vi.fn(async () => []),
    triage: vi.fn<NonNullable<InboxIO['triage']>>(async j => ({ id: j.id,
      state: j.sourceRef.containerId === 'oc_quiet' ? 'quiet' : j.sourceRef.containerId === 'oc_uncertain' ? 'uncertain' : 'needed', reason: '根据当前事实判断' })) });
  await s.service.tick(); await vi.waitFor(() => expect(s.service.list().find(j => j.sourceRef.containerId === 'oc_source')?.state).toBe('ready'));
  await s.service.tick();
  expect(s.io.beginAnalysis).toHaveBeenCalledTimes(1); expect(s.io.analyze).toHaveBeenCalledTimes(1);
  expect(s.service.list().filter(j => j.state === 'waiting')).toHaveLength(2);
});

it('reuses the existing item topic when explicitly reprocessing a finished draft', async () => {
  const s = await setup(); await s.service.tick(); await vi.waitFor(() => expect(s.service.list()[0]?.state).toBe('ready'));
  await s.service.tick(); const job = s.service.list()[0]!;
  await s.service.decide(job.id, 'process', 'ou_owner'); await s.service.tick();
  await vi.waitFor(() => expect(s.io.analyze).toHaveBeenCalledTimes(2));
  expect(vi.mocked(s.io.beginAnalysis!).mock.calls[1]![0].analysisTarget).toEqual(topic);
  expect(vi.mocked(s.io.beginAnalysis!).mock.calls[1]![0].startDelivery?.id).not.toBe(job.startDelivery?.id);
});

it('bounds unknown delivery retries without rerunning analysis or creating another topic', async () => {
  const s = await setup({ deliver: vi.fn(async () => { throw Error('lost reply'); }) });
  await s.service.tick(); await vi.waitFor(() => expect(s.service.list()[0]?.state).toBe('ready'));
  for (let i = 0; i < 5; i++) { await s.service.tick(); s.advance(60_000); }
  expect(s.io.deliver).toHaveBeenCalledTimes(3); expect(s.io.analyze).toHaveBeenCalledTimes(1); expect(s.io.beginAnalysis).toHaveBeenCalledTimes(1);
  expect(s.service.list()[0]?.deliveredAt).toBeUndefined();
  expect(s.service.list()[0]?.error).toContain('投递未确认');
});

it.each(['off', 'handled'] as const)('keeps the topic but drops obsolete work when %s happens during creation', async action => {
  let finish!: (value: typeof topic) => void;
  const s = await setup({ beginAnalysis: vi.fn(() => new Promise<typeof topic>(resolve => { finish = resolve; })) });
  await s.service.tick(); await vi.waitFor(() => expect(finish).toBeDefined());
  const job = s.service.list()[0]!;
  if (action === 'off') await s.service.setMode('off');
  if (action === 'handled') await s.service.review({ id: job.id, revision: job.revision, handlingState: 'handled' }, 'ou_owner', 'handle');
  finish(topic); await vi.waitFor(() => expect(s.service.list()[0]?.analysisTarget).toEqual(topic));
  expect(s.io.analyze).not.toHaveBeenCalled(); expect(s.io.deliver).not.toHaveBeenCalled();
});

it('recovers a ready result after restart without creating a topic or running Flash again', async () => {
  const s = await setup(); await s.service.tick(); await vi.waitFor(() => expect(s.service.list()[0]?.state).toBe('ready'));
  await s.service.close();
  const restarted = new InboxService(new InboxStore(s.store.path), config(), s.io, () => 1_061_000); services.push(restarted); await restarted.start();
  await restarted.tick(); expect(s.io.beginAnalysis).toHaveBeenCalledTimes(1); expect(s.io.analyze).toHaveBeenCalledTimes(1); expect(s.io.deliver).toHaveBeenCalledTimes(1);
});

it('Lark creates a bot topic then uses its verified anchor for the result, without source-chat writes or mentions', async () => {
  const s = await setup(); const job = s.service.list()[0]!;
  const exec = vi.fn(async (args: string[]) => ({ code: 0, timedOut: false, stderr: '', stdout: JSON.stringify({ ok: true, data:
    args.includes('get') ? { chat_mode: 'topic' } : args.includes('+messages-send') ? { message_id: 'om_item' } :
      args.includes('+messages-mget') ? { messages: [{ message_id: 'om_item', chat_id: 'oc_target', thread_id: 'omt_item', create_time: '1000000', content: '', sender: { sender_type: 'app' } }] } : {} }) }));
  const lark = new InboxLark({ profile: 'codex' }, config(), exec);
  job.startDelivery = { id: 'notice', text: '已开始分析', attempts: 1, startedAt: 1, retryAt: 1 };
  job.analysisTarget = await lark.beginAnalysis(job, '已开始分析');
  expect(job.analysisTarget).toEqual(topic);
  job.replyDraft = '<at user_id="ou_someone">同事</at>，方案已核实。'; job.analysis = '已核对';
  await lark.deliver(job, 'result');
  const sends = exec.mock.calls.map(c => c[0]).filter(a => a.includes('+messages-send') || a.includes('+messages-reply'));
  expect(sends).toHaveLength(2); expect(sends[0]).toContain('--chat-id'); expect(sends[0]).toContain('oc_target');
  expect(sends[1]).toContain('--reply-in-thread'); expect(sends[1]).toContain('om_item'); expect(sends[1]).not.toContain('om_menu');
  for (const args of sends) { expect(args).toContain('bot'); expect(args).not.toContain('oc_source'); }
  expect(sends[0]).toContain('--text'); expect(sends[1]).toEqual(expect.arrayContaining(['--msg-type', 'post']));
  const content = sends[1]![sends[1]!.indexOf('--content') + 1]!;
  expect(JSON.parse(content).zh_cn.content[0][0]).toEqual({ tag: 'md', text: '**回复草稿（供你确认后发送）**\n\n同事，方案已核实。' });
  expect(content).not.toContain('<at');
  job.analysisTarget.containerId = 'oc_source'; await expect(lark.deliver(job, 'result')).rejects.toThrow('目标已变更');
});

it.each([false, true])('runs a fresh Flash agent with final structured output (repair=%s)', async repair => {
  const s = await setup(); const job = s.service.list()[0]!;
  const events: AgentEvent[] = [{ type: 'thinking', delta: 'private' }, { type: 'text', delta: 'provisional' },
    { type: 'final_text', content: repair ? result.text.replace(/"(replyDraft|analysis|missingInfo)":/g, '$1:') : result.text }, { type: 'usage', inputTokens: 10, outputTokens: 20 }, { type: 'done', terminationReason: 'normal' }];
  const run = { capabilities: executionCapabilities, runId: 'test', events: (async function* () { yield* events; })(), stop: vi.fn(async () => {}), waitForExit: vi.fn(async () => true) };
  const agent: AgentAdapter = { capabilities: executionCapabilities, id: 'contract-backend', displayName: 'Codex', isAvailable: vi.fn(async () => true), prepareRun: vi.fn(async () => preparedRun({}, () => run)) };
  const workspace = await mkdtemp(join(tmpdir(), 'inbox-agent-'));
  const onEvent = vi.fn();
  expect(await processInbox(job, agent, workspace, '所属用户背景', new AbortController().signal, undefined, onEvent)).toEqual(result);
  expect(onEvent.mock.calls.map(([event]) => event)).toEqual(events);
  const opts = vi.mocked(agent.prepareRun).mock.calls[0]![0];
  expect(opts).toMatchObject({ model: 'deepseek-flash', reasoningEffort: 'max', cwd: join(workspace, 'inbox', job.id) });
  expect(opts.threadId).toBeUndefined(); expect(opts.sessionId).toBeUndefined();
  expect(opts.prompt).toContain('不要向任何人发消息'); expect(opts.prompt).toContain('replyDraft');
  expect(run.stop).not.toHaveBeenCalled();
});

it('cancels the processing agent and rejects late final output', async () => {
  const s = await setup(); const controller = new AbortController();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const run = { capabilities: executionCapabilities, runId: 'test', events: (async function* (): AsyncGenerator<AgentEvent> { await gate; yield { type: 'final_text', content: result.text }; })(),
    stop: vi.fn(async () => { release(); }), waitForExit: vi.fn(async () => true) };
  const agent: AgentAdapter = { capabilities: executionCapabilities, id: 'contract-backend', displayName: 'Codex', isAvailable: async () => true, prepareRun: vi.fn(async () => preparedRun({}, () => run)) };
  const onEvent = vi.fn();
  const promise = processInbox(s.service.list()[0]!, agent, await mkdtemp(join(tmpdir(), 'inbox-abort-')), '', controller.signal, undefined, onEvent);
  const rejected = expect(promise).rejects.toThrow();
  await vi.waitFor(() => expect(agent.prepareRun).toHaveBeenCalled()); controller.abort(); await rejected;
  expect(run.stop).toHaveBeenCalledTimes(1);
  expect(onEvent).not.toHaveBeenCalled();
});
