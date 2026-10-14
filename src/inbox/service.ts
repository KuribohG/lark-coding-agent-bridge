import { randomUUID } from 'node:crypto';
import type { InboxConfig } from './config';
import { InboxStore } from './store';
import type { InboxIO, InboxJob, InboxMessage } from './types';

const terminal = new Set(['done', 'ignored', 'claimed', 'failed']);
export function compareMessages(a: InboxMessage, b: InboxMessage): number {
  if (a.chatId === b.chatId && /^\d+$/.test(a.position ?? '') && /^\d+$/.test(b.position ?? '')) {
    return BigInt(a.position!) < BigInt(b.position!) ? -1 : BigInt(a.position!) > BigInt(b.position!) ? 1 : 0;
  }
  return a.time - b.time;
}
export function classifyMessage(m: InboxMessage): 'skip' | 'alert' | 'request' {
  const text = m.text.trim();
  if (!text || /^(收到|谢谢|好的|好|嗯|OK|ok|Thanks|👍|👌)[。！!\s]*$/i.test(text)) return 'skip';
  return m.bot || /报警|告警|alert|firing|resolved/i.test(text) ? 'alert' : 'request';
}

export function boundMessages(messages: InboxMessage[], maxChars: number): InboxMessage[] {
  const output: InboxMessage[] = [];
  let remaining = maxChars;
  for (const m of [...messages].sort((a, b) => compareMessages(b, a))) {
    if (remaining <= 0 || output.length >= 100) break;
    const text = m.text.slice(0, remaining);
    output.push({ ...m, text }); remaining -= text.length + 200;
  }
  return output.reverse();
}

/** All state transitions are serialized. Model execution happens outside the lock. */
export class InboxService {
  private chain: Promise<unknown> = Promise.resolve();
  private timer?: NodeJS.Timeout;
  private controller?: AbortController;
  private running?: Promise<void>;
  private stopped = false;
  private lastPoll = 0;
  lastError?: string;
  constructor(readonly store: InboxStore, readonly config: InboxConfig, private io: InboxIO, private now = Date.now) {}
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.chain.then(fn); this.chain = p.catch(() => {}); return p;
  }
  async start(): Promise<void> {
    await this.io.checkOwner(this.config.ownerOpenId);
    await this.store.load();
    const key = `${this.config.executorProfile}:${this.config.ownerOpenId}`;
    if (this.store.data.ownerKey && this.store.data.ownerKey !== key) throw new Error('待办归属已改变，请为新账号使用独立状态目录');
    this.store.data.ownerKey = key;
    for (const kind of ['p2p', 'mention']) this.store.data.cursors[kind] ??= this.now();
    await this.store.save();
    this.timer = setInterval(() => void this.tick().catch(() => {}), 5000);
    this.timer.unref();
  }
  async close(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    this.controller?.abort();
    this.io.cancel?.();
    await this.running;
    await this.chain;
  }
  list(): InboxJob[] {
    const jobs = structuredClone(this.store.data.jobs).reverse();
    return [...jobs.filter(j => !terminal.has(j.state)), ...jobs.filter(j => terminal.has(j.state))].slice(0, 100);
  }
  async manual(chatId: string): Promise<InboxJob> {
    if (!/^oc_\w+$/.test(chatId)) throw new Error('invalid chat ID');
    return this.serial(async () => {
      this.assertEnabled();
      await this.io.checkOwner(this.config.ownerOpenId);
      const source = await this.io.source(chatId);
      let messages = await this.io.context(chatId, this.now() - this.config.contextMinutes * 60_000, this.now());
      if (!messages.length && !this.stopped) messages = await this.io.context(chatId, this.now() - 86400_000, this.now());
      this.assertEnabled();
      if (!messages.length) throw new Error('最近一天没有可读取的消息');
      messages = boundMessages(messages, this.config.maxContextChars);
      const ids = messages.map(m => m.id).sort().join(',');
      const submitted = this.store.data.jobs.find(j => j.source.chatId === chatId && ['running', 'ready', 'done', 'queued'].includes(j.state) &&
        j.manualSignature === ids && this.now() - j.updatedAt < 30 * 60_000);
      if (submitted) return structuredClone(submitted);
      const existing = this.store.data.jobs.find(j => j.source.chatId === chatId && ['waiting', 'notifying', 'queued'].includes(j.state));
      const job = existing ?? this.create(messages, false, source);
      job.messages = boundMessages(messages, this.config.maxContextChars);
      job.source.threadId = undefined;
      job.destination = { ...this.config.destination };
      job.manualSignature = ids;
      job.automatic = false; job.state = 'queued'; job.updatedAt = this.now();
      await this.store.save();
      return structuredClone(job);
    });
  }
  async decide(id: string, action: string, owner: string): Promise<void> {
    if (owner !== this.config.ownerOpenId) throw new Error('forbidden');
    await this.serial(async () => {
      this.assertEnabled();
      const job = this.store.data.jobs.find(j => j.id === id);
      if (!job || job.ownerOpenId !== owner) throw new Error('unknown job');
      if (!['process', 'claim', 'ignore'].includes(action)) throw new Error('invalid action');
      if (['done', 'ignored', 'claimed'].includes(job.state)) return;
      if (action === 'process') {
        if (['running', 'ready', 'queued'].includes(job.state)) return;
        job.state = 'queued'; job.automatic = false;
        job.error = undefined; job.result = undefined; job.deliveredAt = undefined;
        job.destination = { ...this.config.destination };
      } else {
        if (job.state === 'running') this.controller?.abort();
        job.state = action === 'claim' ? 'claimed' : 'ignored';
      }
      job.updatedAt = this.now(); await this.store.save();
    });
  }
  async tick(): Promise<void> {
    await this.serial(async () => {
      if (this.stopped || !this.config.enabled) return;
      try {
        const now = this.now();
        if (now - this.lastPoll >= this.config.pollSeconds * 1000) {
          this.lastPoll = now;
          await this.io.checkOwner(this.config.ownerOpenId);
          for (const kind of ['p2p', 'mention'] as const) {
            if (kind === 'p2p' ? !this.config.watchPrivate : !this.config.watchMentions) continue;
            const start = this.store.data.cursors[kind] ?? now;
            // Search indexing can lag. IDs, rather than timestamps, deduplicate overlap.
            const messages = await this.io.collect(kind, start - 300_000, now);
            if (this.stopped) return;
            for (const m of messages.sort(compareMessages)) this.ingest(m, start - 300_000);
            this.store.data.cursors[kind] = now;
            await this.store.save();
          }
          // Replies/recovery often do not mention the owner. Check active sources too.
          const activeSources = new Map<string, InboxJob>();
          for (const job of this.store.data.jobs) if (['notifying', 'waiting', 'queued'].includes(job.state)) activeSources.set(job.source.chatId, job);
          for (const [chatId, job] of [...activeSources].sort((a, b) => (this.store.data.cursors[`context:${a[0]}`] ?? 0) - (this.store.data.cursors[`context:${b[0]}`] ?? 0)).slice(0, 10)) {
            const key = `context:${chatId}`;
            const since = this.store.data.cursors[key] ?? job.messages[0]!.time;
            if (now - since < 60_000) continue;
            const context = await this.io.context(chatId, since - 60_000, now);
            if (this.stopped) return;
            for (const m of context.sort(compareMessages)) this.ingest(m, since - 60_000);
            this.store.data.cursors[key] = now;
          }
        }
        for (const job of this.store.data.jobs) {
          if (this.stopped) return;
          if ((job.retryAt ?? 0) > now) continue;
          if (job.state === 'notifying' && (now - job.updatedAt >= 60_000 || now - job.createdAt >= 120_000)) {
            job.retryAt = now + 60_000; await this.store.save();
            await this.io.deliver(job, 'pending');
            job.notifiedAt = this.now(); job.dueAt = job.notifiedAt + this.config.waitMinutes * 60_000;
            job.state = 'waiting'; job.retryAt = undefined; await this.store.save();
          }
          if (job.state === 'ready' || (job.state === 'failed' && !job.deliveredAt)) {
            if (job.state === 'ready' && job.automatic && await this.ownerReplied(job)) {
              job.state = 'claimed'; job.updatedAt = now; await this.store.save(); continue;
            }
            if (this.stopped) return;
            job.retryAt = now + 60_000; await this.store.save();
            await this.io.deliver(job, 'result');
            if (job.state === 'ready') job.state = 'done';
            job.deliveredAt = this.now(); job.retryAt = undefined; await this.store.save();
          }
          if (job.state === 'waiting' && this.config.autoAnalyze && !job.alert && job.dueAt! <= now) {
            const day = new Date(now).toISOString().slice(0, 10);
            if ((this.store.data.autoUsage[day] ?? 0) < this.config.dailyAutoLimit) { job.state = 'queued'; job.automatic = true; }
          }
        }
        // Keep durable state bounded; retain active jobs regardless of age.
        this.store.data.jobs = this.store.data.jobs.filter(j => !terminal.has(j.state) || now - j.updatedAt < 7 * 86400_000);
        for (const [id, time] of Object.entries(this.store.data.seen)) if (now - time > 2 * 86400_000) delete this.store.data.seen[id];
        await this.store.save();
        this.lastError = undefined;
      } catch (e) { this.lastError = e instanceof Error ? e.message : 'inbox poll failed'; }
      if (!this.running && !this.stopped) {
        const next = this.store.data.jobs.find(j => j.state === 'queued');
        if (next) {
          const day = new Date(this.now()).toISOString().slice(0, 10);
          if (next.automatic && (this.store.data.autoUsage[day] ?? 0) >= this.config.dailyAutoLimit) { next.state = 'waiting'; return; }
          if (next.automatic) this.store.data.autoUsage[day] = (this.store.data.autoUsage[day] ?? 0) + 1;
          next.state = 'running'; next.attempt = (next.attempt ?? 0) + 1; await this.store.save();
          if (this.stopped) { next.state = 'queued'; await this.store.save(); return; }
          this.controller = new AbortController();
          this.running = this.run(next, this.controller.signal).catch(() => { this.lastError = '待办状态保存失败，停止自动任务'; this.stopped = true; }).finally(() => { this.running = undefined; this.controller = undefined; });
        }
      }
    });
  }
  private assertEnabled(): void { if (this.stopped || !this.config.enabled) throw new Error('助理已关闭'); }
  private create(messages: InboxMessage[], automatic: boolean, source?: { name: string; type: 'p2p' | 'group' }): InboxJob {
    if (this.store.data.jobs.filter(j => !terminal.has(j.state)).length >= 500) throw new Error('待办已达 500 项，暂停采集，请先处理或忽略已有待办');
    const m = messages[0]!;
    const job: InboxJob = { id: randomUUID(), ownerOpenId: this.config.ownerOpenId, profile: this.config.executorProfile,
      destination: { ...this.config.destination }, source: { chatId: m.chatId, name: source?.name || m.chatName, type: source?.type || m.chatType, threadId: m.threadId },
      messages: boundMessages(messages, this.config.maxContextChars), state: automatic ? 'notifying' : 'queued',
      createdAt: this.now(), updatedAt: this.now(), automatic, alert: messages.some(m => classifyMessage(m) === 'alert'), incidentId: m.incidentId };
    this.store.data.jobs.push(job); return job;
  }
  private ingest(m: InboxMessage, earliest: number): void {
    if (this.store.data.seen[m.id] || m.time < earliest || m.chatId === this.config.destination.chatId) return;
    this.store.data.seen[m.id] = this.now();
    try { this.ingestNew(m); }
    catch (error) { delete this.store.data.seen[m.id]; throw error; }
  }
  private ingestNew(m: InboxMessage): void {
    const jobs = this.store.data.jobs.filter(j => j.source.chatId === m.chatId && ['waiting', 'notifying', 'queued'].includes(j.state));
    if (m.senderId === this.config.ownerOpenId) {
      for (const job of jobs) if (job.automatic && compareMessages(m, job.messages.at(-1)!) > 0 && (m.chatType === 'p2p' ||
        (m.threadId && m.threadId === job.source.threadId) || job.messages.some(x => x.id === m.parentId))) job.state = 'claimed';
      return;
    }
    if (m.recovered && m.incidentId && m.bot) {
      for (const job of jobs) if (job.incidentId === m.incidentId && job.messages[0]?.senderId === m.senderId) job.state = 'ignored';
      return;
    }
    if (m.chatType === 'group' && !m.mentions.includes(this.config.ownerOpenId)) return;
    const category = classifyMessage(m);
    if (category === 'skip' || (m.chatType === 'p2p' && m.bot)) return;
    const previous = jobs.find(j => j.source.threadId === m.threadId && (m.incidentId ? j.incidentId === m.incidentId && j.messages[0]?.senderId === m.senderId : !j.incidentId && this.now() - j.updatedAt < 5 * 60_000));
    if (previous) {
      if (!previous.messages.some(x => x.text === m.text)) previous.messages = boundMessages([...previous.messages, m], this.config.maxContextChars);
      previous.alert ||= category === 'alert'; previous.updatedAt = this.now();
    } else this.create([m], true);
  }
  private async ownerReplied(job: InboxJob): Promise<boolean> {
    const context = await this.io.context(job.source.chatId, job.messages.at(-1)!.time, this.now());
    return context.some(m => m.senderId === job.ownerOpenId && compareMessages(m, job.messages.at(-1)!) > 0 &&
      (job.source.type === 'p2p' || (job.source.threadId && m.threadId === job.source.threadId) || job.messages.some(x => x.id === m.parentId)));
  }
  private async run(job: InboxJob, signal: AbortSignal): Promise<void> {
    try {
      await this.io.checkOwner(this.config.ownerOpenId);
      const context = await this.io.context(job.source.chatId, job.messages[0]!.time - this.config.contextMinutes * 60_000, this.now());
      const relevant = job.source.threadId ? context.filter(m => m.threadId === job.source.threadId) : context;
      if (job.automatic && relevant.some(m => m.senderId === this.config.ownerOpenId && compareMessages(m, job.messages.at(-1)!) > 0 &&
        (job.source.type === 'p2p' || Boolean(job.source.threadId) || job.messages.some(x => x.id === m.parentId)))) {
        await this.serial(async () => { if (job.state === 'running') job.state = 'claimed'; await this.store.save(); }); return;
      }
      if (signal.aborted) throw new Error('分析已取消');
      job.messages = boundMessages([...new Map([...job.messages, ...relevant].map(m => [m.id, m])).values()], this.config.maxContextChars);
      await this.io.deliver(job, 'progress');
      const result = await this.io.analyze(structuredClone(job), signal);
      await this.serial(async () => {
        job.inputTokens = result.inputTokens; job.outputTokens = result.outputTokens;
        if (job.state === 'running' && !signal.aborted) { job.result = result.text.slice(0, 20_000); job.state = 'ready'; }
        else if (job.state === 'running') { job.state = 'failed'; job.error = '分析已取消'; }
        job.updatedAt = this.now(); await this.store.save();
      });
    } catch (e) {
      await this.serial(async () => {
        if (job.state === 'running') { job.state = 'failed'; job.error = e instanceof Error ? e.message : '分析失败'; }
        job.updatedAt = this.now(); await this.store.save();
      });
    }
  }
}
