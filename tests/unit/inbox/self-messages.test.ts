import { createHash } from 'node:crypto';
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
const human: InboxMessage = { id: 'om_human', chatId: 'oc_source', chatName: '项目群', chatType: 'group',
  senderId: 'ou_colleague', senderName: '同事', bot: false, time: 1_000_000, text: '请确认这个问题', mentions: [] };
const self: InboxMessage = { ...human, id: 'om_self', senderId: 'cli_self', bot: true, text: '正在处理，请确认' };
const job = (id: string, messages: InboxMessage[], extra: Partial<InboxJob> = {}): InboxJob => ({
  id, ownerOpenId: 'ou_owner', profile: 'codex', destination, source: { chatId: human.chatId, name: human.chatName, type: 'group' },
  messages, state: 'waiting', handlingState: 'open', createdAt: human.time, updatedAt: human.time, revision: 0,
  automatic: true, alert: true, attention: { state: 'pending', reason: '旧失败', retry: { attempts: 11, nextAt: 0, error: '旧失败' } }, ...extra,
});
const services: InboxService[] = [];
afterEach(async () => { for (const service of services.splice(0)) await service.close(); });
async function setup(jobs: InboxJob[] = [], overrides: Partial<InboxIO> = {}) {
  let now = human.time;
  const io: InboxIO = { selfSenderIds: ['cli_self', 'ou_self'], checkOwner: vi.fn(async () => {}), collect: vi.fn(async () => []),
    context: vi.fn(async () => []), source: vi.fn(async () => ({ name: human.chatName, type: 'group' as const })),
    deliver: vi.fn(async () => {}), notifyAttention: vi.fn(async () => {}),
    analyze: vi.fn(async () => ({ text: '分析结果', inputTokens: 1, outputTokens: 1 })),
    triage: vi.fn(async (jobs: InboxJob[]) => jobs.map(j => ({ id: j.id, state: 'quiet' as const, reason: '无需动作' }))), ...overrides };
  const store = new InboxStore(join(await mkdtemp(join(tmpdir(), 'inbox-self-')), 'state.json'));
  store.data.jobs = structuredClone(jobs);
  if (jobs.length) store.data.notificationOutbox = { id: 'old-outbox', attempts: 0, retryAt: 0,
    jobs: jobs.map(j => ({ id: j.id, signature: createHash('sha256').update(JSON.stringify(j.messages)).digest('hex') })) };
  await store.save();
  const service = new InboxService(store, normalizeInbox({ enabled: true, executorProfile: 'codex', ownerOpenId: 'ou_owner', intakeScope: 'all', destination }), io, () => now);
  services.push(service); await service.start();
  return { io, store, service, advance: (ms: number) => { now += ms; } };
}

it('retains both trusted sender identity forms from the Lark response', () => {
  const parsed = parseMessages([{ message_id: 'om_self', chat_id: 'oc_source', create_time: '1000', content: '我的输出',
    sender: { id: 'cli_self', id_type: 'app_id', open_bot_id: 'ou_self', sender_type: 'app' } }]);
  expect(parsed[0]).toMatchObject({ senderId: 'cli_self', senderOpenId: 'ou_self', bot: true });
});

it('drops self identities at ingestion without suppressing humans, matching display names or other bots', async () => {
  const external = { ...self, id: 'om_alert', senderId: 'cli_alert', chatId: 'oc_alert', mentions: ['ou_self'] };
  const messages = [self, { ...self, id: 'om_open', senderId: 'ou_self', bot: false },
    { ...self, id: 'om_alias', senderId: 'cli_alias', senderOpenId: 'ou_self' }, human, external];
  const s = await setup([], { collect: vi.fn(async kind => kind === 'group' ? messages : []) });
  await s.service.tick();
  expect(s.service.list().flatMap(j => j.messages.map(m => m.id)).sort()).toEqual(['om_alert', 'om_human']);
  expect(s.store.data.seen.om_self).toBeUndefined();
  s.advance(61_000); await s.service.tick(); await vi.waitFor(() => expect(s.io.triage).toHaveBeenCalledTimes(1));
  expect(vi.mocked(s.io.triage!).mock.calls[0]![0].flatMap(j => j.messages.map(m => m.id)).sort()).toEqual(['om_alert', 'om_human']);
});

it('cancels persisted self-only screening, analysis and delivery without any model calls', async () => {
  const jobs = (['queued', 'running', 'ready', 'failed', 'waiting', 'ignored'] as const).map((state, i) =>
    job(`self-${i}`, [self], { state, analysisRequested: true, retryAt: 1 }));
  const s = await setup(jobs); await s.service.tick();
  for (const j of s.service.list()) {
    expect(j).toMatchObject({ state: 'ignored', handlingState: 'ignored', attention: { state: 'quiet' }, analysisRequested: false });
    expect(j.attention?.retry).toBeUndefined(); expect(j.retryAt).toBeUndefined();
    await expect(s.service.review({ id: j.id, revision: j.revision, handlingState: 'open' }, 'ou_owner', `restore-${j.id}`)).rejects.toThrow('不可恢复');
  }
  const revisions = s.store.data.jobs.map(j => j.revision); await s.service.tick();
  expect(s.store.data.jobs.map(j => j.revision)).toEqual(revisions);
  expect(s.store.data.notificationOutbox).toBeUndefined();
  expect(s.io.triage).not.toHaveBeenCalled(); expect(s.io.analyze).not.toHaveBeenCalled();
  expect(s.io.deliver).not.toHaveBeenCalled(); expect(s.io.notifyAttention).not.toHaveBeenCalled();
  const restored = new InboxStore(s.store.path); await restored.load();
  expect(restored.data.jobs.every(j => j.state === 'ignored')).toBe(true);
});

it('preserves real requests in mixed history and invalidates old assistant-derived drafts', async () => {
  const s = await setup([job('mixed', [human, self], { replyDraft: '人工草稿', draftEdited: true, state: 'queued', analysisRequested: true })]);
  expect(s.service.list()[0]).toMatchObject({ state: 'waiting', messages: [human], attention: { state: 'pending' },
    replyDraft: '人工草稿', draftStale: true, analysisRequested: false });
  s.advance(61_000); await s.service.tick(); await vi.waitFor(() => expect(s.io.triage).toHaveBeenCalledTimes(1));
  expect(vi.mocked(s.io.triage!).mock.calls[0]![0][0]!.messages).toEqual([human]);
  expect(s.io.analyze).not.toHaveBeenCalled();
});

it('does not let new self output reset a completed human screening decision', async () => {
  const original = job('human', [human], { attention: { state: 'quiet', reason: '已处理' } });
  const s = await setup([original], { context: vi.fn(async () => [human, self]) });
  s.advance(61_000); await s.service.tick();
  expect(s.service.list()[0]).toMatchObject({ messages: [human], attention: original.attention, revision: 0 });
  expect(s.io.triage).not.toHaveBeenCalled();
});

it('filters manual selection and refreshed analysis context, and blocks self-only manual replay', async () => {
  const s = await setup([], { context: vi.fn(async () => [self]) });
  await expect(s.service.manual(human.chatId)).rejects.toThrow('非助理消息');
  vi.mocked(s.io.context).mockResolvedValue([human, self]);
  const submitted = await s.service.manual(human.chatId); expect(submitted.messages).toEqual([human]);
  await s.service.tick(); await vi.waitFor(() => expect(s.io.analyze).toHaveBeenCalledTimes(1));
  expect(vi.mocked(s.io.analyze).mock.calls[0]![0].messages).toEqual([human]);
  const replay = await setup([job('old-manual', [self], { manualRequestId: 'old-request' })]);
  await expect(replay.service.manual(human.chatId, 'old-request')).rejects.toThrow('不可处理');
});
