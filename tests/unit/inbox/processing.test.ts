import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { AgentAdapter, AgentEvent } from '../../../src/agent/types';
import { normalizeInbox } from '../../../src/inbox/config';
import { InboxLark } from '../../../src/inbox/lark';
import { processInbox } from '../../../src/inbox/processor';
import { InboxService } from '../../../src/inbox/service';
import { InboxStore } from '../../../src/inbox/store';
import type { InboxIO, InboxJob, InboxMessage } from '../../../src/inbox/types';

const topic = { chatId: 'oc_target', threadId: 'omt_item', replyTo: 'om_item' };
const config = () => normalizeInbox({ enabled: true, executorProfile: 'codex', ownerOpenId: 'ou_owner', deliveryMode: 'new_topic',
  destination: { chatId: 'oc_target', threadId: 'omt_menu', replyTo: 'om_menu' }, gui: { publicUrl: 'https://gui.example', apiKeyFile: '/key' } });
const message: InboxMessage = { id: 'om_source', chatId: 'oc_source', chatName: '项目群', chatType: 'p2p', senderId: 'ou_sender',
  senderName: '同事', bot: false, time: 1_000_000, text: '请确认这个问题并回复', mentions: [] };
const result = { text: JSON.stringify({ replyDraft: '已确认，请按这个方案继续。', analysis: '已核对相关记录。', missingInfo: '' }), inputTokens: 10, outputTokens: 20 };
const services: InboxService[] = [];
afterEach(async () => { await Promise.all(services.splice(0).map(s => s.close())); });

async function setup(overrides: Partial<InboxIO> = {}) {
  let now = 1_000_000;
  const io: InboxIO = { checkOwner: vi.fn(async () => {}), collect: vi.fn(async kind => kind === 'p2p' ? [message] : []),
    context: vi.fn(async () => [message]), source: vi.fn(async () => ({ name: '项目群', type: 'p2p' as const })),
    beginAnalysis: vi.fn(async () => topic), deliver: vi.fn(async () => {}), analyze: vi.fn(async () => result),
    notifyAttention: vi.fn(async () => {}), triage: vi.fn<NonNullable<InboxIO['triage']>>(async jobs => jobs.map(j => ({ id: j.id, state: 'needed', reason: '需要回复方案' }))), ...overrides };
  const store = new InboxStore(join(await mkdtemp(join(tmpdir(), 'inbox-processing-')), 'state.json'));
  const service = new InboxService(store, config(), io, () => now); services.push(service); await service.start();
  await service.tick(); now += 61_000; await service.tick();
  await vi.waitFor(() => expect(service.list()[0]?.attention?.state).toBe('needed'));
  return { service, store, io, advance: (ms: number) => { now += ms; } };
}

it('announces once before Flash runs, persists its topic and replies there with a draft even with GUI enabled', async () => {
  const s = await setup();
  await s.service.tick(); await vi.waitFor(() => expect(s.service.list()[0]?.state).toBe('ready'));
  expect(s.io.beginAnalysis).toHaveBeenCalledTimes(1);
  expect(vi.mocked(s.io.beginAnalysis!).mock.calls[0]![1]).toContain('已开始分析');
  expect(vi.mocked(s.io.beginAnalysis!).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(s.io.analyze).mock.invocationCallOrder[0]!);
  expect(vi.mocked(s.io.analyze).mock.calls[0]![0].analysisTopic).toEqual(topic);
  expect(s.io.notifyAttention).not.toHaveBeenCalled();
  const saved = new InboxStore(s.store.path); await saved.load(); expect(saved.data.jobs[0]?.analysisTopic).toEqual(topic);
  await s.service.tick(); await s.service.tick();
  expect(s.io.deliver).toHaveBeenCalledTimes(1);
  expect(vi.mocked(s.io.deliver).mock.calls[0]![0]).toMatchObject({ analysisTopic: topic, replyDraft: '已确认，请按这个方案继续。' });
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

it('only processes confirmed needed items, leaving quiet and uncertain items out of the agent queue', async () => {
  const messages = [message, { ...message, id: 'om_quiet', chatId: 'oc_quiet' }, { ...message, id: 'om_uncertain', chatId: 'oc_uncertain' }];
  const s = await setup({ collect: vi.fn(async kind => kind === 'p2p' ? messages : []), context: vi.fn(async () => []),
    triage: vi.fn<NonNullable<InboxIO['triage']>>(async jobs => jobs.map(j => ({ id: j.id,
      state: j.source.chatId === 'oc_quiet' ? 'quiet' : j.source.chatId === 'oc_uncertain' ? 'uncertain' : 'needed', reason: '根据当前事实判断' }))) });
  await s.service.tick(); await vi.waitFor(() => expect(s.service.list().find(j => j.source.chatId === 'oc_source')?.state).toBe('ready'));
  await s.service.tick();
  expect(s.io.beginAnalysis).toHaveBeenCalledTimes(1); expect(s.io.analyze).toHaveBeenCalledTimes(1);
  expect(s.service.list().filter(j => j.state === 'waiting')).toHaveLength(2);
});

it('reuses the existing item topic when explicitly reprocessing a finished draft', async () => {
  const s = await setup(); await s.service.tick(); await vi.waitFor(() => expect(s.service.list()[0]?.state).toBe('ready'));
  await s.service.tick(); const job = s.service.list()[0]!;
  await s.service.decide(job.id, 'process', 'ou_owner'); await s.service.tick();
  await vi.waitFor(() => expect(s.io.analyze).toHaveBeenCalledTimes(2));
  expect(vi.mocked(s.io.beginAnalysis!).mock.calls[1]![0].analysisTopic).toEqual(topic);
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

it.each(['off', 'handled', 'new-message'] as const)('keeps the topic but drops obsolete work when %s happens during creation', async action => {
  let finish!: (value: typeof topic) => void;
  const s = await setup({ beginAnalysis: vi.fn(() => new Promise<typeof topic>(resolve => { finish = resolve; })) });
  await s.service.tick(); await vi.waitFor(() => expect(finish).toBeDefined());
  const job = s.service.list()[0]!;
  if (action === 'off') await s.service.setMode('off');
  if (action === 'handled') await s.service.review({ id: job.id, revision: job.revision, handlingState: 'handled' }, 'ou_owner', 'handle');
  if (action === 'new-message') {
    const updated = { ...message, text: '有新信息，先不要沿用旧方案' };
    vi.mocked(s.io.collect).mockResolvedValue([updated]); vi.mocked(s.io.context).mockResolvedValue([updated]);
    s.advance(60_000); await s.service.tick();
  }
  finish(topic); await vi.waitFor(() => expect(s.service.list()[0]?.analysisTopic).toEqual(topic));
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
  job.analysisTopic = await lark.beginAnalysis(job, '已开始分析');
  expect(job.analysisTopic).toEqual(topic);
  job.replyDraft = '<at user_id="ou_someone">同事</at>，方案已核实。'; job.analysis = '已核对';
  await lark.deliver(job, 'result');
  const sends = exec.mock.calls.map(c => c[0]).filter(a => a.includes('+messages-send') || a.includes('+messages-reply'));
  expect(sends).toHaveLength(2); expect(sends[0]).toContain('--chat-id'); expect(sends[0]).toContain('oc_target');
  expect(sends[1]).toContain('--reply-in-thread'); expect(sends[1]).toContain('om_item'); expect(sends[1]).not.toContain('om_menu');
  for (const args of sends) { expect(args).toContain('bot'); expect(args).not.toContain('oc_source'); }
  expect(sends[1]![sends[1]!.indexOf('--text') + 1]).toContain('回复草稿');
  expect(sends[1]![sends[1]!.indexOf('--text') + 1]).not.toContain('<at');
  job.analysisTopic.chatId = 'oc_source'; await expect(lark.deliver(job, 'result')).rejects.toThrow('目标已变更');
});

it('runs a fresh Flash agent in an item workspace, returning only final structured output', async () => {
  const s = await setup(); const job = s.service.list()[0]!;
  const events: AgentEvent[] = [{ type: 'thinking', delta: 'private' }, { type: 'text', delta: 'provisional' },
    { type: 'final_text', content: result.text }, { type: 'usage', inputTokens: 10, outputTokens: 20 }, { type: 'done', terminationReason: 'normal' }];
  const run = { runId: 'test', events: (async function* () { yield* events; })(), stop: vi.fn(async () => {}), waitForExit: vi.fn(async () => true) };
  const agent: AgentAdapter = { id: 'codex', displayName: 'Codex', isAvailable: vi.fn(async () => true), prepareRun: vi.fn(async () => {}), run: vi.fn(() => run) };
  const workspace = await mkdtemp(join(tmpdir(), 'inbox-agent-'));
  expect(await processInbox(job, agent, workspace, '所属用户背景', new AbortController().signal)).toEqual(result);
  const opts = vi.mocked(agent.run).mock.calls[0]![0];
  expect(opts).toMatchObject({ model: 'deepseek-flash', cwd: join(workspace, 'inbox', job.id) });
  expect(opts.threadId).toBeUndefined(); expect(opts.sessionId).toBeUndefined();
  expect(opts.prompt).toContain('不要向任何人发消息'); expect(opts.prompt).toContain('replyDraft');
  expect(run.stop).not.toHaveBeenCalled();
});

it('cancels the processing agent and rejects late final output', async () => {
  const s = await setup(); const controller = new AbortController();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const run = { runId: 'test', events: (async function* (): AsyncGenerator<AgentEvent> { await gate; yield { type: 'final_text', content: result.text }; })(),
    stop: vi.fn(async () => { release(); }), waitForExit: vi.fn(async () => true) };
  const agent: AgentAdapter = { id: 'codex', displayName: 'Codex', isAvailable: async () => true, run: vi.fn(() => run) };
  const promise = processInbox(s.service.list()[0]!, agent, await mkdtemp(join(tmpdir(), 'inbox-abort-')), '', controller.signal);
  const rejected = expect(promise).rejects.toThrow();
  await vi.waitFor(() => expect(agent.run).toHaveBeenCalled()); controller.abort(); await rejected;
  expect(run.stop).toHaveBeenCalledTimes(1);
});
