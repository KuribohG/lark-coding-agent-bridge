import { randomUUID } from 'node:crypto';
import { intakeScope, type InboxConfig, type IntakeScope } from './config';
import { handlingState } from './reply';
import type { InboxIO, InboxJob, InboxMessage } from './types';
import type { SourceAdapter, SourceContext } from '../work-items/contracts';
import { evidenceSignature as signature, recordObservation } from '../work-items/identity';
import { createLarkAssessment } from './assessment';
import { analysisChanges, messageBasis } from './updates';

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

export class LarkSource implements SourceAdapter {
  readonly id = 'lark';
  private host!: SourceContext;
  private lastPoll = 0;
  private pollRetryAt = 0;
  private contextRetryAt = 0;
  private contextError?: string;
  private intakeGeneration = 0;
  readonly assessment;
  constructor(private config: InboxConfig, private io: InboxIO, private now = Date.now) {
    this.assessment = createLarkAssessment(config, io);
  }
  attach(context: SourceContext): void { this.host = context; }
  private get lastError() { return this.host.error; }
  private set lastError(error: string | undefined) { this.host.error = error; }
  safe(job: InboxJob): boolean { return !job.external && this.safeSource(job); }
  accepts(job: InboxJob): boolean { return !job.external && this.acceptsSource(job); }
  reconcile(): void { this.removeFeedback(); }
  invalidate(): void { this.intakeGeneration++; this.lastPoll = 0; }
  refresh(): Promise<void> { return this.refreshContexts(); }

  initialize(): void {
    for (const kind of ['p2p', 'mention', 'group']) this.host.store.data.cursors[kind] ??= this.now();
  }
  modeChanged(previous: 'off' | 'on', mode: 'off' | 'on'): void {
    for (const job of this.host.store.data.jobs) {
      if (job.external) continue;
      job.dueAt = undefined;
      job.attention ??= { state: 'pending', reason: '等待关注筛选' };
      if (job.state === 'notifying' || (['queued', 'running'].includes(job.state) && (mode === 'off' || !job.analysisRequested))) {
        job.state = 'waiting'; job.analysisRequested = false;
      }
      if (mode === 'off') { job.analysisRequested = false; job.analysisPaused = true; }
    }
    if (previous === 'off' && mode === 'on') {
      for (const kind of Object.keys(this.host.store.data.cursors)) this.host.store.data.cursors[kind] = this.now();
      this.host.store.data.cursors.intakeSince = this.now(); this.invalidate();
    }
  }

  private outputChat(chatId: string): boolean {
    return chatId === this.config.destination.chatId || this.host.store.data.jobs.some(job =>
      chatId === job.destination.chatId || chatId === job.analysisTopic?.chatId);
  }

  private acceptsMessage(message: InboxMessage): boolean {
    return !this.outputChat(message.chatId) && !(this.io.selfSenderIds ?? []).some(id =>
      Boolean(id) && (message.senderId === id || message.senderOpenId === id));
  }

  private safeSource(job: InboxJob): boolean {
    return !this.outputChat(job.source.chatId) && job.messages.length > 0 && job.messages.every(m => this.acceptsMessage(m));
  }

  private removeFeedback(): void {
    for (const job of this.host.store.data.jobs) {
      if (job.external) continue;
      const messages = this.outputChat(job.source.chatId) ? [] : job.messages.filter(m => this.acceptsMessage(m));
      if (messages.length === job.messages.length && messages.length) continue;
      const reason = '助理自身消息或结果群内容，不作为待办处理';
      if (!messages.length && job.handlingState === 'ignored' && job.attention?.state === 'quiet' && job.attention.reason === reason && !job.attention.retry &&
        !job.analysisRequested && !job.startDelivery && !job.resultDelivery && !job.retryAt) continue;
      if (job.state === 'running') this.host.abort('analysis');
      job.analysisRequested = false; job.startDelivery = undefined; job.resultDelivery = undefined;
      job.retryAt = undefined; job.dueAt = undefined; job.notificationSuppressed = true;
      job.draftStale = Boolean(job.result || job.replyDraft); job.error = undefined;
      if (!messages.length) {
        // Preserve the original messages for audit, but permanently exclude them from work.
        this.host.ignore(job); job.attention = { state: 'quiet', reason };
      } else {
        job.messages = messages; job.alert = messages.some(m => classifyMessage(m) === 'alert');
        recordObservation(job);
        if (!resolved(job)) {
          job.state = 'waiting'; job.attention = { state: 'pending', reason: '已排除助理自身消息，重新筛选' };
          job.notificationSuppressed = false; job.notifiedAt = undefined;
        }
      }
      this.host.touch(job);
    }
    const outbox = this.host.store.data.notificationOutbox;
    if (outbox?.jobs.some(entry => {
      const job = this.host.store.data.jobs.find(j => j.id === entry.id);
      return !job || !this.safeSource(job) || signature(job) !== entry.signature;
    })) this.host.store.data.notificationOutbox = undefined;
  }

  private acceptsSource(job: InboxJob): boolean {
    if (!this.safeSource(job)) return false;
    if (job.external) return true;
    return job.source.type === 'p2p' ? this.config.watchPrivate : this.config.watchMentions &&
      (intakeScope(this.config) === 'all' || job.intakeTrigger === 'mention' || job.messages.some(m => m.mentions.includes(this.config.ownerOpenId)));
  }

  async setScope(scope: IntakeScope, persist?: () => Promise<void>): Promise<void> {
    if (!['private', 'private_mentions', 'all'].includes(scope)) throw new Error('无效接收范围');
    this.host.suspend(); this.intakeGeneration++;
    this.host.abort();
    this.io.cancelPending?.();
    this.host.clearAssessmentProgress();
    try {
      await this.host.transaction(async () => {
        if (this.host.closed) throw new Error('助理连接已关闭');
        await persist?.();
        this.config.intakeScope = scope;
        this.config.watchPrivate = true; this.config.watchMentions = scope !== 'private';
        // New scopes start now; the indexing overlap must not backfill old conversations.
        for (const key of Object.keys(this.host.store.data.cursors)) this.host.store.data.cursors[key] = this.now();
        this.host.store.data.cursors.intakeSince = this.now(); this.lastPoll = 0;
        for (const job of this.host.store.data.jobs) {
          if (job.automatic && (!this.acceptsSource(job) || job.state === 'running')) {
            job.analysisPaused = true;
            job.automatic = false; job.dueAt = undefined;
            if (['queued', 'running', 'notifying'].includes(job.state)) job.state = 'waiting';
            job.error = '接收范围已更新，已有事项可手动处理'; this.host.touch(job);
          }
        }
        await this.host.store.save();
      });
    } finally { this.host.resume(); }
  }

  async manual(chatId: string, requestId?: string): Promise<InboxJob> {
    if (!/^oc_\w+$/.test(chatId)) throw new Error('invalid chat ID');
    if (this.outputChat(chatId)) throw new Error('结果群不作为待办来源');
    return this.host.transaction(async () => {
      this.host.assertEnabled();
      const replay = requestId && this.host.store.data.jobs.find(j => j.manualRequestId === requestId || j.manualRequestIds?.includes(requestId));
      if (replay) {
        if (replay.source.chatId !== chatId) throw new Error('request ID already used');
        if (!this.safeSource(replay)) throw new Error('助理自身消息不可处理');
        return structuredClone(replay);
      }
      await this.io.checkOwner(this.config.ownerOpenId);
      const source = await this.io.source(chatId);
      let messages = (await this.io.context(chatId, this.now() - this.config.contextMinutes * 60_000, this.now())).filter(m => this.acceptsMessage(m));
      if (!messages.length && !this.host.closed) messages = (await this.io.context(chatId, this.now() - 86400_000, this.now())).filter(m => this.acceptsMessage(m));
      this.host.assertEnabled();
      if (!messages.length) throw new Error('最近一天没有可处理的非助理消息');
      messages = boundMessages(messages, this.config.maxContextChars);
      const ids = messages.map(m => m.id).sort().join(',');
      const submitted = this.host.store.data.jobs.find(j => j.source.chatId === chatId && ['running', 'ready', 'done', 'queued'].includes(j.state) &&
        j.manualSignature === ids && this.now() - j.updatedAt < 30 * 60_000);
      if (submitted) {
        if (submitted.state === 'queued') submitted.automatic = false;
        if (requestId) {
          submitted.manualRequestIds = [...(submitted.manualRequestIds || []), requestId].slice(-100);
          await this.host.store.save();
        }
        return structuredClone(submitted);
      }
      const existing = this.host.store.data.jobs.find(j => j.source.chatId === chatId && ['waiting', 'notifying', 'queued'].includes(j.state));
      const job = existing ?? this.create(messages, false, source);
      job.messages = boundMessages(messages, this.config.maxContextChars);
      recordObservation(job);
      job.source.threadId = undefined;
      job.destination = { ...this.config.destination };
      job.manualSignature = ids;
      if (requestId) job.manualRequestIds = [...(job.manualRequestIds || []), requestId].slice(-100);
      job.automatic = false; job.analysisRequested = true; job.analysisPaused = false; job.notificationSuppressed = true;
      job.startDelivery = undefined; job.resultDelivery = undefined; job.deliveredAt = undefined;
      job.attention = { state: 'needed', reason: '你主动选择了此会话' }; job.state = 'queued'; this.host.touch(job);
      job.draftStale = Boolean(job.result || job.replyDraft);
      await this.host.store.save();
      return structuredClone(job);
    });
  }

  async poll(): Promise<void> {
    const now = this.now();
    if (this.host.blocked() || now < this.pollRetryAt || now - this.lastPoll < this.config.pollSeconds * 1000) return;
    this.lastPoll = now;
    const generation = this.intakeGeneration;
    const current = () => !this.host.blocked() && generation === this.intakeGeneration;
    try {
      await this.io.checkOwner(this.config.ownerOpenId);
      for (const kind of ['p2p', 'mention', 'group'] as const) {
        if (!current()) return;
        if (kind === 'p2p' ? !this.config.watchPrivate : kind === 'group' ? intakeScope(this.config) !== 'all' : !this.config.watchMentions || intakeScope(this.config) === 'all') continue;
        const start = this.host.store.data.cursors[kind] ?? now;
        const snapshot = this.intakeSnapshot();
        const messages = await this.io.collect(kind, start - 300_000, now);
        await this.host.transaction(async () => {
          if (!current()) return;
          this.ingestBatch(messages, start - 300_000, snapshot);
          this.host.store.data.cursors[kind] = now; await this.host.store.save();
        });
      }
      if (current()) { this.lastError = this.contextError; this.pollRetryAt = 0; }
    } catch (error) {
      if (current()) {
        this.lastError = error instanceof Error ? error.message : 'inbox poll failed';
        // Faster successful polls must not amplify API failures or rate limiting.
        this.pollRetryAt = this.now() + 60_000;
      }
    }
  }

  private async refreshContexts(): Promise<void> {
    if (this.host.blocked() || this.now() < this.contextRetryAt) return;
    const now = this.now();
    const generation = this.intakeGeneration;
    const current = () => !this.host.blocked() && generation === this.intakeGeneration;
    try {
      const sources = new Map<string, InboxJob>();
      for (const job of this.host.store.data.jobs) if (!resolved(job) && this.acceptsSource(job)) sources.set(job.source.chatId, structuredClone(job));
      const due = [...sources].sort((a, b) => (this.host.store.data.cursors[`context:${a[0]}`] ?? 0) - (this.host.store.data.cursors[`context:${b[0]}`] ?? 0))
        .slice(0, 10).filter(([chatId, job]) => now - (this.host.store.data.cursors[`context:${chatId}`] ?? job.messages[0]!.time) >= 60_000);
      if (!due.length) return;
      await this.io.checkOwner(this.config.ownerOpenId);
      for (const [chatId, job] of due) {
        if (!current()) return;
        const key = `context:${chatId}`;
        const since = this.host.store.data.cursors[key] ?? job.messages[0]!.time;
        if (now - since < 60_000) continue;
        const snapshot = this.intakeSnapshot();
        const context = await this.io.context(chatId, since - 60_000, now);
        await this.host.transaction(async () => {
          if (!current()) return;
          this.ingestBatch(context, since - 60_000, snapshot);
          this.host.store.data.cursors[key] = now; await this.host.store.save();
        });
        if (current()) await this.host.dispatch();
      }
      if (current()) {
        this.contextRetryAt = 0;
        if (this.lastError === this.contextError) this.lastError = undefined;
        this.contextError = undefined;
      }
    } catch (error) {
      if (current()) {
        this.contextError = error instanceof Error ? error.message : 'inbox context refresh failed';
        this.lastError = this.contextError;
        this.contextRetryAt = this.now() + 60_000;
      }
    }
  }

  private intakeSnapshot(): Map<string, string> {
    const snapshot = new Map<string, string>();
    for (const job of this.host.store.data.jobs) for (const m of job.messages) if (!snapshot.has(m.id)) snapshot.set(m.id, m.text);
    return snapshot;
  }

  private ingestBatch(messages: InboxMessage[], earliest: number, snapshot: Map<string, string>): void {
    const current = this.intakeSnapshot();
    for (const m of messages.sort(compareMessages)) {
      // An older in-flight read cannot undo a message changed by another reader.
      if (current.has(m.id) && current.get(m.id) !== snapshot.get(m.id)) continue;
      this.ingest(m, earliest);
    }
  }

  private create(messages: InboxMessage[], automatic: boolean, source?: { name: string; type: 'p2p' | 'group' }): InboxJob {
    if (this.host.store.data.jobs.filter(j => !resolved(j) && j.attention?.state !== 'quiet').length >= 500) throw new Error('待办已达 500 项，暂停采集，请先处理或忽略已有待办');
    const m = messages[0]!;
    const job: InboxJob = { id: randomUUID(), ownerOpenId: this.config.ownerOpenId, profile: this.config.executorProfile,
      destination: { ...this.config.destination }, source: { chatId: m.chatId, name: source?.name || m.chatName, type: source?.type || m.chatType, threadId: m.threadId },
      messages: boundMessages(messages, this.config.maxContextChars), state: automatic ? 'waiting' : 'queued',
      analysisRequested: !automatic, attention: { state: automatic ? 'pending' : 'needed', reason: automatic ? '等待关注筛选' : '你主动选择了此会话' },
      intakeTrigger: m.chatType === 'p2p' ? 'private' : m.mentions.includes(this.config.ownerOpenId) ? 'mention' : 'group',
      createdAt: this.now(), updatedAt: this.now(), revision: 0, handlingState: 'open', automatic, alert: messages.some(m => classifyMessage(m) === 'alert'), incidentId: m.incidentId };
    recordObservation(job);
    this.host.store.data.jobs.push(job); return job;
  }

  private ingest(m: InboxMessage, earliest: number): void {
    if (m.time < Math.max(earliest, this.host.store.data.cursors.intakeSince ?? 0) ||
      (m.chatType === 'p2p' ? !this.config.watchPrivate : !this.config.watchMentions) || !this.acceptsMessage(m)) return;
    const known = this.host.store.data.jobs.flatMap(j => j.messages).find(x => x.id === m.id);
    if (known ? known.text === m.text : this.host.store.data.seen[m.id]) return;
    this.host.store.data.seen[m.id] = this.now();
    try { this.ingestNew(m); }
    catch (error) { delete this.host.store.data.seen[m.id]; throw error; }
  }

  private ingestNew(m: InboxMessage): void {
    const jobs = this.host.store.data.jobs.filter(j => j.source.chatId === m.chatId && !resolved(j) && this.acceptsSource(j));
    if (m.senderId === this.config.ownerOpenId) {
      for (const job of jobs) if (compareMessages(m, job.messages.at(-1)!) > 0 && (m.chatType === 'p2p' ||
        (m.threadId && m.threadId === job.source.threadId) || job.messages.some(x => x.id === m.parentId))) {
        if (job.state === 'running') this.host.abort('analysis');
        job.state = 'claimed'; job.handlingState = 'handled'; this.host.touch(job);
      }
      return;
    }
    if (m.recovered && m.incidentId && m.bot) {
      for (const job of jobs) if (job.incidentId === m.incidentId && job.messages[0]?.senderId === m.senderId) {
        if (job.state === 'running') this.host.abort('analysis');
        job.businessState = 'resolved';
        this.host.ignore(job); this.host.touch(job);
      }
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
      previous.alert ||= category === 'alert';
      recordObservation(previous);
      this.host.touch(previous);
      if (previous.state === 'running') {
        // The running agent owns its input snapshot; intake must not invalidate its work.
        if (previous.result || previous.replyDraft) previous.draftStale = true;
        return;
      }
      // New context supersedes a decision, but must not bypass a failed request's backoff.
      const retry = previous.attention?.retry;
      previous.attention = { state: 'pending', reason: retry ? previous.attention!.reason : '新消息等待筛选', ...(retry ? { retry } : {}) };
      previous.analysisRequested = false;
      if (previous.result || previous.replyDraft) previous.draftStale = true;
      if (['queued', 'ready', 'done', 'failed'].includes(previous.state)) {
        previous.state = 'waiting'; previous.automatic = false; previous.dueAt = undefined;
        previous.error = '消息已更新，请检查草稿或重新生成';
      }
    } else this.create([m], true);
  }
  async beforeAnalysis(job: InboxJob, signal: AbortSignal, current: () => boolean): Promise<boolean> {
    await this.io.checkOwner(this.config.ownerOpenId);
    const context = await this.io.context(job.source.chatId, job.messages[0]!.time - this.config.contextMinutes * 60_000, this.now());
    const relevant = context.filter(m => this.acceptsMessage(m) && (!job.source.threadId || m.threadId === job.source.threadId));
    if (job.automatic && relevant.some(m => m.senderId === this.config.ownerOpenId && compareMessages(m, job.messages.at(-1)!) > 0 &&
      (job.source.type === 'p2p' || Boolean(job.source.threadId) || job.messages.some(x => x.id === m.parentId)))) {
      await this.host.transaction(async () => { if (current()) { job.state = 'claimed'; job.handlingState = 'handled'; this.host.touch(job); } await this.host.store.save(); }); return false;
    }
    if (signal.aborted) throw new Error('分析已取消');
    await this.host.transaction(async () => {
      if (!current()) throw new Error('分析已取消');
      // Collection may have updated a message while this history request was in flight.
      const messages = boundMessages([...new Map([...relevant, ...job.messages].map(m => [m.id, m])).values()], this.config.maxContextChars);
      if (JSON.stringify(messages) !== JSON.stringify(job.messages)) { job.messages = messages; recordObservation(job); this.host.touch(job); }
      await this.host.store.save();
    });
    return true;
  }
  afterAnalysis(job: InboxJob, input: InboxJob): void {
    job.analysisBasis = { messages: messageBasis(input.messages), attention: input.attention?.state === 'needed'
      ? input.attention : { state: 'needed', reason: '你提交的会话事项' } };
    job.attention = { ...job.analysisBasis.attention };
    if (analysisChanges(job).length) {
      job.state = 'waiting'; job.draftStale = true;
      job.attention = { state: 'pending', reason: '分析已完成，等待核对期间收到的新消息' };
    }
  }
}
