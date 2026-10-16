import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { CallbackAuth } from '../../../src/card/callback-auth';
import { CallbackNonceStore } from '../../../src/card/callback-store';
import { InboxCards, type InboxCardContext } from '../../../src/inbox/cards';
import { normalizeInbox, validateInbox } from '../../../src/inbox/config';
import { InboxLark } from '../../../src/inbox/lark';
import type { InboxService } from '../../../src/inbox/service';
import type { InboxJob } from '../../../src/inbox/types';

const context: InboxCardContext = { profile: 'codex', operator: 'ou_owner', chatId: 'oc_target', threadId: 'omt_topic' };
const config = () => normalizeInbox({ enabled: true, executorProfile: 'codex', ownerOpenId: 'ou_owner', destination: { chatId: 'oc_target', threadId: 'omt_topic', replyTo: 'om_anchor' } });
const job = { id: 'job1', source: { chatId: 'oc_source', name: '原会话', type: 'p2p' }, state: 'waiting' } as InboxJob;
type Element = { tag: string; text?: { content: string }; behaviors?: { value: { cmd: string; arg?: string } }[] };
function elements(body: { card?: object }): Element[] { return (body.card as { body: { elements: Element[] } }).body.elements; }
function command(element: Element): string {
  const value = element.behaviors![0]!.value;
  return value.cmd.split('.').slice(1).join(' ') + (value.arg ? ` ${value.arg}` : '');
}
async function setup() {
  const path = join(await mkdtemp(join(tmpdir(), 'inbox-cards-')), 'nonces.json');
  let now = 1000;
  const service = { config: config(), manual: vi.fn(async () => job), decide: vi.fn(async () => {}), list: vi.fn(() => [job]), get: vi.fn(() => job) };
  const lark = { replyTopic: vi.fn(async (_body: { card?: object; text?: string }) => {}), replyMenu: vi.fn(async (_card: object, _messageId: string, _threadId: string) => {}), recent: vi.fn(async (_type: string, _page?: string) => ({ chats: [{ id: 'oc_source', name: '<at id=all>name</at>' }], next: 'next1' })) };
  const create = async () => {
    const store = new CallbackNonceStore(path); await store.load();
    return new InboxCards(service as unknown as InboxService, lark as unknown as InboxLark,
      new CallbackAuth({ keys: [{ version: 1, secret: 'fixture-secret' }], nonceStore: store, now: () => now }), store);
  };
  return { cards: await create(), create, service, lark, advance: (ms: number) => { now += ms; } };
}

it('allows a complete configuration with no web URL', () => { expect(() => validateInbox(config())).not.toThrow(); });

it('browses private and group chats without submitting analysis, retaining names and IDs as plain text', async () => {
  const h = await setup(); await h.cards.handle('private', context); await h.cards.handle('groups', context);
  expect(h.lark.recent.mock.calls.map(c => c[0])).toEqual(['p2p', 'group']);
  expect(h.service.manual).not.toHaveBeenCalled(); expect(h.service.decide).not.toHaveBeenCalled();
  const rows = elements(h.lark.replyTopic.mock.calls[0]![0]);
  expect(rows.some(e => e.text?.content.includes('<at id=all>name</at>\n会话 ID：oc_source'))).toBe(true);
  expect(JSON.stringify(rows)).not.toContain('__bridge_cb');
});

it.each([{ operator: 'ou_other' }, { chatId: 'oc_other' }, { threadId: undefined }, { profile: 'claude' }])('rejects another owner, forwarded group or profile: %j', async override => {
  const h = await setup(); await h.cards.handle('private', { ...context, ...override });
  expect(h.lark.replyTopic).not.toHaveBeenCalled(); expect(h.lark.recent).not.toHaveBeenCalled();
});

it('opens and browses in a new topic of the configured group, while submitting results to the fixed topic', async () => {
  const h = await setup(); const from = { ...context, threadId: 'omt_new', messageId: 'om_new' };
  await h.cards.handle('', from);
  expect(h.lark.replyMenu).toHaveBeenLastCalledWith(expect.objectContaining({ schema: '2.0' }), 'om_new', 'omt_new');
  await h.cards.handle('groups', from);
  const menu = h.lark.replyMenu.mock.calls.at(-1)![0];
  const cmd = command(elements({ card: menu }).find(e => e.text?.content === '分析此会话')!);
  await h.cards.handle(cmd, from);
  expect(h.service.manual).toHaveBeenCalledWith('oc_source');
  expect(h.lark.replyTopic).toHaveBeenCalledWith({ text: expect.stringContaining('原会话') });
  expect(h.service.config.destination).toEqual(config().destination);
});

it('validates menu carriers in the configured group before replying to their new topic', async () => {
  let chatId = 'oc_other';
  const exec = vi.fn(async (_args: string[]) => ({ code: 0, timedOut: false, stderr: '', stdout: JSON.stringify({ ok: true, data: {
    messages: [{ message_id: 'om_new', chat_id: chatId, thread_id: 'omt_new', create_time: '2026-10-14 20:00' }] } }) }));
  const lark = new InboxLark({ profile: 'codex' }, config(), exec);
  await expect(lark.replyMenu({}, 'om_new', 'omt_new')).rejects.toThrow('无法验证');
  expect(exec).toHaveBeenCalledTimes(1);
  chatId = 'oc_target';
  await lark.replyMenu({ schema: '2.0' }, 'om_new', 'omt_new');
  expect(exec.mock.calls.at(-1)![0]).toContain('om_new');
  expect(exec.mock.calls.at(-1)![0]).toContain('--reply-in-thread');
});

it('binds signed choices to their source and configuration; repeated clicks survive restart without another submission', async () => {
  const h = await setup(); await h.cards.handle('private', context);
  const cmd = command(elements(h.lark.replyTopic.mock.calls[0]![0]).find(e => e.text?.content === '分析此会话')!);
  await expect(h.cards.handle(cmd.replace(Buffer.from('oc_source').toString('base64url'), Buffer.from('oc_other').toString('base64url')), context)).rejects.toThrow('失效');
  h.service.config.waitMinutes++;
  await expect(h.cards.handle(cmd, context)).rejects.toThrow('失效'); h.service.config.waitMinutes--;
  await h.cards.handle(cmd, context); expect(h.service.manual).toHaveBeenCalledWith('oc_source');
  await expect((await h.create()).handle(cmd, context)).rejects.toThrow('已经处理');
  expect(h.service.manual).toHaveBeenCalledTimes(1);
});

it('expires selection cards and preserves unused reminder actions across restart', async () => {
  const h = await setup(); await h.cards.handle('private', context);
  const cmd = command(elements(h.lark.replyTopic.mock.calls[0]![0]).find(e => e.text?.content === '分析此会话')!);
  const reminder = h.cards.reminder(job, '提醒');
  h.service.list.mockReturnValue([]);
  h.service.get.mockReturnValue({ ...job, state: 'ignored' });
  h.advance(31 * 60_000); await expect(h.cards.handle(cmd, context)).rejects.toThrow('失效');
  const ignore = command(elements({ card: reminder }).find(e => e.text?.content === '忽略')!);
  await (await h.create()).handle(ignore, context);
  expect(h.service.decide).toHaveBeenCalledWith('job1', 'ignore', 'ou_owner'); expect(h.service.decide).toHaveBeenCalledTimes(1);
  expect(h.service.manual).not.toHaveBeenCalled();
  expect(h.lark.replyTopic).toHaveBeenCalledWith({ text: '待办已更新：原会话\n来源会话 ID：oc_source\n状态：已忽略' });
});

it('carries a signed opaque pagination cursor without model calls', async () => {
  const h = await setup(); await h.cards.handle('groups', context);
  const cmd = command(elements(h.lark.replyTopic.mock.calls[0]![0]).find(e => e.text?.content === '下一页')!);
  await h.cards.handle(cmd, context);
  expect(h.lark.recent).toHaveBeenLastCalledWith('group', 'next1'); expect(h.service.manual).not.toHaveBeenCalled();
});

it('continues across an empty chat-list page and keeps the configured output conversation out of choices', async () => {
  const exec = vi.fn(async (args: string[]) => ({ code: 0, timedOut: false, stderr: '', stdout: JSON.stringify(args[0] === 'auth'
    ? { identities: { user: { openId: 'ou_owner', scope: 'search:message' } } }
    : { ok: true, data: args.includes('--page-token') ? { chats: [{ chat_id: 'oc_target', name: '结果群' }, { chat_id: 'oc_source', name: '来源群' }] }
      : { chats: [], has_more: true, page_token: 'next' } }) }));
  const lark = new InboxLark({ profile: 'codex' }, config(), exec);
  expect(await lark.recent('group')).toEqual({ chats: [], next: 'next' });
  expect(await lark.recent('group', 'next')).toEqual({ chats: [{ id: 'oc_source', name: '来源群' }], next: '' });
});

it('suppresses old pending reminder cards', async () => {
  const exec = vi.fn(async (_args: string[]) => ({ code: 0, timedOut: false, stderr: '', stdout: JSON.stringify({ ok: true, data: {
    messages: [{ message_id: 'om_anchor', chat_id: 'oc_target', thread_id: 'omt_topic', create_time: '2026-10-14 20:00' }] } }) }));
  const lark = new InboxLark({ profile: 'codex' }, config(), exec);
  lark.reminderCard = () => ({ schema: '2.0', body: { elements: [] } });
  await lark.deliver({ ...job, ownerOpenId: 'ou_owner', destination: config().destination,
    messages: [{ time: 1_000_000 }], automatic: true } as InboxJob, 'pending');
  expect(exec).not.toHaveBeenCalled();
});

it('does not turn model or source text into structured mentions', async () => {
  const exec = vi.fn(async (_args: string[]) => ({ code: 0, timedOut: false, stderr: '', stdout: JSON.stringify({ ok: true, data: {
    messages: [{ message_id: 'om_anchor', chat_id: 'oc_target', thread_id: 'omt_topic', create_time: '2026-10-14 20:00' }] } }) }));
  const lark = new InboxLark({ profile: 'codex' }, config(), exec);
  await lark.replyTopic({ text: '<at user_id="all">everyone</at> 建议回复' });
  const args = exec.mock.calls[1]![0]; expect(args[args.indexOf('--text') + 1]).toBe('everyone 建议回复');
});
