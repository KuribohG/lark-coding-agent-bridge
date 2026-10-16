import { createHash } from 'node:crypto';
import { larkCliEnv, getUserAuthStatus, type LarkCliExec, type UserImContext } from '../lark-cli/user-im';
import { mergeProcessEnv, spawnProcess } from '../platform/spawn';
import type { InboxConfig } from './config';
import type { InboxJob, InboxMessage } from './types';
import { obj, type Obj } from './values';
import { handlingState } from './reply';

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
      senderId: str(sender.id), senderOpenId: str(sender.open_bot_id) || undefined, senderName: str(sender.name), bot: sender.sender_type !== 'user',
      time, text, threadId: str(m.thread_id) || undefined, parentId: str(m.parent_id) || str(m.reply_to) || undefined,
      position: str(m.message_position) || undefined,
      link: str(m.message_app_link) || undefined, mentions,
      ...(incidentId ? { incidentId, recovered: alert.status === 'resolved' || alert.status === 'recovered' } : {}),
    });
    messages.push(...parseMessages(m.thread_replies, hint));
  }
  return [...new Map(messages.map(m => [m.id, m])).values()];
}

export class InboxLark {
  reminderCard?: (job: InboxJob, text: string) => object;
  private sources = new Map<string, { name: string; type: 'p2p' | 'group'; checkedAt: number }>();
  private abort = new AbortController();
  private exec: LarkCliExec;
  constructor(private ctx: UserImContext, private config: InboxConfig, exec?: LarkCliExec) {
    this.exec = exec ?? ((args, env, timeoutMs) => new Promise((resolve, reject) => {
      if (this.abort.signal.aborted) { reject(new Error('助理已关闭')); return; }
      const child = spawnProcess('lark-cli', args, { env: mergeProcessEnv(process.env, env), stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = ''; let stderr = ''; let bytes = 0; let timedOut = false;
      const kill = () => { child.kill('SIGKILL'); };
      const signal = this.abort.signal;
      signal.addEventListener('abort', kill, { once: true });
      const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
      const append = (data: Buffer, error: boolean) => { bytes += data.length; if (bytes > 8_000_000) { kill(); return; } if (error) stderr += data.toString(); else stdout += data.toString(); };
      child.stdout?.on('data', (data: Buffer) => append(data, false)); child.stderr?.on('data', (data: Buffer) => append(data, true));
      const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', kill); };
      child.once('error', () => { cleanup(); reject(new Error('无法启动当前 profile 的 lark-cli')); });
      child.once('close', code => { cleanup(); resolve({ code, stdout, stderr, timedOut }); });
    }));
  }
  close(): void { this.abort.abort(); }
  cancelPending(): void { this.abort.abort(); this.abort = new AbortController(); }
  async call(args: string[]): Promise<Obj> {
    return obj(await this.callValue(args));
  }
  async callValue(args: string[]): Promise<unknown> {
    this.abort.signal.throwIfAborted();
    const r = await this.exec([...args, '--json'], { ...larkCliEnv(this.ctx), TZ: 'Asia/Shanghai' }, 60_000);
    this.abort.signal.throwIfAborted();
    if (r.timedOut) throw new Error('飞书读取超时');
    if (r.code !== 0 && /lark-channel context detected[^\n]*not[^\n]*bound/i.test(r.stderr + '\n' + r.stdout)) {
      throw new Error('当前 bridge 未绑定，请重启 bridge 或运行 doctor/preflight');
    }
    let envelope: Obj;
    try { envelope = obj(JSON.parse(r.stdout)); } catch { throw new Error('飞书读取响应无效'); }
    if (r.code !== 0 || r.timedOut || envelope.ok !== true) throw new Error('飞书接口失败，请检查当前 profile 的权限；未自动切换身份');
    return envelope.data;
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
  async collect(kind: 'p2p' | 'mention' | 'group', start: number, end: number): Promise<InboxMessage[]> {
    const raw = await this.pages(['im', '+messages-search', '--as', 'user', '--start', iso(start), '--end', iso(end),
      '--page-size', '50', '--no-reactions', ...(kind === 'mention' ? ['--is-at-me'] : ['--chat-type', kind])], 'messages');
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
  async recent(type: 'p2p' | 'group', pageToken = ''): Promise<{ chats: { id: string; name: string }[]; next: string }> {
    await this.checkOwner(this.config.ownerOpenId);
    const d = await this.call(['im', '+chat-list', '--as', 'user', '--types', type, '--sort', 'active_time', '--page-size', '8',
      ...(pageToken ? ['--page-token', pageToken] : [])]);
    const chats = (Array.isArray(d.chats) ? d.chats : []).map(v => ({ id: str(obj(v).chat_id), name: str(obj(v).name) }))
      .filter(c => /^oc_\w+$/.test(c.id) && c.name && c.id !== this.config.destination.chatId);
    for (const c of chats) this.sources.set(c.id, { name: c.name, type, checkedAt: Date.now() });
    if (d.has_more && (!str(d.page_token) || d.page_token === pageToken)) throw new Error('会话分页未完成，请重新打开列表');
    return { chats, next: d.has_more ? str(d.page_token) : '' };
  }
  async source(chatId: string): Promise<{ name: string; type: 'p2p' | 'group' }> {
    if (!/^oc_\w+$/.test(chatId)) throw new Error('invalid chat ID');
    const cached = this.sources.get(chatId);
    if (cached && Date.now() - cached.checkedAt < 5 * 60_000) return cached;
    // Membership is verified against the user's own conversation list, not a client payload.
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
  async beginAnalysis(job: InboxJob, text: string): Promise<InboxConfig['destination']> {
    if (!this.config.enabled || job.ownerOpenId !== this.config.ownerOpenId || handlingState(job) !== 'open' ||
      JSON.stringify(job.destination) !== JSON.stringify(this.config.destination)) throw new Error('分析通知已失效');
    const key = createHash('sha256').update(`inbox-start:${job.id}:${job.startDelivery?.id}`).digest('hex').slice(0, 48);
    if (job.analysisTopic || this.config.deliveryMode === 'thread') {
      const target = job.analysisTopic ?? this.config.destination;
      if (target.chatId !== this.config.destination.chatId) throw new Error('分析话题目标已变更');
      await this.replyAt(target, { text }, key);
      return { ...target };
    }
    const response = await this.sendNewTopic({ text }, key);
    const message = obj(response.message ?? response);
    const replyTo = str(message.message_id);
    if (!/^om_\w+$/.test(replyTo)) throw new Error('无法确认新建话题消息');
    // Read the server's topic ID rather than deriving one from a message ID.
    const anchor = await this.call(['im', '+messages-mget', '--as', 'bot', '--message-ids', replyTo, '--no-reactions']);
    const root = parseMessages(anchor.messages).find(m => m.id === replyTo && m.chatId === this.config.destination.chatId);
    if (!root?.threadId || !/^omt_\w+$/.test(root.threadId)) throw new Error('无法确认新建话题位置');
    return { chatId: root.chatId, replyTo, threadId: root.threadId };
  }
  async progressAnchor(job: InboxJob, signal: AbortSignal): Promise<string> {
    const target = job.analysisTopic;
    if (!this.config.enabled || signal.aborted || !target || job.ownerOpenId !== this.config.ownerOpenId ||
      handlingState(job) !== 'open' || target.chatId !== this.config.destination.chatId ||
      JSON.stringify(job.destination) !== JSON.stringify(this.config.destination)) throw new Error('分析进度目标已失效');
    const key = createHash('sha256').update(`inbox-progress:${job.id}:${job.attempt ?? 0}`).digest('hex').slice(0, 48);
    // CoT attached to a topic root may appear at chat level; create an in-topic origin.
    const response = await this.replyAt(target, { text: '正在深入分析，进度会在本话题更新。' }, key, signal);
    signal.throwIfAborted();
    const id = str(obj(response.message ?? response).message_id);
    if (!/^om_\w+$/.test(id) || id === target.replyTo) throw new Error('无法确认进度回复');
    const anchor = await this.call(['im', '+messages-mget', '--as', 'bot', '--message-ids', id, '--no-reactions']);
    signal.throwIfAborted();
    if (!parseMessages(anchor.messages).some(m => m.id === id && m.chatId === target.chatId && m.threadId === target.threadId)) {
      throw new Error('无法确认进度话题');
    }
    return id;
  }
  async deliver(job: InboxJob, phase: 'pending' | 'progress' | 'result'): Promise<void> {
    const d = job.destination;
    if (job.ownerOpenId !== this.config.ownerOpenId || JSON.stringify(d) !== JSON.stringify(this.config.destination)) throw new Error('结果目标已变更，请重新处理待办');
    if (phase !== 'result' || !this.config.enabled || handlingState(job) !== 'open' || (job.draftStale && !job.error) ||
      (!job.analysisTopic && (this.config.gui.publicUrl || job.attention?.state !== 'needed'))) return;
    if (job.analysisTopic && job.analysisTopic.chatId !== d.chatId) throw new Error('分析话题目标已变更');
    const escape = (s: string) => s.replace(/[\r\n]/g, ' ').replace(/[<>`*_\[\]]/g, '');
    const first = job.messages[0]!;
    const header = `分析结果 · ${escape(job.source.name)}\n`;
    const page = this.config.gui.publicUrl || this.config.h5.publicUrl;
    const entry = page ? `\n打开会话助理：${page}#job=${job.id}` : '';
    const text = header + '\n' + (job.error ? `分析未完成：${job.error}${entry}` :
      `回复草稿（供你确认后发送）：\n${job.replyDraft || '暂时无法起草，请查看下方待确认信息。'}\n\n分析结果：\n${job.analysis || job.result || ''}\n\n待确认：${job.missingInfo || '无'}${entry}`);
    const link = first.link && /^https:\/\/applink\.(feishu\.cn|larksuite\.com)\//.test(first.link) ? `\n原消息：${first.link}` : '';
    const key = createHash('sha256').update(`${job.id}:${job.attempt ?? 0}:${phase}${this.config.deliveryMode === 'new_topic' ? `:new_topic:${d.chatId}` : ''}`).digest('hex').slice(0, 48);
    const publish = (body: { text?: string; card?: object }) => job.analysisTopic ? this.replyAt(job.analysisTopic, body, key) : this.config.deliveryMode === 'new_topic'
      ? this.sendNewTopic(body, key) : this.replyTopic(body, key);
    await publish({ text: text + link });
  }
  async notifyAttention(jobs: InboxJob[], id: string): Promise<void> {
    if (!this.config.enabled || !jobs.length || jobs.some(j => j.ownerOpenId !== this.config.ownerOpenId ||
      j.attention?.state !== 'needed' || j.handlingState === 'handled' || j.handlingState === 'ignored' ||
      JSON.stringify(j.destination) !== JSON.stringify(this.config.destination))) throw new Error('关注通知已失效');
    const clean = (s: string) => s.replace(/[\r\n]/g, ' ').replace(/<\/?at\b[^>]*>/gi, '').slice(0, 180);
    if (this.config.deliveryMode === 'new_topic') {
      for (const job of jobs) {
        const source = [...job.messages].reverse().find(m => /^https:\/\/applink\.(feishu\.cn|larksuite\.com)\//.test(m.link || ''))?.link;
        const text = `待处理 · ${clean(job.source.name)}\n${clean(job.attention!.reason)}` +
          (source ? `\n原消息：${source}` : '') +
          `\n查看与处理：${this.config.gui.publicUrl || this.config.h5.publicUrl}#job=${job.id}`;
        const key = createHash('sha256').update(`attention:${id}:${job.id}:${this.config.destination.chatId}`).digest('hex').slice(0, 48);
        await this.sendNewTopic({ text }, key);
      }
      return;
    }
    const text = `有 ${jobs.length} 项新事项需要你关注：\n` + jobs.map((j, i) => `${i + 1}. ${clean(j.source.name)}：${clean(j.attention!.reason)}`).join('\n') +
      `\n在工作台查看、批量处理或深入分析：${this.config.gui.publicUrl || this.config.h5.publicUrl}`;
    const key = createHash('sha256').update(`attention:${id}`).digest('hex').slice(0, 48);
    await this.replyTopic({ text }, key);
  }
  private async sendNewTopic(body: { text?: string; card?: object }, key: string): Promise<Obj> {
    const chatId = this.config.destination.chatId;
    const chat = await this.call(['im', 'chats', 'get', '--as', 'bot', '--chat-id', chatId]);
    if (chat.chat_mode !== 'topic') throw new Error('结果群不是话题群，停止新建话题');
    return this.call(['im', '+messages-send', '--as', 'bot', '--chat-id', chatId,
      ...(body.card ? ['--msg-type', 'interactive', '--content', JSON.stringify(body.card)] : ['--text', (body.text ?? '').replace(/<\/?at\b[^>]*>/gi, '')]),
      '--idempotency-key', key]);
  }
  async replyTopic(body: { text?: string; card?: object }, key?: string): Promise<void> {
    await this.replyAt(this.config.destination, body, key);
  }
  async replyMenu(card: object, messageId: string, threadId: string): Promise<void> {
    if (!/^om_\w+$/.test(messageId) || !/^omt_\w+$/.test(threadId)) throw new Error('无法确认入口所在话题，请在群话题中重新发送 /inbox');
    await this.replyAt({ chatId: this.config.destination.chatId, replyTo: messageId, threadId }, { card });
  }
  private async replyAt(d: InboxConfig['destination'], body: { text?: string; card?: object }, key?: string, signal?: AbortSignal): Promise<Obj> {
    const anchor = await this.call(['im', '+messages-mget', '--as', 'bot', '--message-ids', d.replyTo, '--no-reactions']);
    const messages = parseMessages(anchor.messages);
    if (!messages.some(m => m.id === d.replyTo && m.chatId === d.chatId && m.threadId === d.threadId)) throw new Error('无法验证回复话题，停止投递');
    signal?.throwIfAborted();
    // Model results use plain text; native cards render source names as plain_text too.
    return this.call(['im', '+messages-reply', '--as', 'bot', '--message-id', d.replyTo, '--reply-in-thread',
      ...(body.card ? ['--msg-type', 'interactive', '--content', JSON.stringify(body.card)] : ['--text', (body.text ?? '').replace(/<\/?at\b[^>]*>/gi, '')]),
      ...(key ? ['--idempotency-key', key] : [])]);
  }
}
