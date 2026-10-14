import { readFile, stat } from 'node:fs/promises';
import { writeFileAtomic } from '../platform/atomic-write';
import type { InboxService } from './service';
import type { InboxLark } from './lark';
import type { InboxJob } from './types';
import { obj } from './values';

interface Command { id: string; action: string; target: string; expiresAt: number }
interface Receipt { id: string; ok: boolean; result: string; time: number }
interface Ledger { ownerKey: string; receipts: Record<string, Receipt> }
const uuid = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
const actions = new Set(['browse', 'manual', 'detail', 'process', 'claim', 'ignore']);
export const guiSummary = (job: InboxJob) => ({ id: job.id, name: job.source.name.slice(0, 80),
  chatId: job.source.chatId, type: job.source.type, state: job.state,
  preview: job.messages.at(-1)?.text.slice(0, 80) || '', messageCount: job.messages.length,
  updatedAt: job.updatedAt, dueAt: job.dueAt, automatic: job.automatic, alert: job.alert });

/** Outbound-only connection to the owner-authenticated hosted workbench. */
export class InboxGui {
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private stopped = false;
  private key = '';
  private resultUrl = '';
  private ledger: Ledger;
  private abort = new AbortController();
  lastError?: string;
  constructor(private service: InboxService, private lark: InboxLark, private appId: string,
    private ledgerPath: string, private request: typeof fetch = fetch) {
    this.ledger = { ownerKey: `${service.config.executorProfile}:${service.config.ownerOpenId}`, receipts: {} };
  }
  async start(): Promise<void> {
    const path = this.service.config.gui.apiKeyFile;
    const metadata = await stat(path);
    if (!metadata.isFile() || (metadata.mode & 0o077)) throw new Error('工作台凭证文件必须仅本人可读写');
    this.key = (await readFile(path, 'utf8')).trim();
    if (!this.key || /[\r\n]/.test(this.key)) throw new Error('工作台凭证无效');
    try {
      const saved = JSON.parse(await readFile(this.ledgerPath, 'utf8')) as Ledger;
      if (saved.ownerKey !== this.ledger.ownerKey || !saved.receipts) throw new Error('工作台回执归属不匹配');
      this.ledger = saved;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    this.timer = setInterval(() => this.pulse(), 5000); this.timer.unref();
    this.pulse();
  }
  private pulse(): void {
    if (this.stopped || this.running) return;
    this.running = this.tick().then(() => { this.lastError = undefined; }).catch(error => {
      if (!this.stopped) this.lastError = error instanceof Error ? error.message : '工作台同步失败';
    }).finally(() => { this.running = undefined; });
  }
  async close(): Promise<void> {
    this.stopped = true; clearInterval(this.timer); this.abort.abort(); await this.running;
  }
  private async call(path: string, body: object): Promise<Record<string, unknown>> {
    const base = this.service.config.gui.publicUrl.replace(/\/$/, '');
    const encoded = JSON.stringify(body);
    if (Buffer.byteLength(encoded) > 95000) throw new Error('工作台同步内容过大');
    const response = await this.request(`${base}/openapi/inbox/${path}`, { method: 'POST', redirect: 'error',
      headers: { 'Content-Type': 'application/json', 'X-Api-Key': this.key }, body: encoded,
      signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(20000)]) });
    if (!response.ok) throw new Error(`工作台同步失败（HTTP ${response.status}）`);
    const text = await response.text();
    if (text.length > 200000) throw new Error('工作台响应过大');
    return obj(JSON.parse(text));
  }
  async tick(): Promise<void> {
    if (this.stopped) return;
    const config = this.service.config;
    if (!this.resultUrl) {
      const anchor = await this.lark.call(['im', '+messages-mget', '--as', 'bot', '--message-ids', config.destination.replyTo, '--no-reactions']);
      const messages = Array.isArray(anchor.messages) ? anchor.messages : [];
      const message = messages.map(obj).find(m => m.message_id === config.destination.replyTo &&
        m.chat_id === config.destination.chatId && m.thread_id === config.destination.threadId);
      const link = message?.message_app_link;
      this.resultUrl = typeof link === 'string' && /^https:\/\/applink\.(feishu\.cn|larksuite\.com)\//.test(link) ? link :
        `https://applink.feishu.cn/client/chat/open?openChatId=${config.destination.chatId}`;
    }
    const all = this.service.list(500).filter(j => j.ownerOpenId === config.ownerOpenId);
    const jobs = all.slice(0, 100).map(guiSummary);
    while (Buffer.byteLength(JSON.stringify(jobs)) > 70000) jobs.pop();
    const data = await this.call('sync', { bridgeKey: this.ledger.ownerKey,
      ownerOpenId: config.ownerOpenId, feishuClientId: this.appId,
      snapshot: { jobs, total: all.length, enabled: config.enabled, autoAnalyze: config.autoAnalyze,
        waitMinutes: config.waitMinutes, dailyAutoLimit: config.dailyAutoLimit,
        resultUrl: this.resultUrl,
        error: this.service.lastError?.slice(0, 1000) } });
    if (!Array.isArray(data.commands)) throw new Error('工作台同步响应无效');
    for (const value of data.commands.slice(0, 10)) {
      if (this.stopped) return;
      const c = obj(value);
      if (typeof c.id !== 'string' || !uuid.test(c.id) || typeof c.action !== 'string' ||
        typeof c.target !== 'string' || c.target.length > 16000 || typeof c.expiresAt !== 'number') continue;
      const command: Command = { id: c.id, action: c.action, target: c.target, expiresAt: c.expiresAt };
      let receipt = this.ledger.receipts[command.id];
      if (!receipt) {
        try {
          if (command.expiresAt < Date.now()) throw new Error('操作已过期');
          if (!actions.has(command.action)) throw new Error('不支持的操作');
          receipt = { id: command.id, ok: true, result: JSON.stringify(await this.execute(command)), time: Date.now() };
        } catch (error) { receipt = { id: command.id, ok: false,
          result: error instanceof Error ? error.message.slice(0, 1000) : '操作失败', time: Date.now() }; }
        this.ledger.receipts[command.id] = receipt;
        for (const [id, entry] of Object.entries(this.ledger.receipts)) if (Date.now() - entry.time > 86400000) delete this.ledger.receipts[id];
        await writeFileAtomic(this.ledgerPath, JSON.stringify(this.ledger), { mode: 0o600 });
      }
      await this.call('receipt', { bridgeKey: this.ledger.ownerKey, id: receipt.id, ok: receipt.ok, result: receipt.result });
    }
  }
  private async execute(command: Command): Promise<unknown> {
    if (this.stopped) throw new Error('助理已关闭');
    if (command.action === 'browse') {
      const target = obj(JSON.parse(command.target));
      if ((target.type !== 'p2p' && target.type !== 'group') || typeof target.page !== 'string') throw new Error('无效会话分页');
      await this.lark.checkOwner(this.service.config.ownerOpenId);
      return this.lark.recent(target.type, target.page);
    }
    if (command.action === 'manual') return { id: (await this.service.manual(command.target, command.id)).id };
    const job = this.service.list(500).find(j => j.id === command.target && j.ownerOpenId === this.service.config.ownerOpenId);
    if (!job) throw new Error('待办不存在或已归档');
    if (command.action === 'detail') {
      const sourceUrl = job.messages.find(m => /^https:\/\/applink\.(feishu\.cn|larksuite\.com)\//.test(m.link || ''))?.link ||
        `https://applink.feishu.cn/client/chat/open?openChatId=${job.source.chatId}`;
      return { ...guiSummary(job), result: job.result, error: job.error, sourceUrl,
        messages: job.messages.slice(-5).map(m => ({ name: m.senderName, time: m.time, text: m.text.slice(0, 300) })),
        inputTokens: job.inputTokens, outputTokens: job.outputTokens };
    }
    await this.service.decide(job.id, command.action, this.service.config.ownerOpenId);
    return { id: job.id };
  }
}
