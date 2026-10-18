import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { normalizeInbox } from '../../../src/inbox/config';
import { parseMessages } from '../../../src/inbox/lark';
import { InboxService } from '../../../src/inbox/service';
import { InboxStore } from '../../../src/inbox/store';
import type { InboxIO, InboxJob, InboxMessage } from '../../../src/inbox/types';

const destination = { chatId: 'oc_result', threadId: 'omt_menu', replyTo: 'om_menu' };
const config = () => normalizeInbox({ enabled: true, ownerOpenId: 'ou_owner', executorProfile: 'codex', intakeScope: 'all', destination });
const human: InboxMessage = { id: 'om_human', chatId: 'oc_source', chatName: '项目群', chatType: 'group',
  senderId: 'ou_colleague', senderName: '同事', bot: false, time: 1_000_000, text: '请确认这个问题', mentions: [] };
const self: InboxMessage = { ...human, id: 'om_self', senderId: 'cli_self', bot: true, text: '已开始分析，请确认重启' };
const job = (id: string, messages: InboxMessage[], extras: Partial<InboxJob> = {}): InboxJob => ({ id, messages, ownerOpenId: 'ou_owner', profile: 'codex', destination,
  source: { chatId: messages[0]!.chatId, name: '项目群', type: 'group' }, automatic: true, alert: true, state: 'queued', analysisRequested: true,
  createdAt: 900_000, updatedAt: 900_000, revision: 1, attention: { state: 'needed', reason: '旧版误判', retry: { attempts: 6, nextAt: 0, error: '重试' } },
  startDelivery: { id: 'old-start', text: '旧通知', attempts: 1, startedAt: 0, retryAt: 0 }, resultDelivery: { attempts: 1, startedAt: 0, retryAt: 0 }, ...extras });
const services: InboxService[] = [];
afterEach(async () => { await Promise.all(services.splice(0).map(s => s.close())); });
async function setup(jobs: InboxJob[] = [], overrides: Partial<InboxIO> = {}) {
  let now = 1_000_000;
  const io: InboxIO = { selfSenderIds: ['cli_self', 'ou_self'], checkOwner: vi.fn(async () => {}), collect: vi.fn(async () => []), context: vi.fn(async () => []),
    source: vi.fn(async () => ({ name: '项目群', type: 'group' as const })), deliver: vi.fn(async () => {}), beginAnalysis: vi.fn(async () => destination),
    analyze: vi.fn(async () => ({ text: '{"replyDraft":"草稿","analysis":"已核实","missingInfo":""}', inputTokens: 1, outputTokens: 1 })),
    triage: vi.fn<NonNullable<InboxIO['triage']>>(async jobs => jobs.map(j => ({ id: j.id, state: 'needed', reason: '同事需要回复' }))), ...overrides };
  const store = new InboxStore(join(await mkdtemp(join(tmpdir(), 'inbox-feedback-')), 'state.json'));
  store.data.jobs = jobs;
  if (jobs.length) store.data.notificationOutbox = { id: 'digest', jobs: jobs.map(j => ({ id: j.id, signature: 'old' })), attempts: 1, retryAt: 0 };
  await store.save();
  const service = new InboxService(store, config(), io, () => now); services.push(service); await service.start();
  return { service, store, io, advance: (ms: number) => { now += ms; } };
}

it('preserves app and open-bot identities from real Lark sender shapes', () => {
  const parsed = parseMessages([{ message_id: 'om_self', chat_id: 'oc_source', create_time: '1000', content: '我的输出',
    sender: { id: 'cli_self', id_type: 'app_id', open_bot_id: 'ou_self', sender_type: 'app' } }]);
  expect(parsed[0]).toMatchObject({ senderId: 'cli_self', senderOpenId: 'ou_self', bot: true });
});

it('drops self IDs and result-group messages before ingestion while retaining external bot alerts', async () => {
  const external = { ...self, id: 'om_alert', senderId: 'cli_alert', text: '告警：磁盘异常' };
  const messages = [self, { ...self, id: 'om_open', senderId: 'ou_self', bot: false },
    { ...self, id: 'om_alias', senderId: 'cli_alias', senderOpenId: 'ou_self' },
    { ...human, id: 'om_result', chatId: destination.chatId }, external];
  const s = await setup([], { collect: vi.fn(async kind => kind === 'group' ? messages : []) });
  await s.service.tick();
  expect(s.service.list().flatMap(j => j.messages.map(m => m.id))).toEqual(['om_alert']);
  s.advance(61_000); await s.service.tick(); await vi.waitFor(() => expect(s.io.triage).toHaveBeenCalledTimes(1));
  expect(vi.mocked(s.io.triage!).mock.calls[0]![0][0]!.messages).toEqual([external]);
});

it('quarantines restored self-only queues, results and delivery retries, including previous result groups', async () => {
  const jobs = ['queued', 'ready', 'failed', 'waiting'].map((state, i) => job(`self-${i}`, [self], { state: state as InboxJob['state'], analysisTopic: destination }));
  jobs.push(job('old-result', [{ ...human, chatId: 'oc_previous' }], { destination: { ...destination, chatId: 'oc_previous' } }));
  const s = await setup(jobs); await s.service.tick();
  for (const j of s.service.list()) {
    expect(j).toMatchObject({ state: 'ignored', handlingState: 'ignored', attention: { state: 'quiet' }, analysisRequested: false });
    expect(j.attention?.retry).toBeUndefined(); expect(j.startDelivery).toBeUndefined(); expect(j.resultDelivery).toBeUndefined();
    await expect(s.service.review({ id: j.id, revision: j.revision, handlingState: 'open' }, 'ou_owner', 'reopen')).rejects.toThrow('不可恢复');
  }
  expect(s.store.data.notificationOutbox).toBeUndefined();
  expect(s.io.triage).not.toHaveBeenCalled(); expect(s.io.beginAnalysis).not.toHaveBeenCalled(); expect(s.io.analyze).not.toHaveBeenCalled(); expect(s.io.deliver).not.toHaveBeenCalled();
  const restored = new InboxStore(s.store.path); await restored.load(); expect(restored.data.jobs.every(j => j.state === 'ignored')).toBe(true);
});

it('rescreens mixed historical jobs without self output and keeps edited drafts stale until reviewed', async () => {
  const s = await setup([job('mixed', [human, self], { replyDraft: '人工草稿', draftEdited: true })]);
  expect(s.service.list()[0]).toMatchObject({ state: 'waiting', messages: [human], attention: { state: 'pending' }, replyDraft: '人工草稿', draftStale: true });
  expect(s.service.list()[0]?.evidenceVersion).toBe(2);
  s.advance(61_000); await s.service.tick(); await vi.waitFor(() => expect(s.io.triage).toHaveBeenCalledTimes(1));
  expect(vi.mocked(s.io.triage!).mock.calls[0]![0][0]!.messages).toEqual([human]);
  await s.service.tick(); expect(s.io.analyze).not.toHaveBeenCalled();
});

it('filters self output from refreshed analysis context and never lets it invalidate a real human request', async () => {
  const s = await setup([], { collect: vi.fn(async kind => kind === 'group' ? [human] : []), context: vi.fn(async () => [human, self]) });
  await s.service.tick(); await vi.waitFor(() => expect(s.service.list()[0]?.state).toBe('queued'));
  await s.service.tick(); await vi.waitFor(() => expect(s.io.analyze).toHaveBeenCalledTimes(1));
  expect(vi.mocked(s.io.analyze).mock.calls[0]![0].messages).toEqual([human]);
  await vi.waitFor(() => expect(s.service.list()[0]?.state).toBe('ready'));
  await s.service.tick(); expect(s.io.deliver).toHaveBeenCalledTimes(1);
  s.advance(61_000); await s.service.tick(); expect(s.io.analyze).toHaveBeenCalledTimes(1);
});

it('blocks manual result-group selection and self-only context, while allowing a genuine mixed conversation', async () => {
  const s = await setup([], { context: vi.fn(async () => [self]) });
  await expect(s.service.manual(destination.chatId)).rejects.toThrow('结果群');
  await expect(s.service.manual(human.chatId)).rejects.toThrow('非助理消息');
  vi.mocked(s.io.context).mockResolvedValue([human, self]);
  const submitted = await s.service.manual(human.chatId); expect(submitted.messages).toEqual([human]);
});
