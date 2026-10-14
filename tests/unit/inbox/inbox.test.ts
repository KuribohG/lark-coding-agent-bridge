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

describe('durable inbox', () => {
  it('starts countdown only after successful notification and does not analyze on collection', async () => {
    const { service, io, advance } = await setup(); await service.tick();
    expect(service.list()[0]?.state).toBe('notifying'); expect(io.analyze).not.toHaveBeenCalled();
    advance(61_000); await service.tick(); expect(service.list()[0]?.dueAt).toBe(1_121_000);
    advance(61_000); await service.tick(); await settle(service); await service.tick();
    expect(service.list()[0]?.state).toBe('done'); expect(io.analyze).toHaveBeenCalledTimes(1);
    expect(service.list()[0]?.inputTokens).toBe(100);
  });
  it('keeps notification failure pending, without starting its timer', async () => {
    const { service, advance } = await setup({ deliver: vi.fn(async () => { throw new Error('offline'); }) });
    await service.tick(); advance(61_000); await service.tick();
    expect(service.list()[0]?.state).toBe('notifying'); expect(service.list()[0]?.dueAt).toBeUndefined();
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
  it('serializes timeout/click race and counts one analysis', async () => {
    const { service, io, advance } = await setup(); await service.tick(); advance(61_000); await service.tick(); advance(61_000);
    await Promise.all([service.tick(), service.decide(service.list()[0]!.id, 'process', 'ou_owner')]); await settle(service);
    expect(io.analyze).toHaveBeenCalledTimes(1);
  });
  it('keeps daily limit and waiting countdown across restart', async () => {
    const { service, store, advance } = await setup(); await service.tick(); advance(61_000); await service.tick();
    store.data.autoUsage['1970-01-01'] = 20; await store.save(); const resumed = new InboxStore(store.path); await resumed.load();
    expect(resumed.data.jobs[0]?.dueAt).toBe(1_121_000); expect(resumed.data.autoUsage['1970-01-01']).toBe(20);
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
    const parsed = parseMessages([{ ...raw, thread_replies: [{ ...raw, message_id: 'om_2' }] }]);
    expect(parsed).toHaveLength(2); expect(parsed[0]?.mentions).toEqual(['ou_owner']); expect(messageTime(raw.create_time)).toBe(Date.parse('2026-10-14T12:00:00Z'));
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
    const cli = new InboxLark({ profile: 'codex' }, config(), exec); await cli.deliver(job, 'progress');
    const args = exec.mock.calls[1]![0]; expect(args).toContain('--reply-in-thread'); expect(args).toContain('om_anchor'); expect(args).toContain('bot'); expect(args).toContain('--text'); expect(args).not.toContain('--markdown');
    expect(args[args.indexOf('--text') + 1]).toContain('源会话'); expect(args[args.indexOf('--text') + 1]).toContain('oc_source');
    job.destination.replyTo = 'om_evil'; await expect(cli.deliver(job, 'result')).rejects.toThrow('目标已变更');
  });
  it('bounds content while keeping latest messages', () => { const bounded = boundMessages([message({ text: 'a'.repeat(3000) }), message({ id: 'latest', time: 2_000_000, text: 'latest' })], 1000); expect(bounded.at(-1)?.id).toBe('latest'); expect(bounded.map(m => m.text).join('').length).toBeLessThanOrEqual(1000); });
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
