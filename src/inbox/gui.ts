import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { writeFileAtomic } from '../platform/atomic-write';
import type { InboxService } from './service';
import type { InboxLark } from './lark';
import { obj } from './values';
import { guiJobs } from './presentation';
export { guiSummary, guiContent, guiJobs } from './presentation';
import { executeInboxCommand } from './workbench';
import type { InboxTaskSources } from './task-sources';
import { ATTENTION_RULES } from '../monitoring/sources/lark/analyzer';
import { intakeScope, type IntakeScope, type InboxMode } from './config';

interface Command { id: string; action: string; target: string; expiresAt: number }
interface Receipt { id: string; ok: boolean; result: string; time: number }
interface Ledger { ownerKey: string; receipts: Record<string, Receipt> }
const uuid = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
const actions = new Set(['browse', 'manual', 'detail', 'process', 'claim', 'ignore', 'mode', 'review', 'scope', 'batch']);
/** Outbound-only connection to the owner-authenticated hosted workbench. */
export class InboxGui {
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private stopped = false;
  private key = '';
  private compactSync = false;
  private lastPulse = 0;
  private lastSnapshot = '';
  private snapshotAt = 0;
  private resultUrl = '';
  private ledger: Ledger;
  private abort = new AbortController();
  lastError?: string;
  constructor(private service: InboxService, private lark: InboxLark, private appId: string,
    private ledgerPath: string, private request: typeof fetch = fetch,
    private changeMode?: (mode: InboxMode) => Promise<void>,
    private changeScope?: (scope: IntakeScope) => Promise<void>, private taskSources?: InboxTaskSources) {
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
    this.timer = setInterval(() => this.pulse(), 1000); this.timer.unref();
    this.pulse();
  }
  private pulse(): void {
    if (this.stopped || this.running || (!this.compactSync && Date.now() - this.lastPulse < 5000)) return;
    this.lastPulse = Date.now();
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
    if (Buffer.byteLength(encoded) > 950000) throw new Error('工作台同步内容过大');
    const response = await this.request(`${base}/openapi/inbox/${path}`, { method: 'POST', redirect: 'error',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.key}` }, body: encoded,
      signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(20000)]) });
    if (!response.ok) throw new Error(`工作台同步失败（HTTP ${response.status}）`);
    const text = await response.text();
    if (text.length > 900000) throw new Error('工作台响应过大');
    return obj(JSON.parse(text));
  }
  async tick(): Promise<void> {
    if (this.stopped) return;
    const config = this.service.config;
    // The control connection must not wait on a chat-history lookup.
    this.resultUrl = config.deliveryMode === 'new_topic'
      ? `https://applink.feishu.cn/client/chat/open?openChatId=${config.destination.chatId}`
      : `https://applink.feishu.cn/client/thread/open?open_chat_id=${config.destination.chatId}&open_thread_id=${config.destination.threadId}`;
    const data = await this.sync();
    if (!Array.isArray(data.commands)) throw new Error('工作台同步响应无效');
    for (const value of data.commands.slice(0, 10)) {
      if (this.stopped) return;
      const c = obj(value);
      if (typeof c.id !== 'string' || !uuid.test(c.id) || typeof c.action !== 'string' ||
        typeof c.target !== 'string' || c.target.length > 64000 || typeof c.expiresAt !== 'number') continue;
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
      const changed = ['mode', 'review', 'scope', 'batch'].includes(command.action) && receipt.ok;
      if (changed && !this.compactSync) await this.sync();
      const snapshot = changed && this.compactSync ? this.snapshot() : undefined;
      await this.call('receipt', { bridgeKey: this.ledger.ownerKey, id: receipt.id, ok: receipt.ok, result: receipt.result, ...(snapshot ? { snapshot } : {}) });
      // Periodic full sync also repairs an acknowledged-receipt replay after reconnect.
      if (snapshot) { this.lastSnapshot = this.snapshotHash(snapshot); this.snapshotAt = Date.now(); }
      if (command.action === 'mode') return;
    }
  }
  private snapshot() {
    const config = this.service.config;
    const all = [...this.service.list(Infinity), ...(this.taskSources?.list(Infinity) ?? [])].filter(j =>
      j.ownerOpenId === config.ownerOpenId && j.profile === config.executorProfile);
    const jobs = guiJobs(all);
    return { jobs, total: all.length, enabled: config.enabled, autoAnalyze: config.autoAnalyze,
      attentionControl: true, attentionProfile: config.attentionProfile || ATTENTION_RULES, batchControl: true,
      modeControl: Boolean(this.changeMode), draftControl: true, intakeScope: intakeScope(config), scopeControl: Boolean(this.changeScope),
      waitMinutes: config.waitMinutes, dailyAutoLimit: config.dailyAutoLimit,
      resultUrl: this.resultUrl, error: this.service.lastError?.slice(0, 1000) };
  }
  private snapshotHash(snapshot: object): string { return createHash('sha256').update(JSON.stringify(snapshot)).digest('hex'); }
  private async sync(): Promise<Record<string, unknown>> {
    const config = this.service.config;
    const snapshot = this.snapshot(); const hash = this.snapshotHash(snapshot);
    const include = !this.compactSync || hash !== this.lastSnapshot || Date.now() - this.snapshotAt >= 15000;
    try {
      const response = await this.call('sync', { bridgeKey: this.ledger.ownerKey,
        ownerOpenId: config.ownerOpenId, feishuClientId: this.appId, ...(include ? { snapshot } : {}) });
      this.compactSync = response.compactSync === true;
      if (include) { this.lastSnapshot = hash; this.snapshotAt = Date.now(); }
      return response;
    } catch (error) { this.compactSync = false; throw error; }
  }
  private async execute(command: Command): Promise<unknown> {
    if (this.stopped) throw new Error('助理已关闭');
    const source = await this.taskSources?.command(command, { owner: this.service.config.ownerOpenId, profile: this.service.config.executorProfile });
    if (source?.handled) return source.result;
    return executeInboxCommand(this.service, this.lark, command, this.changeMode, this.changeScope);
  }
}
