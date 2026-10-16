import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeInbox, validateInbox } from '../../../src/inbox/config';
import { InboxStore } from '../../../src/inbox/store';
import { InboxService, boundMessages } from '../../../src/inbox/service';
import { InboxLark, messageTime, parseMessages } from '../../../src/inbox/lark';
import { InboxH5Auth } from '../../../src/inbox/h5-auth';
import { analyzeInbox, analysisBody } from '../../../src/inbox/analyzer';
import { startInboxH5 } from '../../../src/inbox/h5-server';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { createRootConfig, loadRootConfig, saveRootConfig } from '../../../src/config/profile-store';
import type { InboxIO, InboxJob, InboxMessage } from '../../../src/inbox/types';

const config = () => normalizeInbox({ enabled: true, executorProfile: 'codex', ownerOpenId: 'ou_owner',
  destination: { chatId: 'oc_target', threadId: 'omt_topic', replyTo: 'om_anchor' }, waitMinutes: 1 });
const message = (overrides: Partial<InboxMessage> = {}): InboxMessage => ({ id: 'om_source', chatId: 'oc_source', chatName: '源会话', chatType: 'p2p',
  senderId: 'ou_sender', senderName: '发送者', bot: false, time: 1_000_000, text: '请帮我确认发布日期', mentions: [], ...overrides });
const services: InboxService[] = [];
afterEach(async () => { await Promise.all(services.splice(0).map(s => s.close())); });
async function setup(overrides: Partial<InboxIO> = {}) {
  let now = 1_000_000;
  const io: InboxIO = { checkOwner: vi.fn(async () => {}), collect: vi.fn(async kind => kind === 'p2p' ? [message()] : []),
    context: vi.fn(async () => [message()]), source: vi.fn(async () => ({ name: '源会话', type: 'p2p' as const })),
    deliver: vi.fn(async () => {}), analyze: vi.fn(async () => ({ text: '建议回复', inputTokens: 100, outputTokens: 20 })), ...overrides };
  const store = new InboxStore(join(await mkdtemp(join(tmpdir(), 'inbox-test-')), 'state.json'));
  const service = new InboxService(store, config(), io, () => now); services.push(service); await service.start();
  const advance = (ms: number) => { now += ms; };
  return { service, store, io, advance };
}
async function settle(s: InboxService) { for (let i = 0; i < 10; i++) { await new Promise(r => setTimeout(r, 10)); if (!s.list().some(j => j.state === 'running')) return; } }

it.each([
  [{ code: 1, stdout: '', stderr: 'lark-channel context detected but lark-cli is not bound to it', timedOut: false }, '当前 bridge 未绑定'],
  [{ code: null, stdout: '{', stderr: 'private-error-content', timedOut: true }, '飞书读取超时'],
  [{ code: 1, stdout: 'private-invalid-output', stderr: 'private-error-content', timedOut: false }, '飞书读取响应无效'],
])('distinguishes failed CLI reads without exposing raw output', async (result, expected) => {
  const lark = new InboxLark({ profile: 'codex' }, config(), vi.fn(async () => result));
  await expect(lark.callValue(['im', '+chat-messages-list'])).rejects.toThrow(expected);
  lark.close();
});

describe('durable inbox', () => {
  it('never starts deep analysis or pending notifications without a click, even after hours', async () => {
    const { service, io, advance } = await setup(); await service.tick();
    advance(3600_000); await service.tick(); await settle(service);
    expect(service.list()[0]?.state).toBe('waiting'); expect(service.list()[0]?.dueAt).toBeUndefined();
    expect(io.analyze).not.toHaveBeenCalled(); expect(io.deliver).not.toHaveBeenCalled();
  });
  it('keeps unavailable triage pending without posting or running deep analysis', async () => {
    const { service, io, advance } = await setup(); await service.tick(); advance(61_000); await service.tick();
    expect(service.list()[0]?.attention?.state).toBe('pending'); expect(service.list()[0]?.attention?.retry).toBeDefined(); expect(io.deliver).not.toHaveBeenCalled();
    expect(io.analyze).not.toHaveBeenCalled();
  });
  it('deduplicates polls and repeated manual submissions', async () => {
    const { service, io, advance } = await setup(); await service.tick(); advance(61_000); await service.tick();
    expect(service.list()).toHaveLength(1);
    const a = await service.manual('oc_source'); const b = await service.manual('oc_source'); expect(a.id).toBe(b.id);
    await service.tick(); await settle(service); expect(io.analyze).toHaveBeenCalledTimes(1);
  });
  it('extends an empty recent window for a manual selection', async () => {
    const context = vi.fn(async () => [message()]); context.mockResolvedValueOnce([]);
    const { service } = await setup({ context }); const job = await service.manual('oc_source');
    expect(job.messages).toHaveLength(1); expect(context).toHaveBeenCalledTimes(2);
  });
  it('replays GUI submissions without re-reading or creating a second job even after new messages arrive', async () => {
    const { service, io, store, advance } = await setup();
    const first = await service.manual('oc_source', 'request-one');
    await service.manual('oc_source', 'request-two');
    advance(31 * 60_000); store.data.jobs[0]!.state = 'done';
    vi.mocked(io.context).mockResolvedValue([message({ id: 'new' })]); vi.mocked(io.context).mockClear();
    expect((await service.manual('oc_source', 'request-one')).id).toBe(first.id);
    expect((await service.manual('oc_source', 'request-two')).id).toBe(first.id);
    expect(io.context).not.toHaveBeenCalled();
    await expect(service.manual('oc_different', 'request-one')).rejects.toThrow('already used');
    const recovered = new InboxStore(store.path); await recovered.load();
    expect(recovered.data.jobs[0]!.manualRequestIds).toEqual(['request-one', 'request-two']);
  });
  it('deduplicates a large selection even after worker context expansion', async () => {
    const messages = Array.from({ length: 150 }, (_, i) => message({ id: `om_${i}`, time: 1_000_000 + i }));
    const { service, store } = await setup({ context: vi.fn(async () => messages) });
    const first = await service.manual('oc_source');
    store.data.jobs[0]!.state = 'running'; store.data.jobs[0]!.messages.unshift(message({ id: 'om_older', time: 900_000 }));
    const again = await service.manual('oc_source'); expect(again.id).toBe(first.id); expect(service.list()).toHaveLength(1);
  });
  it('rejects decisions from other group members', async () => {
    const { service } = await setup(); await service.tick();
    await expect(service.decide(service.list()[0]!.id, 'process', 'ou_other')).rejects.toThrow('forbidden');
  });
  it('serializes poll/click race and counts one analysis', async () => {
    const { service, io, advance } = await setup(); await service.tick(); advance(61_000); await service.tick(); advance(61_000);
    await Promise.all([service.tick(), service.decide(service.list()[0]!.id, 'process', 'ou_owner')]); await service.tick(); await settle(service);
    expect(io.analyze).toHaveBeenCalledTimes(1);
  });
  it('preserves stored usage across restart without reviving a countdown', async () => {
    const { service, store, advance } = await setup(); await service.tick(); advance(61_000); await service.tick();
    store.data.autoUsage['1970-01-01'] = 20; await store.save(); const resumed = new InboxStore(store.path); await resumed.load();
    expect(resumed.data.jobs[0]?.dueAt).toBeUndefined(); expect(resumed.data.autoUsage['1970-01-01']).toBe(20);
    advance(61_000); await service.tick(); expect(service.list()[0]?.state).toBe('waiting');
  });
  it('does not turn interrupted runs into duplicate model calls', async () => {
    const { store, service } = await setup(); await service.tick(); store.data.jobs[0]!.state = 'running'; await store.save();
    const resumed = new InboxStore(store.path); await resumed.load(); expect(resumed.data.jobs[0]?.state).toBe('failed');
  });
  it('prevents new work after shutdown', async () => {
    const { service, io } = await setup(); await service.close();
    await expect(service.manual('oc_source')).rejects.toThrow('关闭'); await service.tick(); expect(io.collect).not.toHaveBeenCalled();
  });
  it('does not submit after shutdown interrupts a pending collection', async () => {
    let finish!: (messages: InboxMessage[]) => void;
    const { service, io } = await setup({ collect: vi.fn(() => new Promise<InboxMessage[]>(resolve => { finish = resolve; })) });
    const tick = service.tick();
    while (!finish) await new Promise(r => setTimeout(r, 1));
    const closing = service.close(); finish([message()]); await tick; await closing;
    expect(service.list()).toHaveLength(0); expect(io.analyze).not.toHaveBeenCalled();
  });
  it('turns off collection and queued work while preserving results and allowing re-enable', async () => {
    const { service, io, store } = await setup();
    const job = await service.manual('oc_source');
    await service.setMode('off');
    vi.mocked(io.collect).mockClear(); await service.tick();
    expect(io.collect).not.toHaveBeenCalled(); expect(io.analyze).not.toHaveBeenCalled();
    expect(service.list()[0]?.state).toBe('waiting');
    await expect(service.manual('oc_source')).rejects.toThrow('关闭');
    await service.setMode('on'); await service.tick();
    expect(io.analyze).not.toHaveBeenCalled(); // suspended jobs require an explicit click
    await service.decide(job.id, 'process', 'ou_owner'); await service.tick(); await settle(service);
    expect(io.analyze).toHaveBeenCalledTimes(1);
    expect(store.data.jobs[0]?.result).toBe('建议回复');
  });
  it('enabled mode blocks legacy overdue and already queued automatic work, but accepts explicit processing', async () => {
    const { service, io, store, advance } = await setup(); await service.tick();
    store.data.jobs[0]!.state = 'queued';
    await service.setMode('on'); advance(3600_000); await service.tick();
    expect(io.analyze).not.toHaveBeenCalled(); expect(io.collect).toHaveBeenCalled();
    await service.decide(store.data.jobs[0]!.id, 'process', 'ou_owner'); await service.tick(); await settle(service);
    expect(io.analyze).toHaveBeenCalledTimes(1);
  });
  it('never dispatches legacy queued automatic work after a restart', async () => {
    const { service, io, store } = await setup(); await service.tick();
    store.data.jobs[0]!.state = 'queued'; service.config.autoAnalyze = false;
    await service.tick(); expect(io.analyze).not.toHaveBeenCalled();
  });
  it('off gates a collection already in flight, before it can queue or analyze messages', async () => {
    let finish!: (messages: InboxMessage[]) => void;
    const { service, io } = await setup({ collect: vi.fn(() => new Promise<InboxMessage[]>(r => { finish = r; })) });
    const tick = service.tick(); await vi.waitFor(() => expect(finish).toBeDefined());
    const off = service.setMode('off'); finish([message()]); await tick; await off;
    expect(service.list()).toHaveLength(0); expect(io.analyze).not.toHaveBeenCalled();
  });
  it('aborts clicked analysis when turned off and discards late output', async () => {
    let finish!: (r: { text: string; inputTokens: number; outputTokens: number }) => void;
    const { service, io, store } = await setup({ analyze: vi.fn(() => new Promise<{ text: string; inputTokens: number; outputTokens: number }>(r => { finish = r; })) });
    await service.manual('oc_source'); await service.tick();
    await vi.waitFor(() => expect(finish).toBeDefined());
    const signal = vi.mocked(io.analyze).mock.calls[0]![1]; await service.setMode('off');
    expect(signal.aborted).toBe(true);
    finish({ text: 'obsolete', inputTokens: 1, outputTokens: 1 }); await settle(service); await service.tick();
    expect(service.list()[0]?.state).toBe('waiting'); expect(service.list()[0]?.result).toBeUndefined();
    expect(vi.mocked(io.deliver).mock.calls.some(c => c[1] === 'result')).toBe(false);
  });
  it('reports persistence failure without claiming a mode change succeeded', async () => {
    const { service } = await setup();
    await expect(service.setMode('on', async () => { throw new Error('disk failure'); })).rejects.toThrow('disk failure');
    expect(service.config.autoAnalyze).toBe(false);
  });
  it('preserves global inbox settings through root serialization', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'inbox-config-')), 'config.json');
    const profile = createDefaultProfileConfig({ agentKind: 'codex', accounts: { app: { id: 'cli_app', secret: 'fixture', tenant: 'feishu' } }, codex: { binaryPath: 'codex' } });
    const root = createRootConfig('codex', profile); root.inbox = config(); await saveRootConfig(root, path);
    const loaded = (await loadRootConfig(path))!; expect(loaded.inbox).toEqual(config());
    loaded.profiles.codex!.preferences.model = 'another'; await saveRootConfig(loaded, path);
    expect((await loadRootConfig(path))?.inbox).toEqual(config());
  });
  it('pauses a private pending task when the owner replies', async () => {
    const { service, io, advance } = await setup(); await service.tick();
    vi.mocked(io.collect).mockResolvedValue([message({ id: 'om_reply', senderId: 'ou_owner', time: 1_001_000 })]);
    advance(61_000); await service.tick(); expect(service.list()[0]?.state).toBe('claimed');
  });
  it('does not cancel a group task because the owner spoke in an unrelated topic', async () => {
    const group = message({ chatType: 'group', threadId: 'omt_source', mentions: ['ou_owner'] });
    const { service, io, advance } = await setup({ collect: vi.fn(async () => [group]), context: vi.fn(async () => [group]) }); await service.tick();
    vi.mocked(io.collect).mockResolvedValue([message({ id: 'om_reply', senderId: 'ou_owner', chatType: 'group', threadId: 'omt_unrelated', time: 1_001_000 })]);
    advance(61_000); await service.tick(); expect(service.list()[0]?.state).toBe('waiting');
  });
  it('filters acknowledgements, own output group, bots in DMs and @all', async () => {
    const { service } = await setup({ collect: vi.fn(async () => [message({ text: '谢谢！' }), message({ id: '2', chatId: 'oc_target' }),
      message({ id: '3', bot: true }), message({ id: '4', chatType: 'group', mentions: ['all'] })]) }); await service.tick(); expect(service.list()).toHaveLength(0);
  });
  it('only auto-cancels alerts on matching structured recovery', async () => {
    const alert = message({ chatType: 'group', bot: true, mentions: ['ou_owner'], incidentId: 'incident1', text: '告警' });
    const { service, io, advance } = await setup({ collect: vi.fn(async () => [alert]) }); await service.tick();
    vi.mocked(io.collect).mockResolvedValue([{ ...alert, id: 'om_recovery', recovered: true, mentions: [] }]);
    advance(61_000); await service.tick(); expect(service.list()[0]?.state).toBe('ignored');
  });
  it('stops an in-flight analysis on claim and never publishes its output', async () => {
    let finish!: (r: { text: string; inputTokens: number; outputTokens: number }) => void;
    const { service, io } = await setup({ analyze: vi.fn(() => new Promise<{ text: string; inputTokens: number; outputTokens: number }>(resolve => { finish = resolve; })) });
    const job = await service.manual('oc_source'); await service.tick();
    for (let i = 0; i < 20 && !finish; i++) await new Promise(r => setTimeout(r, 5));
    await service.decide(job.id, 'claim', 'ou_owner'); finish({ text: 'obsolete', inputTokens: 1, outputTokens: 1 }); await settle(service); await service.tick();
    expect(service.list()[0]?.state).toBe('claimed'); expect(vi.mocked(io.deliver).mock.calls.some(c => c[1] === 'result')).toBe(false);
  });
});

describe('Lark boundary', () => {
  it('continues past empty pages and preserves user identity', async () => {
    const exec = vi.fn(async (_args: string[]) => ({ code: 0, timedOut: false, stderr: '', stdout: JSON.stringify({ ok: true, data: { has_more: false, messages: [] } }) }));
    exec.mockResolvedValueOnce({ code: 0, timedOut: false, stderr: '', stdout: JSON.stringify({ ok: true, data: { has_more: true, messages: null, page_token: 'next' } }) });
    await new InboxLark({ profile: 'codex', rootDir: '/test' }, config(), exec).collect('mention', 1_000_000, 2_000_000);
    expect(exec).toHaveBeenCalledTimes(2); expect(exec.mock.calls[1]?.[0]).toContain('next');
  });
  it('parses mentions, thread replies and timestamp without host timezone', () => {
    const raw = { message_id: 'om_1', chat_id: 'oc_1', create_time: '2026-10-14 20:00', content: 'hello', mentions: [{ id: 'ou_owner' }], sender: { id: 'ou_sender', sender_type: 'user' } };
    const parsed = parseMessages([{ ...raw, thread_replies: [{ ...raw, message_id: 'om_2', reply_to: 'om_1' }] }]);
    expect(parsed).toHaveLength(2); expect(parsed[0]?.mentions).toEqual(['ou_owner']); expect(messageTime(raw.create_time)).toBe(Date.parse('2026-10-14T12:00:00Z'));
    expect(parsed[1]?.parentId).toBe('om_1');
  });
  it('finds recent replies even when their topic root predates the context window', async () => {
    const exec = vi.fn(async (args: string[]) => ({ code: 0, timedOut: false, stderr: '', stdout: JSON.stringify({ ok: true, data:
      args.includes('+chat-list') ? { chats: args.includes('group') ? [{ chat_id: 'oc_source', name: '旧话题群' }] : [], has_more: false }
        : { messages: args.includes('+messages-search') ? [{ message_id: 'om_newreply', chat_id: 'oc_source', create_time: '2026-10-14 20:00',
          thread_id: 'omt_oldtopic', content: '刚刚提出的新需求', sender: { id: 'ou_sender', sender_type: 'user' } }] : [], has_more: false } }) }));
    const messages = await new InboxLark({ profile: 'codex' }, config(), exec).context('oc_source', Date.parse('2026-10-14T11:50:00Z'), Date.parse('2026-10-14T12:10:00Z'));
    expect(messages.map(m => m.id)).toEqual(['om_newreply']); expect(messages[0]?.threadId).toBe('omt_oldtopic');
  });
  it('never uses source chat as output target, and emits text rather than parsing remote images', async () => {
    const { service } = await setup(); await service.tick(); const job = service.list()[0]!;
    const exec = vi.fn(async (_args: string[]) => ({ code: 0, timedOut: false, stderr: '', stdout: JSON.stringify({ ok: true, data: { messages: [{ message_id: 'om_anchor', chat_id: 'oc_target', thread_id: 'omt_topic', create_time: '2026-10-14 20:00', sender: { sender_type: 'user' }, content: '' }] } }) }));
    const cli = new InboxLark({ profile: 'codex' }, config(), exec);
    job.attention = { state: 'needed', reason: '需要确认发布日期' }; await cli.notifyAttention([job], 'digest');
    const args = exec.mock.calls[1]![0]; expect(args).toContain('--reply-in-thread'); expect(args).toContain('om_anchor'); expect(args).toContain('bot'); expect(args).toContain('--text'); expect(args).not.toContain('--markdown');
    expect(args[args.indexOf('--text') + 1]).toContain('源会话'); expect(args[args.indexOf('--text') + 1]).toContain('需要确认发布日期');
    job.destination.replyTo = 'om_evil'; await expect(cli.deliver(job, 'result')).rejects.toThrow('目标已变更');
  });
  it('bounds content while keeping latest messages', () => { const bounded = boundMessages([message({ text: 'a'.repeat(3000) }), message({ id: 'latest', time: 2_000_000, text: 'latest' })], 1000); expect(bounded.at(-1)?.id).toBe('latest'); expect(bounded.map(m => m.text).join('').length).toBeLessThanOrEqual(1000); });
  it('publishes only qualified items in the configured topic group with a stable retry key', async () => {
    const { service } = await setup(); await service.tick(); const job = service.list()[0]!;
    const c = config(); c.deliveryMode = 'new_topic'; c.gui.publicUrl = 'https://gui.example';
    job.attention = { state: 'needed', reason: '需要确认 <at user_id="ou_other">someone</at>' };
    const exec = vi.fn(async (_args: string[]) => ({ code: 0, timedOut: false, stderr: '', stdout: JSON.stringify({ ok: true, data: { chat_mode: 'topic' } }) }));
    const cli = new InboxLark({ profile: 'codex' }, c, exec);
    await cli.deliver(job, 'pending'); await cli.deliver(job, 'result'); expect(exec).not.toHaveBeenCalled();
    await cli.notifyAttention([job], 'same'); await cli.notifyAttention([job], 'same');
    const sends = exec.mock.calls.map(([args]) => args).filter(args => args.includes('+messages-send'));
    expect(sends).toHaveLength(2); expect(sends[0]).toEqual(sends[1]);
    expect(sends[0]).toEqual(expect.arrayContaining(['bot', '--chat-id', 'oc_target']));
    expect(sends[0]![sends[0]!.indexOf('--text') + 1]).not.toContain('<at');
    job.attention.state = 'uncertain'; await expect(cli.notifyAttention([job], 'bad')).rejects.toThrow('失效');
    expect(exec).toHaveBeenCalledTimes(4);
  });
  it('opens a separate topic per item and preserves each key on a partially failed retry', async () => {
    const { service } = await setup(); await service.tick();
    const c = config(); c.deliveryMode = 'new_topic'; c.gui.publicUrl = 'https://gui.example';
    const first = service.list()[0]!; first.attention = { state: 'needed', reason: '评估依赖' };
    const second = { ...structuredClone(first), id: 'second', attention: { state: 'needed' as const, reason: '确认方案' } };
    let sends = 0;
    const exec = vi.fn(async (args: string[]) => {
      if (args.includes('+messages-send') && ++sends === 2) throw Error('network');
      return { code: 0, timedOut: false, stderr: '', stdout: JSON.stringify({ ok: true, data: { chat_mode: 'topic' } }) };
    });
    const cli = new InboxLark({ profile: 'codex' }, c, exec);
    await expect(cli.notifyAttention([first, second], 'batch')).rejects.toThrow('network');
    await cli.notifyAttention([first, second], 'batch');
    const calls = exec.mock.calls.map(([args]) => args).filter(args => args.includes('+messages-send'));
    const keys = calls.map(args => args[args.indexOf('--idempotency-key') + 1]);
    expect(keys[0]).not.toBe(keys[1]); expect(keys.slice(2)).toEqual(keys.slice(0, 2));
    expect(calls[0]![calls[0]!.indexOf('--text') + 1]).toContain(`#job=${first.id}`);
    expect(calls[1]![calls[1]!.indexOf('--text') + 1]).toContain('#job=second');
    expect(exec.mock.calls.some(([args]) => args.includes('+messages-reply'))).toBe(false);
  });
  it('does not fall back to a thread or source chat when the result group is not a topic group', async () => {
    const { service } = await setup(); await service.tick();
    const c = config(); c.deliveryMode = 'new_topic';
    const exec = vi.fn(async (_args: string[]) => ({ code: 0, timedOut: false, stderr: '', stdout: JSON.stringify({ ok: true, data: { chat_mode: 'group' } }) }));
    const job = service.list()[0]!; job.attention = { state: 'needed', reason: '需要确认' };
    await expect(new InboxLark({ profile: 'codex' }, c, exec).notifyAttention([job], 'digest')).rejects.toThrow('不是话题群');
    expect(exec).toHaveBeenCalledTimes(1);
  });
  it('rejects invalid enabled configuration', () => { expect(() => validateInbox(normalizeInbox({ enabled: true }))).toThrow(); });
});

describe('H5 authentication and model capabilities', () => {
  function fakeAuth(owner = 'ou_owner') {
    const request = vi.fn(async (url: string | URL | Request) => new Response(JSON.stringify(String(url).includes('ticket') ? { code: 0, data: { ticket: 'ticket', expire_in: 7200 } }
      : String(url).includes('user_info') ? { code: 0, data: { open_id: owner } }
        : String(url).includes('oauth/token') ? { code: 0, access_token: 'ephemeral' } : { code: 0, tenant_access_token: 'tenant' }), { headers: { 'content-type': 'application/json' } }));
    return { request, auth: new InboxH5Auth('cli_app', 'secret', 'ou_owner', 'https://example.com/assistant/', 'feishu', request) };
  }
  it('signs only the configured page, caches tickets, never exposes ticket or secret', async () => {
    const { auth, request } = fakeAuth(); await expect(auth.bootstrap('https://evil.test/assistant/')).rejects.toThrow('非法');
    const a = await auth.bootstrap('https://example.com/assistant/?triggerCode=1'); await auth.bootstrap('https://example.com/assistant/');
    expect(request).toHaveBeenCalledTimes(2); expect(JSON.stringify(a)).not.toContain('secret'); expect(JSON.stringify(a)).not.toContain('ticket');
    expect(a.signature).toMatch(/^[a-f0-9]{40}$/);
  });
  it('requires owner login and consumes login state once', async () => {
    const { auth } = fakeAuth(); const init = await auth.bootstrap('https://example.com/assistant/');
    const token = await auth.login('code', init.state); expect(auth.authorized(token)).toBe(true); expect(auth.authorized('bad')).toBe(false);
    await expect(auth.login('code', init.state)).rejects.toThrow('失效');
    const other = fakeAuth('ou_other').auth; const s = await other.bootstrap('https://example.com/assistant/'); await expect(other.login('code', s.state)).rejects.toThrow('本人');
  });
  it('rejects unauthenticated HTTP submissions, cross-origin requests and management paths', async () => {
    const { service } = await setup(); service.config.h5.port = 0;
    const { auth } = fakeAuth(); const server = await startInboxH5(service, auth);
    try {
      const request = (path: string, body: unknown = {}, origin = 'https://example.com', token = '') => fetch(`http://127.0.0.1:${server.port}${path}`, {
        method: 'POST', headers: { origin, 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body),
      });
      expect((await request('/api/process', { chatId: 'oc_source' })).status).toBe(401);
      expect((await request('/api/sdk', { url: 'https://example.com/assistant/' }, 'https://evil.test')).status).toBe(403);
      const init = await auth.bootstrap('https://example.com/assistant/'); const token = await auth.login('code', init.state);
      expect((await request('/api/config', {}, 'https://example.com', token)).status).toBe(404);
      const processed = await request('/api/process', { chatId: 'oc_source', destination: 'oc_evil' }, 'https://example.com', token);
      expect(processed.status).toBe(200); expect(service.list()[0]?.destination.chatId).toBe('oc_target');
    } finally { await server.close(); }
  });
  it('uses no tools and rejects unexpected function calls instead of executing them', async () => {
    const { service } = await setup(); await service.tick(); const job = service.list()[0]!;
    expect(analysisBody(job, { model: 'test' }).tools).toEqual([]); expect(analysisBody(job, { model: 'test' }).tool_choice).toBe('none');
    const request = vi.fn(async () => new Response(JSON.stringify({ status: 'completed', output: [{ type: 'function_call', name: 'send_message' }] }), { headers: { 'content-type': 'application/json' } }));
    await expect(analyzeInbox(job, { url: 'https://model.test/responses', key: 'secret', model: 'test' }, new AbortController().signal, request)).rejects.toThrow('工具调用');
  });
  it('collects completed SSE text and usage', async () => {
    const { service } = await setup(); await service.tick(); const job = service.list()[0]!;
    const request = vi.fn(async () => new Response('data: '+JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '建议回复' }] }], usage: { input_tokens: 7, output_tokens: 3 } } })+'\n\n', { headers: { 'content-type': 'text/event-stream' } }));
    const r = await analyzeInbox(job, { url: 'https://model.test/responses', key: 'secret', model: 'test' }, new AbortController().signal, request); expect(r).toEqual({ text: '建议回复', inputTokens: 7, outputTokens: 3 });
  });
});

describe('reply workbench', () => {
  it('keeps generated results open and retains them beyond seven days', async () => {
    const s = await setup({ analyze: vi.fn(async () => ({ text: JSON.stringify({ replyDraft: '我先核对版本。', analysis: '尚缺兼容性结论。', missingInfo: '客户端版本' }), inputTokens: 10, outputTokens: 5 })) });
    await s.service.manual('oc_source'); await s.service.tick(); await settle(s.service); await s.service.tick();
    expect(s.service.list()[0]).toMatchObject({ state: 'done', handlingState: 'open', replyDraft: '我先核对版本。', missingInfo: '客户端版本' });
    s.advance(8 * 86400_000); await s.service.tick(); expect(s.service.list()).toHaveLength(1);
  });
  it('persists edits and handling while off without collection, delivery, or model calls', async () => {
    const s = await setup(); const job = await s.service.manual('oc_source'); await s.service.setMode('off');
    vi.mocked(s.io.context).mockClear(); vi.mocked(s.io.checkOwner).mockClear();
    const saved = await s.service.review({ id: job.id, revision: job.revision, replyDraft: '我修改的回复' }, 'ou_owner', 'edit-one');
    expect(saved).toMatchObject({ replyDraft: '我修改的回复', draftEdited: true, handlingState: 'open' });
    expect((await s.service.review({ id: job.id, revision: job.revision, replyDraft: '我修改的回复' }, 'ou_owner', 'edit-one')).revision).toBe(saved.revision);
    const handled = await s.service.review({ id: job.id, revision: saved.revision, handlingState: 'handled' }, 'ou_owner', 'handle-one');
    expect(handled.handlingState).toBe('handled');
    await s.service.tick();
    for (const fn of [s.io.context, s.io.collect, s.io.checkOwner, s.io.analyze, s.io.deliver]) expect(fn).not.toHaveBeenCalled();
    const loaded = new InboxStore(s.store.path); await loaded.load();
    expect(loaded.data.jobs[0]).toMatchObject({ replyDraft: '我修改的回复', handlingState: 'handled' });
  });
  it('rejects other owners, stale revisions and oversized edits', async () => {
    const s = await setup(); const job = await s.service.manual('oc_source');
    await expect(s.service.review({ id: job.id, revision: job.revision, replyDraft: 'x' }, 'ou_other', 'a')).rejects.toThrow('forbidden');
    await s.service.review({ id: job.id, revision: job.revision, replyDraft: 'new' }, 'ou_owner', 'b');
    await expect(s.service.review({ id: job.id, revision: job.revision, replyDraft: 'old' }, 'ou_owner', 'c')).rejects.toThrow('已更新');
    await expect(s.service.review({ id: job.id, revision: 2, replyDraft: 'x'.repeat(6001) }, 'ou_owner', 'd')).rejects.toThrow('无效');
    expect(s.service.list()[0]?.replyDraft).toBe('new');
  });
  it('rolls back an edit on persistence failure, allowing a real retry', async () => {
    const s = await setup(); const job = await s.service.manual('oc_source');
    vi.spyOn(s.store, 'save').mockRejectedValueOnce(new Error('disk error'));
    const edit = { id: job.id, revision: job.revision, replyDraft: 'durable' };
    await expect(s.service.review(edit, 'ou_owner', 'edit')).rejects.toThrow('disk error');
    expect(s.service.list()[0]?.replyDraft).toBeUndefined();
    expect((await s.service.review(edit, 'ou_owner', 'edit')).replyDraft).toBe('durable');
  });
  it('never overwrites a saved edit with a late model result', async () => {
    let finish!: (r: { text: string; inputTokens: number; outputTokens: number }) => void;
    const s = await setup({ analyze: vi.fn(() => new Promise<{ text: string; inputTokens: number; outputTokens: number }>(resolve => { finish = resolve; })) });
    await s.service.manual('oc_source'); await s.service.tick(); await vi.waitFor(() => expect(finish).toBeDefined());
    const job = s.service.list()[0]!;
    await s.service.review({ id: job.id, revision: job.revision, replyDraft: '用户最终修改' }, 'ou_owner', 'save');
    finish({ text: JSON.stringify({ replyDraft: '过期生成内容', analysis: '分析', missingInfo: '' }), inputTokens: 1, outputTokens: 1 });
    await settle(s.service); await s.service.tick();
    expect(s.service.list()[0]).toMatchObject({ replyDraft: '用户最终修改', handlingState: 'open', state: 'waiting' });
    expect(s.service.list()[0]?.result).toBeUndefined();
  });
  it('marks a prepared draft stale for new messages and closes it only after an owner reply', async () => {
    const s = await setup(); await s.service.manual('oc_source'); await s.service.tick(); await settle(s.service); await s.service.tick();
    const job = s.service.list()[0]!;
    await s.service.review({ id: job.id, revision: job.revision, replyDraft: '已有修改' }, 'ou_owner', 'save');
    vi.mocked(s.io.collect).mockResolvedValue([message({ id: 'om_followup', time: 1_061_000, text: '版本改成了 2.0，请重新确认。' })]);
    s.advance(61_000); await s.service.tick();
    expect(s.service.list()[0]).toMatchObject({ draftStale: true, replyDraft: '已有修改', handlingState: 'open', state: 'waiting' });
    vi.mocked(s.io.collect).mockResolvedValue([message({ id: 'om_owner', senderId: 'ou_owner', time: 1_122_000 })]);
    s.advance(61_000); await s.service.tick(); expect(s.service.list()[0]?.handlingState).toBe('handled');
  });
  it('does not create a duplicate item when a known message is edited', async () => {
    const s = await setup(); await s.service.tick();
    vi.mocked(s.io.collect).mockResolvedValue([message({ text: '修改后的请求' })]);
    vi.mocked(s.io.context).mockResolvedValue([message({ text: '修改后的请求' })]); s.advance(61_000); await s.service.tick();
    expect(s.service.list()).toHaveLength(1); expect(s.service.list()[0]?.messages).toHaveLength(1);
    expect(s.service.list()[0]?.messages[0]?.text).toBe('修改后的请求');
  });
});

describe('intake scopes', () => {
  it.each([
    ['private', ['p2p'], ['p2p']],
    ['private_mentions', ['p2p', 'mention'], ['p2p', 'mention']],
    ['all', ['p2p', 'group'], ['p2p', 'mention', 'group']],
  ] as const)('collects and admits only %s messages', async (scope, kinds, ids) => {
    const messages = [message({ id: 'p2p' }), message({ id: 'mention', chatId: 'oc_mention', chatType: 'group', mentions: ['ou_owner'] }),
      message({ id: 'group', chatId: 'oc_group', chatType: 'group' })];
    const collect = vi.fn(async (_kind: string) => messages);
    const { service } = await setup({ collect });
    await service.setScope(scope); await service.tick();
    expect(collect.mock.calls.map(c => c[0])).toEqual(kinds);
    expect(service.list().flatMap(j => j.messages.map(m => m.id)).sort()).toEqual([...ids].sort());
  });
  it('keeps scope changes independent of off mode and persists before applying', async () => {
    const { service, io } = await setup(); await service.setMode('off');
    await expect(service.setScope('all', async () => { throw Error('disk full'); })).rejects.toThrow('disk full');
    expect(service.config.intakeScope).not.toBe('all');
    await service.setScope('all'); await service.tick();
    expect(service.config).toMatchObject({ enabled: false, autoAnalyze: false, intakeScope: 'all' });
    expect(io.collect).not.toHaveBeenCalled(); expect(io.analyze).not.toHaveBeenCalled();
  });
  it('does not backfill the overlap when widening scope', async () => {
    const collect = vi.fn(async () => [message({ id: 'old', chatType: 'group', time: 1_000_000 }),
      message({ id: 'new', chatType: 'group', time: 1_061_001 })]);
    const { service, advance } = await setup({ collect }); advance(61_000); await service.setScope('all');
    await service.tick(); expect(service.list().flatMap(j => j.messages.map(m => m.id))).toEqual(['new']);
  });
  it('retains unrelated group jobs but stops background follow-up and automatic execution after narrowing', async () => {
    const group = message({ chatType: 'group', chatId: 'oc_group' });
    const { service, io, store, advance } = await setup({ collect: vi.fn(async () => [group]) });
    await service.setScope('all'); await service.tick();
    store.data.jobs[0]!.state = 'queued';
    await service.setScope('private_mentions'); advance(61_000); await service.tick();
    expect(service.list()[0]).toMatchObject({ state: 'waiting', automatic: false });
    expect(io.context).not.toHaveBeenCalled(); expect(io.analyze).not.toHaveBeenCalled();
  });
  it('discards a collection returning during a scope transition', async () => {
    let release!: (messages: InboxMessage[]) => void;
    const collect = vi.fn(() => new Promise<InboxMessage[]>(resolve => { release = resolve; }));
    const { service } = await setup({ collect });
    const poll = service.tick(); await vi.waitFor(() => expect(collect).toHaveBeenCalled());
    const change = service.setScope('private'); release([message()]);
    await Promise.all([poll, change]); expect(service.list()).toEqual([]);
  });
  it('preserves legacy restricted configurations until a scope is chosen', () => {
    const old = normalizeInbox({ watchPrivate: false, watchMentions: true });
    expect(old).toMatchObject({ watchPrivate: false, watchMentions: true });
    expect(old.intakeScope).toBeUndefined();
    expect(normalizeInbox({ ...old, intakeScope: 'all' })).toMatchObject({ watchPrivate: true, watchMentions: true });
  });
  it('queries all group messages without the at-me filter', async () => {
    const exec = vi.fn(async (_args: string[]) => ({ code: 0, stdout: JSON.stringify({ ok: true, data: { messages: [] } }), stderr: '', timedOut: false }));
    const lark = new InboxLark({ profile: 'codex' }, config(), exec);
    await lark.collect('group', 1_000_000, 1_060_000);
    expect(exec.mock.calls[0]![0]).toEqual(expect.arrayContaining(['--chat-type', 'group']));
    expect(exec.mock.calls[0]![0]).not.toContain('--is-at-me'); lark.close();
  });
});

describe('lightweight attention and quiet delivery', () => {
  const classify: NonNullable<InboxIO['triage']> = async jobs => jobs.map(j => ({ id: j.id, state: 'needed', reason: '需要本人确认日期', priority: 'normal' }));
  async function screened(overrides: Partial<InboxIO> = {}) {
    const s = await setup({ triage: vi.fn(classify), notifyAttention: vi.fn(async () => {}), ...overrides });
    await s.service.tick(); s.advance(61_000); await s.service.tick();
    return s;
  }
  it('screens 51 ready items in batches of 50 and 1, counting model calls rather than items', async () => {
    const messages = Array.from({ length: 51 }, (_, i) => message({ id: `om_${i}`, chatId: `oc_${i}` }));
    const s = await screened({ collect: vi.fn(async kind => kind === 'p2p' ? messages : []), context: vi.fn(async () => []) });
    await vi.waitFor(() => expect(s.service.list().filter(j => j.attention?.state === 'needed')).toHaveLength(50));
    expect(vi.mocked(s.io.triage!).mock.calls[0]![0]).toHaveLength(50);
    await s.service.tick();
    await vi.waitFor(() => expect(s.service.list().filter(j => j.attention?.state === 'needed')).toHaveLength(51));
    expect(vi.mocked(s.io.triage!).mock.calls[1]![0]).toHaveLength(1);
    expect(s.store.data.triageUsage?.['1970-01-01']).toBe(2);
  });
  it('keeps the legacy digest without automatic work when no topic-announcement adapter is available', async () => {
    const messages = [message(), message({ id: 'om_quiet', chatId: 'oc_quiet' }), message({ id: 'om_unknown', chatId: 'oc_unknown' })];
    const triage = vi.fn<NonNullable<InboxIO['triage']>>(async jobs => jobs.map((j, i) => ({ id: j.id, state: ['needed', 'quiet', 'uncertain'][i] as 'needed' | 'quiet' | 'uncertain', reason: '模型判断', priority: 'normal' })));
    const s = await screened({ collect: vi.fn(async () => messages), context: vi.fn(async () => []), triage });
    await vi.waitFor(() => expect(s.service.list().filter(j => j.attention?.state === 'pending')).toHaveLength(0));
    await s.service.tick();
    expect(triage).toHaveBeenCalledTimes(1); expect(triage.mock.calls[0]![0]).toHaveLength(3);
    expect(s.io.notifyAttention).toHaveBeenCalledTimes(1);
    expect(vi.mocked(s.io.notifyAttention!).mock.calls[0]![0]).toHaveLength(1);
    expect(s.io.analyze).not.toHaveBeenCalled(); expect(s.io.deliver).not.toHaveBeenCalled();
    s.advance(3600_000); await s.service.tick(); expect(s.io.notifyAttention).toHaveBeenCalledTimes(1);
  });
  it('persists retries with a stable digest id and never duplicates a acknowledged item', async () => {
    const notifyAttention = vi.fn<NonNullable<InboxIO['notifyAttention']>>().mockRejectedValueOnce(Error('network')).mockResolvedValue(undefined);
    const s = await screened({ notifyAttention });
    await vi.waitFor(() => expect(s.service.list()[0]?.attention?.state).toBe('needed')); await s.service.tick();
    const outbox = s.store.data.notificationOutbox!; expect(outbox.attempts).toBe(1);
    const saved = new InboxStore(s.store.path); await saved.load(); expect(saved.data.notificationOutbox?.id).toBe(outbox.id);
    s.advance(61_000); await s.service.tick();
    expect(notifyAttention).toHaveBeenCalledTimes(2); expect(notifyAttention.mock.calls[0]![1]).toBe(notifyAttention.mock.calls[1]![1]);
    expect(s.store.data.notificationOutbox).toBeUndefined();
    s.advance(3600_000); await s.service.tick(); expect(notifyAttention).toHaveBeenCalledTimes(2);
  });
  it.each(['off', 'scope', 'changed', 'handled'] as const)('drops obsolete triage after %s', async action => {
    let complete!: (value: Awaited<ReturnType<NonNullable<InboxIO['triage']>>>) => void;
    let progress!: NonNullable<Parameters<NonNullable<InboxIO['triage']>>[2]>;
    const triage = vi.fn<NonNullable<InboxIO['triage']>>((_jobs, _signal, onProgress) => new Promise(resolve => { complete = resolve; progress = onProgress!; }));
    const s = await screened({ triage }); await vi.waitFor(() => expect(complete).toBeDefined());
    const before = s.service.list()[0]!;
    const save = vi.spyOn(s.store, 'save');
    progress([{ id: before.id, text: '需要确认' }]);
    expect(s.service.list()[0]?.attention?.progress?.text).toBe('需要确认');
    expect(s.service.get(before.id)?.attention?.progress?.text).toBe('需要确认');
    expect(s.store.data.jobs[0]?.attention?.progress).toBeUndefined();
    expect(s.service.list()[0]?.revision).toBe(before.revision); expect(save).not.toHaveBeenCalled();
    if (action === 'off') await s.service.setMode('off');
    if (action === 'scope') await s.service.setScope('private');
    if (action === 'handled') await s.service.batchReview({ items: [{ id: before.id, revision: before.revision }], handlingState: 'handled' }, 'ou_owner', 'batch1');
    if (action === 'changed') {
      const changed = message({ text: '新问题需要重新筛选' });
      vi.mocked(s.io.collect).mockResolvedValue([changed]); vi.mocked(s.io.context).mockResolvedValue([changed]); s.advance(61_000); await s.service.tick();
    }
    progress([{ id: before.id, text: '过期的后续文本' }]);
    expect(s.service.list()[0]?.attention?.progress).toBeUndefined();
    expect(s.service.get(before.id)?.attention?.progress).toBeUndefined();
    complete(await classify([before], new AbortController().signal)); await new Promise(r => setTimeout(r, 20));
    expect(s.service.list()[0]?.attention?.state).not.toBe('needed'); expect(s.io.notifyAttention).not.toHaveBeenCalled();
  });
  it('leaves failures visible and enforces the durable triage budget', async () => {
    const s = await screened({ triage: vi.fn(async () => { throw Error('bad response'); }) });
    await vi.waitFor(() => expect(s.service.list()[0]?.attention?.retry?.attempts).toBe(1));
    await s.service.tick(); expect(s.io.notifyAttention).not.toHaveBeenCalled();
    expect(s.store.data.triageUsage?.['1970-01-01']).toBe(1);
    s.service.config.dailyTriageLimit = 1; s.store.data.jobs[0]!.attention = { state: 'pending', reason: '' }; s.advance(61_000); await s.service.tick();
    expect(s.io.triage).toHaveBeenCalledTimes(1); expect(s.service.list()[0]?.attention).toMatchObject({ state: 'pending', retry: { nextAt: 86400_000 } });
  });
  it('persists backoff across restart, retries automatically and clears metadata after success', async () => {
    const triage = vi.fn<NonNullable<InboxIO['triage']>>().mockRejectedValueOnce(Error('HTTP 429')).mockRejectedValueOnce(Error('connection lost')).mockImplementation(classify);
    const s = await screened({ triage });
    await vi.waitFor(() => expect(s.service.list()[0]?.attention?.retry?.attempts).toBe(1));
    const first = s.service.list()[0]!.attention!.retry!;
    expect(first.nextAt).toBe(1_091_000); expect(first.error).toBe('模型服务限流');
    await s.service.close();
    const store = new InboxStore(s.store.path);
    let now = 1_090_999;
    const service = new InboxService(store, s.service.config, s.io, () => now); services.push(service); await service.start();
    await service.tick(); expect(triage).toHaveBeenCalledTimes(1);
    now++; await service.tick();
    await vi.waitFor(() => expect(service.list()[0]?.attention?.retry?.attempts).toBe(2));
    expect(service.list()[0]?.attention?.retry?.nextAt).toBe(now + 120_000);
    expect(s.io.notifyAttention).not.toHaveBeenCalled();
    now += 120_000; await service.tick();
    await vi.waitFor(() => expect(service.list()[0]?.attention?.state).toBe('needed'));
    expect(service.list()[0]?.attention?.retry).toBeUndefined(); expect(store.data.triageUsage?.['1970-01-01']).toBe(3);
  });
  it('persists partial successes and retries only failed items with their specific reason', async () => {
    const triage = vi.fn<NonNullable<InboxIO['triage']>>(async jobs => jobs.map((j, i) => ({ id: j.id,
      state: i === 0 ? 'quiet' : 'pending', reason: i === 0 ? '无需动作' : '筛选结果缺少事项', priority: 'normal' })));
    const s = await screened({ triage, collect: vi.fn(async kind => kind === 'p2p' ? [message(), message({ id: 'om_second', chatId: 'oc_second' })] : []) });
    await vi.waitFor(() => expect(s.service.list().some(j => j.attention?.retry)).toBe(true));
    const done = s.service.list().find(j => j.attention?.state === 'quiet')!;
    const retry = s.service.list().find(j => j.attention?.retry)!;
    expect(done.attention?.retry).toBeUndefined();
    expect(retry.attention?.retry?.error).toBe('筛选结果缺少事项');
    s.advance(30_000); await s.service.tick();
    await vi.waitFor(() => expect(triage).toHaveBeenCalledTimes(2));
    expect(triage.mock.calls[1]![0].map(j => j.id)).toEqual([retry.id]);
    expect(s.io.notifyAttention).not.toHaveBeenCalled();
  });
  it('migrates only unresolved legacy execution failures, not genuine uncertainty or handled items', async () => {
    const s = await setup(); await s.service.tick(); await s.service.close();
    const base = s.store.data.jobs[0]!;
    s.store.data.jobs = [
      { ...base, id: 'failed', attention: { state: 'uncertain', reason: '关注筛选未完成，请人工核对' } },
      { ...base, id: 'genuine', attention: { state: 'uncertain', reason: '本人相关，但谁负责上线尚未确认' } },
      { ...base, id: 'handled', handlingState: 'handled', attention: { state: 'uncertain', reason: '关注筛选未完成，请人工核对' } },
    ];
    await s.store.save();
    const service = new InboxService(new InboxStore(s.store.path), s.service.config, s.io, () => 1_001_000); services.push(service); await service.start();
    expect(service.list().find(j => j.id === 'failed')?.attention).toMatchObject({ state: 'pending', retry: { attempts: 0 } });
    expect(service.list().find(j => j.id === 'genuine')?.attention?.state).toBe('uncertain');
    expect(service.list().find(j => j.id === 'handled')?.attention?.state).toBe('uncertain');
  });
  it('treats ignored items as quiet, never retries them, and only rescreens after explicit restore', async () => {
    const s = await setup({ triage: vi.fn(classify) }); await s.service.tick();
    const job = s.store.data.jobs[0]!;
    job.attention = { state: 'pending', reason: '连接中断', retry: { attempts: 1, nextAt: 0, error: '连接中断' } };
    await s.service.batchReview({ items: [{ id: job.id, revision: job.revision }], handlingState: 'ignored' }, 'ou_owner', 'ignore-one');
    expect(s.service.list()[0]?.attention).toEqual({ state: 'quiet', reason: '你已忽略此事项，无需动作' });
    s.advance(120_000); await s.service.tick(); expect(s.io.triage).not.toHaveBeenCalled();
    await s.service.close();
    job.attention = { state: 'uncertain', reason: '关注筛选未完成，请人工核对' }; await s.store.save();
    const service = new InboxService(new InboxStore(s.store.path), s.service.config, s.io, () => 1_120_000); services.push(service); await service.start();
    expect(service.list()[0]?.attention?.state).toBe('quiet');
    await service.tick(); expect(s.io.triage).not.toHaveBeenCalled();
    const ignored = service.list()[0]!;
    await service.review({ id: ignored.id, revision: ignored.revision, handlingState: 'open' }, 'ou_owner', 'restore-one');
    expect(service.list()[0]).toMatchObject({ handlingState: 'open', state: 'waiting', attention: { state: 'pending' } });
  });
  it('cancels active screening when every item in its batch has been ignored', async () => {
    let signal!: AbortSignal;
    let complete!: (value: []) => void;
    const s = await screened({ triage: vi.fn<NonNullable<InboxIO['triage']>>((_jobs, current) => {
      signal = current; return new Promise(resolve => { complete = resolve; });
    }) });
    await vi.waitFor(() => expect(signal).toBeDefined());
    const job = s.service.list()[0]!;
    await s.service.batchReview({ items: [{ id: job.id, revision: job.revision }], handlingState: 'ignored' }, 'ou_owner', 'ignore-active');
    expect(signal.aborted).toBe(true); complete([]);
    await new Promise(r => setTimeout(r, 20));
    expect(s.service.list()[0]?.attention?.state).toBe('quiet'); expect(s.io.notifyAttention).not.toHaveBeenCalled();
  });
  it.each(['off', 'scope', 'changed', 'handled'] as const)('does not schedule obsolete failures after %s', async action => {
    let fail!: (error: Error) => void;
    const s = await screened({ triage: vi.fn<NonNullable<InboxIO['triage']>>(() => new Promise((_resolve, reject) => { fail = reject; })) });
    await vi.waitFor(() => expect(fail).toBeDefined());
    const before = s.service.list()[0]!;
    if (action === 'off') await s.service.setMode('off');
    if (action === 'scope') await s.service.setScope('private');
    if (action === 'handled') await s.service.batchReview({ items: [{ id: before.id, revision: before.revision }], handlingState: 'handled' }, 'ou_owner', 'retry-handled');
    if (action === 'changed') {
      const changed = message({ text: '新消息' });
      vi.mocked(s.io.collect).mockResolvedValue([changed]); vi.mocked(s.io.context).mockResolvedValue([changed]); s.advance(61_000); await s.service.tick();
    }
    fail(Error('network')); await new Promise(r => setTimeout(r, 20));
    expect(s.service.list()[0]?.attention?.retry).toBeUndefined(); expect(s.io.notifyAttention).not.toHaveBeenCalled();
  });
  it('suppresses stale digest retries after a selected item is handled', async () => {
    const s = await screened({ notifyAttention: vi.fn(async () => { throw Error('uncertain send'); }) });
    await vi.waitFor(() => expect(s.service.list()[0]?.attention?.state).toBe('needed')); await s.service.tick();
    const job = s.service.list()[0]!;
    await s.service.batchReview({ items: [{ id: job.id, revision: job.revision }], handlingState: 'ignored' }, 'ou_owner', 'batch');
    s.advance(61_000); await s.service.tick(); expect(s.io.notifyAttention).toHaveBeenCalledTimes(1);
    expect(s.store.data.notificationOutbox).toBeUndefined();
  });
  it('checks every revision before an atomic batch, including off mode and replay', async () => {
    const messages = [message(), message({ id: 'om_second', chatId: 'oc_second' })];
    const s = await setup({ collect: vi.fn(async () => messages) }); await s.service.tick(); await s.service.setMode('off');
    const items = s.service.list().map(j => ({ id: j.id, revision: j.revision! }));
    await expect(s.service.batchReview({ items, handlingState: 'handled' }, 'ou_other', 'batch')).rejects.toThrow('forbidden');
    await expect(s.service.batchReview({ items: [items[0], { ...items[1], revision: 90 }], handlingState: 'handled' }, 'ou_owner', 'batch')).rejects.toThrow('未修改');
    expect(s.service.list().every(j => j.handlingState === 'open')).toBe(true);
    const request = { items, handlingState: 'handled' };
    vi.spyOn(s.store, 'save').mockRejectedValueOnce(Error('disk failure'));
    await expect(s.service.batchReview(request, 'ou_owner', 'batch')).rejects.toThrow('disk failure');
    expect(s.service.list().every(j => j.handlingState === 'open')).toBe(true);
    await s.service.batchReview(request, 'ou_owner', 'batch'); await s.service.batchReview(request, 'ou_owner', 'batch');
    expect(s.service.list().every(j => j.handlingState === 'handled' && j.revision === 1)).toBe(true);
    const stored = new InboxStore(s.store.path); await stored.load(); expect(stored.data.jobs.every(j => j.handlingState === 'handled')).toBe(true);
    expect(s.io.analyze).not.toHaveBeenCalled(); expect(s.io.deliver).not.toHaveBeenCalled();
  });
});


it('allows batch handling during an unfinished remote collection', async () => {
  const s = await setup(); await s.service.tick(); const job = s.service.list()[0]!;
  let finish!: (value: InboxMessage[]) => void;
  vi.mocked(s.io.collect).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  s.advance(61000); const polling = s.service.tick(); await vi.waitFor(() => expect(finish).toBeDefined());
  try {
    await s.service.batchReview({ items: [{ id: job.id, revision: job.revision }], handlingState: 'handled' }, 'ou_owner', 'quick-batch');
    expect(s.service.list()[0]?.handlingState).toBe('handled');
  } finally { finish([]); await s.service.setMode('off'); await polling; }
});
it('rejects stale collection across an off/on cycle even when enabled again', async () => {
  let finish!: (value: InboxMessage[]) => void;
  const s = await setup({ collect: vi.fn(() => new Promise<InboxMessage[]>(resolve => { finish = resolve; })) });
  const polling = s.service.tick(); await vi.waitFor(() => expect(finish).toBeDefined());
  await s.service.setMode('off'); await s.service.setMode('on'); finish([message()]); await polling;
  expect(s.service.list()).toHaveLength(0); expect(s.io.analyze).not.toHaveBeenCalled();
});
