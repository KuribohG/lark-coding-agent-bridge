import { createHash } from 'node:crypto';
import { larkCliEnv, getUserAuthStatus, type LarkCliExec, type UserImContext } from '../lark-cli/user-im';
import { mergeProcessEnv, spawnProcess } from '../platform/spawn';
import type { InboxConfig } from './config';
import type { InboxJob, InboxMessage } from './types';
import { obj, type Obj } from './values';

const str = (v: unknown) => typeof v === 'string' ? v : '';
const iso = (n: number) => new Date(n).toISOString().replace(/\.\d{3}Z$/, 'Z');

/** The subprocess runs in Asia/Shanghai so minute-resolution dates have a fixed offset. */
export function messageTime(v: unknown): number {
  const s = str(v);
  if (/^\d+$/.test(s)) return Number(s) * (s.length <= 10 ? 1000 : 1);
  return Date.parse(/^\d{4}-\d\d-\d\d \d\d:\d\d(:\d\d)?$/.test(s) ? s.replace(' ', 'T') + '+08:00' : s);
}
export function parseMessages(value: unknown, hint: 'p2p' | 'group' = 'group'): InboxMessage[] {
  if (!Array.isArray(value)) return [];
  const messages: InboxMessage[] = [];
  for (const v of value) {
    const m = obj(v); const sender = obj(m.sender);
    if (m.deleted) continue;
    const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '');
    const mentions = (Array.isArray(m.mentions) ? m.mentions : []).map(v => {
      const mention = obj(v); return str(obj(mention.id).open_id) || str(mention.id) || str(mention.open_id);
    });
    for (const match of text.matchAll(/<at\b[^>]*(?:user_id|open_id)=["'](ou_\w+)["']/g)) mentions.push(match[1]!);
    const time = messageTime(m.create_time);
    let alert: Obj = {};
    try { alert = obj(JSON.parse(text)); } catch { /* only explicit structured recovery is authoritative */ }
    const incidentId = str(alert.fingerprint) || str(alert.alert_id);
    if (str(m.message_id) && str(m.chat_id) && Number.isFinite(time)) messages.push({
      id: str(m.message_id), chatId: str(m.chat_id), chatName: str(m.chat_name) || str(obj(m.chat_partner).name),
      chatType: m.chat_type === 'p2p' ? 'p2p' : hint,
      senderId: str(sender.id), senderName: str(sender.name), bot: sender.sender_type !== 'user',
      time, text, threadId: str(m.thread_id) || undefined, parentId: str(m.parent_id) || undefined,
      position: str(m.message_position) || undefined,
      link: str(m.message_app_link) || undefined, mentions,
      ...(incidentId ? { incidentId, recovered: alert.status === 'resolved' || alert.status === 'recovered' } : {}),
    });
    messages.push(...parseMessages(m.thread_replies, hint));
  }
  return [...new Map(messages.map(m => [m.id, m])).values()];
}

export class InboxLark {
  private sources = new Map<string, { name: string; type: 'p2p' | 'group'; checkedAt: number }>();
  private abort = new AbortController();
  private exec: LarkCliExec;
  constructor(private ctx: UserImContext, private config: InboxConfig, exec?: LarkCliExec) {
    this.exec = exec ?? ((args, env, timeoutMs) => new Promise((resolve, reject) => {
      if (this.abort.signal.aborted) { reject(new Error('助理已关闭')); return; }
      const child = spawnProcess('lark-cli', args, { env: mergeProcessEnv(process.env, env), stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = ''; let stderr = ''; let bytes = 0; let timedOut = false;
      const kill = () => { child.kill('SIGKILL'); };
      this.abort.signal.addEventListener('abort', kill, { once: true });
      const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
      const append = (data: Buffer, error: boolean) => { bytes += data.length; if (bytes > 8_000_000) { kill(); return; } if (error) stderr += data.toString(); else stdout += data.toString(); };
      child.stdout?.on('data', (data: Buffer) => append(data, false)); child.stderr?.on('data', (data: Buffer) => append(data, true));
      const cleanup = () => { clearTimeout(timer); this.abort.signal.removeEventListener('abort', kill); };
      child.once('error', () => { cleanup(); reject(new Error('无法启动当前 profile 的 lark-cli')); });
      child.once('close', code => { cleanup(); resolve({ code, stdout, stderr, timedOut }); });
    }));
  }
  close(): void { this.abort.abort(); }
  async call(args: string[]): Promise<Obj> {
    this.abort.signal.throwIfAborted();
    const r = await this.exec([...args, '--json'], { ...larkCliEnv(this.ctx), TZ: 'Asia/Shanghai' }, 60_000);
    let envelope: Obj;
    try { envelope = obj(JSON.parse(r.stdout)); } catch { throw new Error('飞书读取失败，请检查当前 profile 的用户授权和 bridge 绑定状态'); }
    if (r.code !== 0 || r.timedOut || envelope.ok !== true) throw new Error('飞书接口失败，请检查当前 profile 的权限；未自动切换身份');
    return obj(envelope.data);
  }
  async checkOwner(owner: string): Promise<void> {
    const auth = await getUserAuthStatus(this.ctx, this.exec);
    if (auth.openId !== owner) throw new Error('当前 profile 的用户授权与助理所属用户不一致');
    // The CLI can refresh an expired access token using its existing refresh token.
    if (!auth.scopes.includes('search:message')) throw new Error('当前用户授权缺少 search:message');
  }
  private async pages(args: string[], key: string): Promise<unknown[]> {
    const values: unknown[] = []; const seen = new Set<string>(); let token = '';
    for (let i = 0; i < 40; i++) {
      const d = await this.call([...args, ...(token ? ['--page-token', token] : [])]);
      if (Array.isArray(d[key])) values.push(...d[key] as unknown[]);
      if (!d.has_more) return values;
      const next = str(d.page_token);
      if (!next || seen.has(next)) throw new Error('飞书分页未完成，保留读取进度以便重试');
      seen.add(next); token = next;
    }
    throw new Error('消息超过单轮读取上限，保留进度；请缩小监听范围');
  }
  async collect(kind: 'p2p' | 'mention', start: number, end: number): Promise<InboxMessage[]> {
    const raw = await this.pages(['im', '+messages-search', '--as', 'user', '--start', iso(start), '--end', iso(end),
      '--page-size', '50', '--no-reactions', ...(kind === 'p2p' ? ['--chat-type', 'p2p'] : ['--is-at-me'])], 'messages');
    const messages = parseMessages(raw, kind === 'p2p' ? 'p2p' : 'group');
    for (const m of messages) {
      if (!m.chatName) m.chatName = (await this.source(m.chatId)).name;
    }
    return messages;
  }
  async context(chatId: string, start: number, end: number): Promise<InboxMessage[]> {
    const source = await this.source(chatId);
    // Chat history filters topic roots by creation time, losing fresh replies to old topics.
    const raw = await this.pages(['im', '+messages-search', '--as', 'user', '--chat-id', chatId,
      '--start', iso(start), '--end', iso(end), '--page-size', '50', '--no-reactions'], 'messages');
    return parseMessages(raw, source.type).filter(m => m.time >= start && m.time <= end).map(m => ({ ...m, chatName: source.name, chatType: source.type }));
  }
  async source(chatId: string): Promise<{ name: string; type: 'p2p' | 'group' }> {
    if (!/^oc_\w+$/.test(chatId)) throw new Error('invalid chat ID');
    const cached = this.sources.get(chatId);
    if (cached && Date.now() - cached.checkedAt < 5 * 60_000) return cached;
    // Membership is verified against the user's own conversation list, not the H5 payload.
    for (const type of ['p2p', 'group'] as const) {
      const chats = await this.pages(['im', '+chat-list', '--as', 'user', '--types', type, '--sort', 'active_time', '--page-size', '100'], 'chats');
      for (const v of chats) {
        const c = obj(v); const id = str(c.chat_id); const name = str(c.name);
        if (id && name) this.sources.set(id, { name, type, checkedAt: Date.now() });
      }
      const found = this.sources.get(chatId); if (found) return found;
    }
    throw new Error('无法确认你属于该会话，或无法取得会话名称');
  }
  async deliver(job: InboxJob, phase: 'pending' | 'progress' | 'result'): Promise<void> {
    const d = job.destination;
    if (job.ownerOpenId !== this.config.ownerOpenId || JSON.stringify(d) !== JSON.stringify(this.config.destination)) throw new Error('结果目标已变更，请重新处理待办');
    const anchor = await this.call(['im', '+messages-mget', '--as', 'bot', '--message-ids', d.replyTo, '--no-reactions']);
    const messages = parseMessages(anchor.messages);
    if (!messages.some(m => m.id === d.replyTo && m.chatId === d.chatId && m.threadId === d.threadId)) throw new Error('无法验证结果话题，停止投递');
    const escape = (s: string) => s.replace(/[\r\n]/g, ' ').replace(/[<>`*_\[\]]/g, '');
    const first = job.messages[0]!; const last = job.messages.at(-1)!;
    const header = `来源${job.source.type === 'p2p' ? '私聊' : '群聊'}：${escape(job.source.name)}\n来源会话 ID：${job.source.chatId}\n消息范围：${iso(first.time)} ～ ${iso(last.time)}\n待办：${job.id}\n`;
    const entry = this.config.h5.publicUrl ? `\n处理 / 我来处理 / 忽略：${this.config.h5.publicUrl}#job=${job.id}` : '';
    const text = header + '\n' + (phase === 'pending' ? `发现待处理消息。${job.alert || !this.config.autoAnalyze ? '本项只提醒，点击后分析。' : `${this.config.waitMinutes} 分钟未选择后自动分析。`}${entry}`
      : phase === 'progress' ? '正在整理上下文并准备建议回复。' : job.error ? `分析未完成：${job.error}${entry}` : `${job.result}\n\n用量：输入 ${job.inputTokens ?? 0} / 输出 ${job.outputTokens ?? 0} tokens`);
    const link = first.link && /^https:\/\/applink\.(feishu\.cn|larksuite\.com)\//.test(first.link) ? `\n原消息：${first.link}` : '';
    // Plain text avoids remote-image fetches or mentions hidden in model markdown.
    await this.call(['im', '+messages-reply', '--as', 'bot', '--message-id', d.replyTo, '--reply-in-thread',
      '--text', text + link, '--idempotency-key', createHash('sha256').update(`${job.id}:${job.attempt ?? 0}:${phase}`).digest('hex').slice(0, 48)]);
  }
}
