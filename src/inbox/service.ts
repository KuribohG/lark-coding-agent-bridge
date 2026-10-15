import { createHash, randomUUID } from 'node:crypto';
import { inboxMode, intakeScope, type IntakeScope, type InboxConfig, type InboxMode } from './config';
import { InboxStore } from './store';
import { handlingState, replyContent, resultText } from './reply';
import type { InboxIO, InboxJob, InboxMessage } from './types';

const signature = (job: InboxJob) => createHash('sha256').update(JSON.stringify(job.messages)).digest('hex');
const resolved = (job: InboxJob) => handlingState(job) !== 'open';
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
  private modeChanges = 0;
  private lastPoll = 0;
  lastError?: string;
  constructor(readonly store: InboxStore, readonly config: InboxConfig, private io: InboxIO, private now = Date.now) {}
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.chain.then(fn); this.chain = p.catch(() => {}); return p;
  }
  async start(): Promise<void> {
    if (this.config.enabled) await this.io.checkOwner(this.config.ownerOpenId);
    await this.store.load();
    const key = `${this.config.executorProfile}:${this.config.ownerOpenId}`;
    if (this.store.data.ownerKey && this.store.data.ownerKey !== key) throw new Error('待办归属已改变，请为新账号使用独立状态目录');
    this.store.data.ownerKey = key;
    for (const kind of ['p2p', 'mention', 'group']) this.store.data.cursors[kind] ??= this.now();
    await this.setMode(inboxMode(this.config));
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
  list(limit = 100): InboxJob[] {
    const jobs = structuredClone(this.store.data.jobs).reverse();
    return [...jobs.filter(j => !resolved(j) && j.attention?.state === 'needed'),
      ...jobs.filter(j => !resolved(j) && j.attention?.state !== 'needed' && j.attention?.state !== 'quiet'),
      ...jobs.filter(j => !resolved(j) && j.attention?.state === 'quiet'), ...jobs.filter(resolved)].slice(0, limit);
  }
  async setMode(mode: InboxMode, persist?: () => Promise<void>): Promise<void> {
    if (!['off', 'on'].includes(mode)) throw new Error('无效运行模式');
    this.modeChanges++;
    if (mode === 'off') { this.controller?.abort(); this.io.cancelPending?.(); }
    try {
      await this.serial(async () => {
        if (this.stopped) throw new Error('助理连接已关闭');
        await persist?.();
        const previous = inboxMode(this.config);
        this.config.enabled = mode === 'on'; this.config.autoAnalyze = false;
        for (const job of this.store.data.jobs) {
          job.dueAt = undefined;
          job.attention ??= { state: 'pending', reason: '等待关注筛选' };
          if (job.state === 'notifying' || (['queued', 'running'].includes(job.state) && (mode === 'off' || !job.analysisRequested))) {
            job.state = 'waiting'; job.analysisRequested = false;
          }
          if (mode === 'off') job.analysisRequested = false;
        }
        if (previous === 'off' && mode === 'on') {
          for (const kind of Object.keys(this.store.data.cursors)) this.store.data.cursors[kind] = this.now();
          this.store.data.cursors.intakeSince = this.now(); this.lastPoll = 0;
        }
        await this.store.save();
      });
    } finally { this.modeChanges--; }
  }
  private acceptsSource(job: InboxJob): boolean {
    return job.source.type === 'p2p' ? this.config.watchPrivate : this.config.watchMentions &&
      (intakeScope(this.config) === 'all' || job.intakeTrigger === 'mention' || job.messages.some(m => m.mentions.includes(this.config.ownerOpenId)));
  }
  async setScope(scope: IntakeScope, persist?: () => Promise<void>): Promise<void> {
    if (!['private', 'private_mentions', 'all'].includes(scope)) throw new Error('无效接收范围');
    this.modeChanges++;
    this.controller?.abort();
    this.io.cancelPending?.();
    try {
      await this.serial(async () => {
        if (this.stopped) throw new Error('助理连接已关闭');
        await persist?.();
        this.config.intakeScope = scope;
        this.config.watchPrivate = true; this.config.watchMentions = scope !== 'private';
        // New scopes start now; the indexing overlap must not backfill old conversations.
        for (const key of Object.keys(this.store.data.cursors)) this.store.data.cursors[key] = this.now();
        this.store.data.cursors.intakeSince = this.now(); this.lastPoll = 0;
        for (const job of this.store.data.jobs) {
          if (job.automatic && (!this.acceptsSource(job) || job.state === 'running')) {
            job.automatic = false; job.dueAt = undefined;
            if (['queued', 'running', 'notifying'].includes(job.state)) job.state = 'waiting';
            job.error = '接收范围已更新，已有事项可手动处理'; this.touch(job);
          }
        }
        await this.store.save();
      });
    } finally { this.modeChanges--; }
  }
  async manual(chatId: string, requestId?: string): Promise<InboxJob> {
    if (!/^oc_\w+$/.test(chatId)) throw new Error('invalid chat ID');
    return this.serial(async () => {
      this.assertEnabled();
      const replay = requestId && this.store.data.jobs.find(j => j.manualRequestId === requestId || j.manualRequestIds?.includes(requestId));
      if (replay) {
        if (replay.source.chatId !== chatId) throw new Error('request ID already used');
        return structuredClone(replay);
      }
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
      if (submitted) {
        if (submitted.state === 'queued') submitted.automatic = false;
        if (requestId) {
          submitted.manualRequestIds = [...(submitted.manualRequestIds || []), requestId].slice(-100);
          await this.store.save();
        }
        return structuredClone(submitted);
      }
      const existing = this.store.data.jobs.find(j => j.source.chatId === chatId && ['waiting', 'notifying', 'queued'].includes(j.state));
      const job = existing ?? this.create(messages, false, source);
      job.messages = boundMessages(messages, this.config.maxContextChars);
      job.source.threadId = undefined;
      job.destination = { ...this.config.destination };
      job.manualSignature = ids;
      if (requestId) job.manualRequestIds = [...(job.manualRequestIds || []), requestId].slice(-100);
      job.automatic = false; job.analysisRequested = true; job.notificationSuppressed = true;
      job.attention = { state: 'needed', reason: '你主动选择了此会话' }; job.state = 'queued'; this.touch(job);
      job.draftStale = Boolean(job.result || job.replyDraft);
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
      if (resolved(job)) return;
      if (action === 'process') {
        if (job.state === 'running') return;
        if (job.state === 'queued') { job.automatic = false; job.analysisRequested = true; await this.store.save(); return; }
        job.state = 'queued'; job.automatic = false; job.analysisRequested = true;
        job.error = undefined; job.deliveredAt = undefined;
        job.draftStale = Boolean(job.result || job.replyDraft);
        job.destination = { ...this.config.destination };
      } else {
        if (job.state === 'running') this.controller?.abort();
        job.state = action === 'claim' ? 'claimed' : 'ignored';
        job.handlingState = action === 'claim' ? 'handled' : 'ignored';
      }
      this.touch(job); await this.store.save();
    });
  }
  private touch(job: InboxJob): void { job.revision = (job.revision ?? 0) + 1; job.updatedAt = this.now(); }
  async review(value: unknown, owner: string, requestId: string): Promise<InboxJob> {
    if (owner !== this.config.ownerOpenId) throw new Error('forbidden');
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('无效草稿操作');
    const input = value as Record<string, unknown>;
    if (typeof input.id !== 'string' || !Number.isSafeInteger(input.revision) || Number(input.revision) < 0 ||
      (input.replyDraft === undefined && input.handlingState === undefined) ||
      (input.replyDraft !== undefined && (typeof input.replyDraft !== 'string' || input.replyDraft.length > 6000)) ||
      (input.handlingState !== undefined && !['open', 'handled', 'ignored'].includes(String(input.handlingState)))) throw new Error('无效草稿操作');
    return this.serial(async () => {
      if (this.stopped) throw new Error('助理连接已关闭');
      const job = this.store.data.jobs.find(j => j.id === input.id && j.ownerOpenId === owner);
      if (!job) throw new Error('待办不存在或已归档');
      if (job.lastReviewRequestId === requestId) return structuredClone(job);
      if ((job.revision ?? 0) !== input.revision) throw new Error('事项已更新，草稿未覆盖，请核对最新内容后重试');
      const before = structuredClone(job);
      if (job.state === 'running') this.controller?.abort();
      if (['notifying', 'queued', 'running', 'ready'].includes(job.state)) job.state = 'waiting';
      job.automatic = false; job.analysisRequested = false; job.dueAt = undefined;
      if (input.replyDraft !== undefined) { job.replyDraft = input.replyDraft as string; job.draftEdited = true; job.draftStale = false; }
      if (input.handlingState !== undefined) job.handlingState = input.handlingState as InboxJob['handlingState'];
      if (input.handlingState === 'open' && ['claimed', 'ignored'].includes(job.state)) job.state = job.result ? 'done' : 'waiting';
      job.lastReviewRequestId = requestId; this.touch(job);
      try { await this.store.save(); }
      catch (error) {
        for (const key of Object.keys(job)) delete (job as unknown as Record<string, unknown>)[key];
        Object.assign(job, before); throw error;
      }
      return structuredClone(job);
    });
  }
  async tick(): Promise<void> {
    await this.serial(async () => {
      if (this.blocked()) return;
      try {
        const now = this.now();
        if (now - this.lastPoll >= this.config.pollSeconds * 1000) {
          this.lastPoll = now;
          await this.io.checkOwner(this.config.ownerOpenId);
          for (const kind of ['p2p', 'mention', 'group'] as const) {
            if (this.blocked()) return;
            if (kind === 'p2p' ? !this.config.watchPrivate : kind === 'group' ? intakeScope(this.config) !== 'all' : !this.config.watchMentions || intakeScope(this.config) === 'all') continue;
            const start = this.store.data.cursors[kind] ?? now;
            // Search indexing can lag. IDs, rather than timestamps, deduplicate overlap.
            const messages = await this.io.collect(kind, start - 300_000, now);
            if (this.blocked()) return;
            for (const m of messages.sort(compareMessages)) this.ingest(m, start - 300_000);
            this.store.data.cursors[kind] = now;
            await this.store.save();
          }
          // Replies/recovery often do not mention the owner. Check active sources too.
          const activeSources = new Map<string, InboxJob>();
          for (const job of this.store.data.jobs) if (!resolved(job) && this.acceptsSource(job)) activeSources.set(job.source.chatId, job);
          for (const [chatId, job] of [...activeSources].sort((a, b) => (this.store.data.cursors[`context:${a[0]}`] ?? 0) - (this.store.data.cursors[`context:${b[0]}`] ?? 0)).slice(0, 10)) {
            const key = `context:${chatId}`;
            const since = this.store.data.cursors[key] ?? job.messages[0]!.time;
            if (now - since < 60_000) continue;
            const context = await this.io.context(chatId, since - 60_000, now);
            if (this.blocked()) return;
            for (const m of context.sort(compareMessages)) this.ingest(m, since - 60_000);
            this.store.data.cursors[key] = now;
          }
        }
        // Deep results are read in the workbench. No pending, progress or failure posts.
        for (const job of this.store.data.jobs) {
          if (job.state === 'ready') {
            if (!this.config.gui.publicUrl && !job.automatic && job.attention?.state === 'needed' && !job.deliveredAt) {
              if ((job.retryAt ?? 0) > now) continue;
              job.retryAt = now + 60_000; await this.store.save();
              await this.io.deliver(job, 'result'); job.deliveredAt = this.now(); job.retryAt = undefined;
            }
            job.state = 'done';
          }
          if (job.state === 'notifying' || (job.state === 'queued' && !job.analysisRequested)) job.state = 'waiting';
        }
        await this.notifyAttention();
        // Keep durable state bounded; retain active jobs regardless of age.
        const quiet = new Set(this.store.data.jobs.filter(j => !resolved(j) && j.attention?.state === 'quiet').slice(-500).map(j => j.id));
        this.store.data.jobs = this.store.data.jobs.filter(j => resolved(j) ? now - j.updatedAt < 7 * 86400_000 : j.attention?.state !== 'quiet' || quiet.has(j.id));
        for (const [id, time] of Object.entries(this.store.data.seen)) if (now - time > 2 * 86400_000) delete this.store.data.seen[id];
        await this.store.save();
        this.lastError = undefined;
      } catch (e) { this.lastError = e instanceof Error ? e.message : 'inbox poll failed'; }
      if (!this.running && !this.blocked()) {
        const next = this.store.data.jobs.find(j => j.state === 'queued' && j.analysisRequested && !resolved(j));
        if (next) {
          next.state = 'running'; next.attempt = (next.attempt ?? 0) + 1; await this.store.save();
          if (this.blocked()) { next.state = 'waiting'; next.analysisRequested = false; await this.store.save(); return; }
          this.launch(signal => this.run(next, signal));
        } else {
          const candidates = this.store.data.jobs.filter(j => !resolved(j) && this.acceptsSource(j) && j.attention?.state === 'pending' &&
            (this.now() - j.updatedAt >= 60_000 || this.now() - j.createdAt >= 120_000)).slice(0, 8);
          if (candidates.length) {
            const day = new Date(this.now()).toISOString().slice(0, 10);
            const usage = this.store.data.triageUsage ??= {};
            if (!this.io.triage || (usage[day] ?? 0) >= this.config.dailyTriageLimit) {
              for (const job of candidates) { job.attention = { state: 'uncertain', reason: '关注筛选暂不可用或今日额度已用完，请人工核对' }; this.touch(job); }
              await this.store.save();
            } else {
              usage[day] = (usage[day] ?? 0) + 1; await this.store.save();
              this.launch(signal => this.triage(candidates, signal));
            }
          }
        }
      }
    });
  }
  private blocked(): boolean { return this.stopped || !this.config.enabled || this.modeChanges > 0; }
  private assertEnabled(): void { if (this.blocked()) throw new Error('助理已关闭或正在切换模式'); }
  private create(messages: InboxMessage[], automatic: boolean, source?: { name: string; type: 'p2p' | 'group' }): InboxJob {
    if (this.store.data.jobs.filter(j => !resolved(j) && j.attention?.state !== 'quiet').length >= 500) throw new Error('待办已达 500 项，暂停采集，请先处理或忽略已有待办');
    const m = messages[0]!;
    const job: InboxJob = { id: randomUUID(), ownerOpenId: this.config.ownerOpenId, profile: this.config.executorProfile,
      destination: { ...this.config.destination }, source: { chatId: m.chatId, name: source?.name || m.chatName, type: source?.type || m.chatType, threadId: m.threadId },
      messages: boundMessages(messages, this.config.maxContextChars), state: automatic ? 'waiting' : 'queued',
      analysisRequested: !automatic, attention: { state: automatic ? 'pending' : 'needed', reason: automatic ? '等待关注筛选' : '你主动选择了此会话' },
      intakeTrigger: m.chatType === 'p2p' ? 'private' : m.mentions.includes(this.config.ownerOpenId) ? 'mention' : 'group',
      createdAt: this.now(), updatedAt: this.now(), revision: 0, handlingState: 'open', automatic, alert: messages.some(m => classifyMessage(m) === 'alert'), incidentId: m.incidentId };
    this.store.data.jobs.push(job); return job;
  }
  private ingest(m: InboxMessage, earliest: number): void {
    if (m.time < Math.max(earliest, this.store.data.cursors.intakeSince ?? 0) ||
      (m.chatType === 'p2p' ? !this.config.watchPrivate : !this.config.watchMentions) || m.chatId === this.config.destination.chatId) return;
    const known = this.store.data.jobs.flatMap(j => j.messages).find(x => x.id === m.id);
    if (known ? known.text === m.text : this.store.data.seen[m.id]) return;
    this.store.data.seen[m.id] = this.now();
    try { this.ingestNew(m); }
    catch (error) { delete this.store.data.seen[m.id]; throw error; }
  }
  private ingestNew(m: InboxMessage): void {
    const jobs = this.store.data.jobs.filter(j => j.source.chatId === m.chatId && !resolved(j) && this.acceptsSource(j));
    if (m.senderId === this.config.ownerOpenId) {
      for (const job of jobs) if (compareMessages(m, job.messages.at(-1)!) > 0 && (m.chatType === 'p2p' ||
        (m.threadId && m.threadId === job.source.threadId) || job.messages.some(x => x.id === m.parentId))) {
        if (job.state === 'running') this.controller?.abort();
        job.state = 'claimed'; job.handlingState = 'handled'; this.touch(job);
      }
      return;
    }
    if (m.recovered && m.incidentId && m.bot) {
      for (const job of jobs) if (job.incidentId === m.incidentId && job.messages[0]?.senderId === m.senderId) { job.state = 'ignored'; job.handlingState = 'ignored'; this.touch(job); }
      return;
    }
    const related = jobs.find(j => j.messages.some(x => x.id === m.id)) ?? jobs.find(j => (m.threadId && m.threadId === j.source.threadId) || j.messages.some(x => x.id === m.parentId));
    if (m.chatType === 'group' && intakeScope(this.config) !== 'all' && !m.mentions.includes(this.config.ownerOpenId) && !related) return;
    if (!related && m.bot && jobs.some(j => j.messages.at(-1)?.text === m.text && j.source.threadId === m.threadId)) return;
    const category = classifyMessage(m);
    if (category === 'skip' || (m.chatType === 'p2p' && m.bot)) return;
    const previous = related ?? jobs.find(j => j.source.threadId === m.threadId && (m.incidentId ? j.incidentId === m.incidentId && j.messages[0]?.senderId === m.senderId : !j.incidentId && (Boolean(j.result) || j.state === 'running' || this.now() - j.updatedAt < 5 * 60_000)));
    if (previous) {
      if (m.mentions.includes(this.config.ownerOpenId)) previous.intakeTrigger = 'mention';
      previous.messages = boundMessages([...previous.messages.filter(x => x.id !== m.id), m], this.config.maxContextChars);
      previous.alert ||= category === 'alert'; previous.attention = { state: 'pending', reason: '新消息等待筛选' };
      previous.analysisRequested = false; this.touch(previous);
      if (previous.result || previous.replyDraft) previous.draftStale = true;
      if (['queued', 'running', 'ready', 'done', 'failed'].includes(previous.state)) {
        if (previous.state === 'running') this.controller?.abort();
        previous.state = 'waiting'; previous.automatic = false; previous.dueAt = undefined;
        previous.error = '消息已更新，请检查草稿或重新生成';
      }
    } else this.create([m], true);
  }
  private launch(fn: (signal: AbortSignal) => Promise<void>): void {
    this.controller = new AbortController();
    this.running = fn(this.controller.signal).catch(() => { this.lastError = '状态保存失败，助理已暂停'; this.stopped = true; })
      .finally(() => { this.running = undefined; this.controller = undefined; });
  }
  private async triage(jobs: InboxJob[], signal: AbortSignal): Promise<void> {
    const inputs = structuredClone(jobs);
    let results: Awaited<ReturnType<NonNullable<InboxIO['triage']>>>;
    try { results = await this.io.triage!(inputs, signal); }
    catch { results = inputs.map(j => ({ id: j.id, state: 'uncertain', reason: '关注筛选未完成，请人工核对' })); }
    await this.serial(async () => {
      if (signal.aborted || this.blocked()) return;
      for (const input of inputs) {
        const job = this.store.data.jobs.find(j => j.id === input.id);
        if (!job || resolved(job) || !this.acceptsSource(job) || signature(job) !== signature(input) || job.attention?.state !== 'pending') continue;
        const result = results.find(r => r.id === job.id);
        job.attention = result ? { state: result.state, reason: result.reason, priority: result.priority } : { state: 'uncertain', reason: '关注筛选结果缺失，请人工核对' };
        this.touch(job);
      }
      await this.store.save();
    });
  }
  private async notifyAttention(): Promise<void> {
    if (this.blocked() || !this.io.notifyAttention) return;
    const data = this.store.data; const now = this.now();
    const eligible = (j: InboxJob) => !resolved(j) && this.acceptsSource(j) && j.attention?.state === 'needed' && !j.notifiedAt && !j.notificationSuppressed;
    let outbox = data.notificationOutbox;
    if (!outbox) {
      const day = new Date(now).toISOString().slice(0, 10);
      const usage = data.notificationUsage ??= {};
      if ((data.lastDigestAt !== undefined && now - data.lastDigestAt < 600_000) || (usage[day] ?? 0) >= 12) return;
      const jobs = data.jobs.filter(eligible).slice(0, 20);
      if (!jobs.length) return;
      outbox = data.notificationOutbox = { id: randomUUID(), jobs: jobs.map(j => ({ id: j.id, signature: signature(j) })), attempts: 0, retryAt: now };
      data.lastDigestAt = now; usage[day] = (usage[day] ?? 0) + 1; await this.store.save();
    }
    if (outbox.retryAt > now) return;
    const jobs = outbox.jobs.map(entry => data.jobs.find(j => j.id === entry.id && signature(j) === entry.signature && eligible(j)));
    // Do not change an already-sent digest's content during retries.
    if (jobs.some(j => !j) || outbox.attempts >= 3 || now - (data.lastDigestAt ?? now) > 240_000) {
      if (outbox.attempts) for (const entry of outbox.jobs) { const j = data.jobs.find(j => j.id === entry.id); if (j) j.notificationSuppressed = true; }
      data.notificationOutbox = undefined; await this.store.save(); return;
    }
    outbox.attempts++; outbox.retryAt = now + 60_000; await this.store.save();
    await this.io.notifyAttention(jobs as InboxJob[], outbox.id);
    for (const job of jobs) job!.notifiedAt = this.now();
    data.notificationOutbox = undefined; await this.store.save();
  }
  async batchReview(value: unknown, owner: string, requestId?: string): Promise<void> {
    if (owner !== this.config.ownerOpenId) throw new Error('forbidden');
    const input = value as { items?: { id: string; revision: number }[]; handlingState?: string };
    if (!input || !Array.isArray(input.items) || !input.items.length || input.items.length > 500 ||
      !['handled', 'ignored'].includes(input.handlingState ?? '') || input.items.some(i => !i || typeof i.id !== 'string' || !Number.isSafeInteger(i.revision)) ||
      new Set(input.items.map(i => i.id)).size !== input.items.length) throw new Error('无效批量操作');
    await this.serial(async () => {
      if (this.stopped) throw new Error('助理连接已关闭');
      const jobs = input.items!.map(item => {
        const job = this.store.data.jobs.find(j => j.id === item.id && j.ownerOpenId === owner);
        if (!job || ((!requestId || job.lastReviewRequestId !== requestId) && (job.revision ?? 0) !== item.revision)) throw new Error('所选事项已更新，请刷新并重新选择；本次未修改任何事项');
        return job;
      });
      if (requestId && jobs.every(j => j.lastReviewRequestId === requestId)) return;
      const before = structuredClone(jobs);
      for (const job of jobs) {
        if (job.state === 'running') this.controller?.abort();
        job.handlingState = input.handlingState as 'handled' | 'ignored';
        job.state = input.handlingState === 'handled' ? 'claimed' : 'ignored';
        job.analysisRequested = false; job.lastReviewRequestId = requestId; job.dueAt = undefined; this.touch(job);
      }
      try { await this.store.save(); }
      catch (error) { jobs.forEach((job, i) => { for (const key of Object.keys(job)) delete (job as unknown as Record<string, unknown>)[key]; Object.assign(job, before[i]); }); throw error; }
    });
  }
  private async run(job: InboxJob, signal: AbortSignal): Promise<void> {
    let revision = job.revision ?? 0;
    try {
      await this.io.checkOwner(this.config.ownerOpenId);
      const context = await this.io.context(job.source.chatId, job.messages[0]!.time - this.config.contextMinutes * 60_000, this.now());
      const relevant = job.source.threadId ? context.filter(m => m.threadId === job.source.threadId) : context;
      if (job.automatic && relevant.some(m => m.senderId === this.config.ownerOpenId && compareMessages(m, job.messages.at(-1)!) > 0 &&
        (job.source.type === 'p2p' || Boolean(job.source.threadId) || job.messages.some(x => x.id === m.parentId)))) {
        await this.serial(async () => { if (job.state === 'running' && (job.revision ?? 0) === revision) { job.state = 'claimed'; job.handlingState = 'handled'; this.touch(job); } await this.store.save(); }); return;
      }
      if (signal.aborted) throw new Error('分析已取消');
      await this.serial(async () => {
        if (job.state !== 'running' || signal.aborted || (job.revision ?? 0) !== revision) throw new Error('事项已更新');
        const messages = boundMessages([...new Map([...job.messages, ...relevant].map(m => [m.id, m])).values()], this.config.maxContextChars);
        if (JSON.stringify(messages) !== JSON.stringify(job.messages)) { job.messages = messages; this.touch(job); }
        revision = job.revision ?? 0; await this.store.save();
      });
      signal.throwIfAborted();
      if (!this.config.enabled || !job.analysisRequested) throw new Error('分析未由用户发起或助理已关闭');
      const result = await this.io.analyze(structuredClone(job), signal);
      await this.serial(async () => {
        job.inputTokens = result.inputTokens; job.outputTokens = result.outputTokens;
        if (job.state === 'running' && !signal.aborted && (job.revision ?? 0) === revision) {
          const fields = replyContent(result.text);
          job.result = resultText(result.text); job.analysis = fields.analysis; job.missingInfo = fields.missingInfo;
          if (!job.draftEdited) { job.replyDraft = fields.replyDraft; job.draftStale = false; }
          job.state = 'ready'; job.analysisRequested = false; job.error = undefined; this.touch(job);
        }
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
