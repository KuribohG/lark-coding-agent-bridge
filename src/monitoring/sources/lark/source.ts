import { type InboxConfig, type IntakeScope } from '../../../inbox/config';
import { handlingState } from '../../../work-items/result';
import type { InboxIO, InboxJob, InboxMessage } from '../../../inbox/types';
import type { SourceAdapter, SourceContext } from '../../../work-items/contracts';
import type { SourceItem } from '../../../work-items/lifecycle';
import type { WorkItemService } from '../../../work-items/service';
import { createLarkAssessment } from './assessment';
import { analysisChanges, messageBasis } from '../../../inbox/updates';
import { boundMessages, classifyMessage, compareMessages, incidentId, LarkConversation } from './conversation';

const resolved = (job: InboxJob) => handlingState(job) !== 'open';

/** Conversation commands belong to the Lark source, not to the generic work-item service. */
export function larkSource(service: Pick<WorkItemService, 'source'>): LarkSource {
  if (!(service.source instanceof LarkSource)) throw new Error('此来源不支持飞书会话操作');
  return service.source;
}

export class LarkSource implements SourceAdapter {
  readonly id = 'lark';
  private host!: SourceContext;
  private lastPoll = 0;
  private pollRetryAt = 0;
  private contextRetryAt = 0;
  private contextError?: string;
  private intakeGeneration = 0;
  private conversation: LarkConversation;
  readonly assessment;
  constructor(private config: InboxConfig, private io: InboxIO, private now = Date.now) {
    this.assessment = createLarkAssessment(io);
    this.conversation = new LarkConversation(config, io.selfSenderIds, now);
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
    for (const kind of ['p2p', 'mention', 'group']) this.host.cursors[kind] ??= this.now();
  }
  modeChanged(previous: 'off' | 'on', mode: 'off' | 'on'): void {
    for (const job of this.host.items) {
      if (job.external) continue;
      this.host.transition(job, { type: 'mode', mode });
    }
    if (previous === 'off' && mode === 'on') {
      for (const kind of Object.keys(this.host.cursors)) this.host.cursors[kind] = this.now();
      this.host.cursors.intakeSince = this.now(); this.invalidate();
    }
  }

  private outputChat(chatId: string): boolean { return this.conversation.outputChat(chatId, this.host.items); }
  private acceptsMessage(message: InboxMessage): boolean { return this.conversation.acceptsMessage(message, this.host.items); }
  private safeSource(job: InboxJob): boolean { return this.conversation.safe(job, this.host.items); }

  private removeFeedback(): void {
    for (const job of this.host.items) {
      if (job.external) continue;
      const messages = this.outputChat(job.sourceRef.containerId) ? [] : job.messages.filter(m => this.acceptsMessage(m));
      if (messages.length === job.messages.length && messages.length) continue;
      const reason = '助理自身消息或结果群内容，不作为待办处理';
      if (!messages.length && job.handlingState === 'ignored' && job.attention?.state === 'quiet' && job.attention.reason === reason && !job.attention.retry &&
        !job.analysisRequested && !job.startDelivery && !job.resultDelivery && !job.retryAt) continue;
      // Keep excluded messages for audit when none remain eligible.
      this.host.transition(job, { type: 'feedback', messages, alert: messages.some(m => classifyMessage(m) === 'alert'), reason });
    }
  }

  private acceptsSource(job: InboxJob): boolean { return this.conversation.accepts(job, this.host.items); }

  get intakeScope(): IntakeScope { return this.config.intakeScope; }

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
        // New scopes start now; the indexing overlap must not backfill old conversations.
        for (const key of Object.keys(this.host.cursors)) this.host.cursors[key] = this.now();
        this.host.cursors.intakeSince = this.now(); this.lastPoll = 0;
        for (const job of this.host.items) {
          if (job.automatic && (!this.acceptsSource(job) || job.state === 'running')) {
            this.host.transition(job, { type: 'scope' });
          }
        }
        await this.host.save();
      });
    } finally { this.host.resume(); }
  }

  async manual(chatId: string, requestId?: string): Promise<InboxJob> {
    if (!/^oc_\w+$/.test(chatId)) throw new Error('invalid chat ID');
    if (this.outputChat(chatId)) throw new Error('结果群不作为待办来源');
    return this.host.transaction(async () => {
      this.host.assertEnabled();
      const replay = requestId && this.host.items.find(j => j.manualRequestId === requestId || j.manualRequestIds?.includes(requestId));
      if (replay) {
        if (replay.sourceRef.containerId !== chatId) throw new Error('request ID already used');
        if (!this.safeSource(replay)) throw new Error('助理自身消息不可处理');
        return structuredClone(replay);
      }
      await this.io.checkOwner(this.config.recipientKey);
      const source = await this.io.source(chatId);
      let messages = (await this.io.context(chatId, this.now() - this.config.contextMinutes * 60_000, this.now())).filter(m => this.acceptsMessage(m));
      if (!messages.length && !this.host.closed) messages = (await this.io.context(chatId, this.now() - 86400_000, this.now())).filter(m => this.acceptsMessage(m));
      this.host.assertEnabled();
      if (!messages.length) throw new Error('最近一天没有可处理的非助理消息');
      messages = boundMessages(messages, this.config.maxContextChars);
      const ids = messages.map(m => m.id).sort().join(',');
      const submitted = this.host.items.find(j => j.sourceRef.containerId === chatId && ['running', 'ready', 'done', 'queued'].includes(j.state) &&
        j.manualSignature === ids && this.now() - j.updatedAt < 30 * 60_000);
      if (submitted) {
        this.host.transition(submitted, { type: 'manual', replay: true, requestId });
        if (requestId) await this.host.save();
        return structuredClone(submitted);
      }
      const existing = this.host.items.find(j => j.sourceRef.containerId === chatId && !resolved(j) && ['waiting', 'notifying', 'queued'].includes(j.state));
      const job = existing ?? this.create(messages, false, source);
      this.host.transition(job, { type: 'manual', messages, signature: ids, requestId });
      await this.host.save();
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
      await this.io.checkOwner(this.config.recipientKey);
      for (const kind of ['p2p', 'mention', 'group'] as const) {
        if (!current()) return;
        if (kind === 'group' ? this.config.intakeScope !== 'all' : kind === 'mention' && this.config.intakeScope !== 'private_mentions') continue;
        const start = this.host.cursors[kind] ?? now;
        const snapshot = this.intakeSnapshot();
        const messages = await this.io.collect(kind, start - 300_000, now);
        await this.host.transaction(async () => {
          if (!current()) return;
          this.ingestBatch(messages, start - 300_000, snapshot);
          this.host.cursors[kind] = now; await this.host.save();
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
      for (const job of this.host.items) if (!resolved(job) && this.acceptsSource(job)) sources.set(job.sourceRef.containerId, structuredClone(job));
      const due = [...sources].sort((a, b) => (this.host.cursors[`context:${a[0]}`] ?? 0) - (this.host.cursors[`context:${b[0]}`] ?? 0))
        .slice(0, 10).filter(([chatId, job]) => now - (this.host.cursors[`context:${chatId}`] ?? job.messages[0]!.time) >= 60_000);
      if (!due.length) return;
      await this.io.checkOwner(this.config.recipientKey);
      for (const [chatId, job] of due) {
        if (!current()) return;
        const key = `context:${chatId}`;
        const since = this.host.cursors[key] ?? job.messages[0]!.time;
        if (now - since < 60_000) continue;
        const snapshot = this.intakeSnapshot();
        const context = await this.io.context(chatId, since - 60_000, now);
        await this.host.transaction(async () => {
          if (!current()) return;
          this.ingestBatch(context, since - 60_000, snapshot);
          this.host.cursors[key] = now; await this.host.save();
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
    for (const job of this.host.items) for (const m of job.messages) if (!snapshot.has(m.id)) snapshot.set(m.id, m.text);
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

  private create(messages: InboxMessage[], automatic: boolean, source?: { name: string; type: 'p2p' | 'group' }): SourceItem {
    const m = messages[0]!;
    return this.host.create({
      sourceRef: {
        transport: 'lark',
        containerId: m.containerId,
        name: source?.name || m.containerName,
        kind: source?.type === 'p2p' || m.containerKind === 'direct' ? 'direct' : 'group',
        threadId: m.threadId,
      },
      messages: boundMessages(messages, this.config.maxContextChars),
      intakeTrigger: this.conversation.intakeTrigger(m),
      alert: messages.some(m => classifyMessage(m) === 'alert'), incidentId: incidentId(m),
    }, automatic);
  }

  private ingest(m: InboxMessage, earliest: number): void {
    if (m.time < Math.max(earliest, this.host.cursors.intakeSince ?? 0) ||
      (m.containerKind !== 'direct' && this.config.intakeScope === 'private') || !this.acceptsMessage(m)) return;
    const known = this.host.items.flatMap(j => j.messages).find(x => x.id === m.id);
    if (known ? known.text === m.text : this.host.seen[m.id]) return;
    this.host.seen[m.id] = this.now();
    try { this.ingestNew(m); }
    catch (error) { delete this.host.seen[m.id]; throw error; }
  }

  private ingestNew(m: InboxMessage): void {
    const route = this.conversation.route(m, this.host.items);
    switch (route.kind) {
      case 'handled': for (const job of route.items) this.host.transition(job, { type: 'handled' }); return;
      case 'recovered': for (const job of route.items) this.host.transition(job, { type: 'recovered' }); return;
      case 'append': {
        const messages = boundMessages([...route.item.messages.filter(x => x.id !== m.id), m], this.config.maxContextChars);
        this.host.transition(route.item, { type: 'evidence', messages, alert: route.alert, mention: route.mention });
        return;
      }
      case 'create': this.create([m], true); return;
      case 'ignore': return;
    }
  }
  async beforeAnalysis(job: SourceItem, signal: AbortSignal, current: () => boolean): Promise<boolean> {
    await this.io.checkOwner(this.config.recipientKey);
    const context = await this.io.context(job.sourceRef.containerId, job.messages[0]!.time - this.config.contextMinutes * 60_000, this.now());
    const relevant = context.filter(m => this.acceptsMessage(m) && (!job.sourceRef.threadId || m.threadId === job.sourceRef.threadId));
    if (job.automatic && this.conversation.answered(job, relevant)) {
      await this.host.transaction(async () => { if (current()) this.host.transition(job, { type: 'handled' }); await this.host.save(); }); return false;
    }
    if (signal.aborted) throw new Error('分析已取消');
    await this.host.transaction(async () => {
      if (!current()) throw new Error('分析已取消');
      // Collection may have updated a message while this history request was in flight.
      const messages = boundMessages([...new Map([...relevant, ...job.messages].map(m => [m.id, m])).values()], this.config.maxContextChars);
      if (JSON.stringify(messages) !== JSON.stringify(job.messages)) this.host.transition(job, { type: 'evidence', messages, preflight: true });
      await this.host.save();
    });
    return true;
  }
  analysisContext(job: SourceItem, input: SourceItem) {
    const basis = { messages: messageBasis(input.messages), attention: input.attention?.state === 'needed'
      ? input.attention : { state: 'needed' as const, reason: '你提交的会话事项' } };
    return { basis, changed: analysisChanges({ ...job, analysisBasis: basis }).length > 0 };
  }
}
