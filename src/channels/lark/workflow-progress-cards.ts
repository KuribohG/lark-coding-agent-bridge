import type { LarkChannel, NormalizedMessage } from '@larksuite/channel';
import { renderWorkflowProgress, type WorkflowKernel, type WorkflowProgress, type WorkflowState } from '@kuribohg/agent-workflows';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { log } from '../../core/logger';
import { writeFileAtomic } from '../../platform/atomic-write';

const MIN_INTERVAL_MS = 5_000;
const REFRESH_MS = 60_000;
const MAX_CARDS = 256;
const SEQUENCE_RESTART_GAP = 100;
const TEMPLATES: Record<WorkflowProgress['tone'], string> = {
  running: 'blue', attention: 'orange', failed: 'red', done: 'green', cancelled: 'grey',
};

/** Persisted so a restarted bridge keeps updating the same card instead of leaving it stale. */
interface CardRecord {
  workflowId: string;
  scopeId: string;
  messageId?: string;
  /** Absent when CardKit was unavailable and the card was sent inline; such cards are patched by message. */
  cardId?: string;
  sequence: number;
  chatId: string;
  replyTo: string;
  replyInThread: boolean;
}

interface Tracked {
  record: CardRecord;
  stop: () => void;
  timer?: NodeJS.Timeout;
  flushing?: Promise<void>;
  dirty: boolean;
  rendered?: string;
  lastAt: number;
}

function workflowProgressCard(progress: WorkflowProgress, updatedAt: number): object {
  const time = new Date(updatedAt).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
  return {
    schema: '2.0',
    config: { update_multi: true, summary: { content: `工作流 ${progress.title}：${progress.status}` } },
    header: { title: { tag: 'plain_text', content: `工作流：${progress.title}` },
      subtitle: { tag: 'plain_text', content: progress.status }, template: TEMPLATES[progress.tone] },
    body: { elements: [
      { tag: 'markdown', content: progress.markdown },
      { tag: 'markdown', text_size: 'notation', content: `<font color='grey'>更新于 ${time}${progress.settled ? '' : '，自动刷新'}。详情：/workflow status</font>` },
    ] },
  };
}

/**
 * One progress card per root workflow, sent beside the plan and edited in place as the workflow
 * changes. Updates are coalesced and refreshed periodically so running timings stay current.
 */
export class WorkflowProgressCards {
  private readonly tracked = new Map<string, Tracked>();
  private records = new Map<string, CardRecord>();
  private writes: Promise<void> = Promise.resolve();
  private refresh?: NodeJS.Timeout;
  private closed = false;

  constructor(private readonly deps: {
    channel: Pick<LarkChannel, 'createCard' | 'send' | 'updateCard' | 'updateCardById'>;
    kernel: Pick<WorkflowKernel, 'state' | 'onChange'>;
    origins: ReadonlyMap<string, NormalizedMessage>;
    path?: string;
    minIntervalMs?: number;
    refreshMs?: number;
    now?: () => number;
  }) {}

  private get now() { return this.deps.now ?? Date.now; }

  /** Restores cards recorded by the previous process and starts the periodic refresh. */
  async start(): Promise<void> {
    if (this.deps.path) {
      try {
        const raw = JSON.parse(await readFile(this.deps.path, 'utf8')) as { version?: unknown; cards?: unknown };
        if (raw.version === 1 && Array.isArray(raw.cards)) {
          for (const card of raw.cards as CardRecord[]) {
            if (!card || typeof card.workflowId !== 'string' || typeof card.scopeId !== 'string' || typeof card.chatId !== 'string') continue;
            // CardKit rejects non-increasing sequences, and the last update may not have been persisted before the stop.
            this.records.set(card.workflowId, { ...card, sequence: (Number(card.sequence) || 0) + SEQUENCE_RESTART_GAP });
          }
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
      }
    }
    for (const record of this.records.values()) this.follow(record);
    this.refresh = setInterval(() => { for (const entry of this.tracked.values()) this.schedule(entry); }, this.deps.refreshMs ?? REFRESH_MS);
    this.refresh.unref();
  }

  /** Starts following a root workflow; repeated calls (replays, restarts) keep the existing card. */
  track(state: WorkflowState): void {
    if (this.closed || state.parent || this.tracked.has(state.workflowId)) return;
    const origin = this.deps.origins.get(state.root.scopeId);
    if (!origin) return;
    const record = this.records.get(state.workflowId) ?? { workflowId: state.workflowId, scopeId: state.root.scopeId, sequence: 0,
      chatId: origin.chatId, replyTo: origin.messageId, replyInThread: Boolean(origin.threadId) };
    this.records.set(state.workflowId, record);
    this.follow(record);
  }

  /** Resolves after pending card writes and the state file have settled. */
  async flush(): Promise<void> {
    await Promise.all([...this.tracked.values()].map(entry => entry.flushing));
    await this.writes;
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.refresh) clearInterval(this.refresh);
    for (const entry of this.tracked.values()) { entry.stop(); if (entry.timer) clearTimeout(entry.timer); }
    await this.flush();
    this.tracked.clear();
  }

  private follow(record: CardRecord): void {
    if (this.tracked.has(record.workflowId)) return;
    const entry: Tracked = { record, dirty: false, lastAt: 0, stop: () => {} };
    entry.stop = this.deps.kernel.onChange(record.scopeId, () => this.schedule(entry));
    this.tracked.set(record.workflowId, entry);
    this.schedule(entry);
  }

  private schedule(entry: Tracked): void {
    if (this.closed) return;
    if (entry.flushing) { entry.dirty = true; return; }
    if (entry.timer) return;
    const wait = Math.max(0, entry.lastAt + (this.deps.minIntervalMs ?? MIN_INTERVAL_MS) - this.now());
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      entry.flushing = this.publish(entry)
        .catch(error => log.warn('workflow', 'progress-card-failed', { workflowId: entry.record.workflowId, error: String(error) }))
        .finally(() => {
          entry.flushing = undefined;
          entry.lastAt = this.now();
          if (entry.dirty) { entry.dirty = false; this.schedule(entry); }
        });
    }, wait);
    entry.timer.unref();
  }

  private async publish(entry: Tracked): Promise<void> {
    const { record } = entry;
    const state = this.deps.kernel.state(record.scopeId, record.workflowId);
    if (!state) { this.forget(entry); return; }
    const now = this.now();
    const progress = renderWorkflowProgress(state, now);
    // Compare without the timestamp so idle workflows are not rewritten on every refresh.
    const rendered = JSON.stringify(progress);
    if (rendered !== entry.rendered) {
      const card = workflowProgressCard(progress, now);
      if (!record.messageId) await this.send(record, card);
      else if (record.cardId) await this.deps.channel.updateCardById(record.cardId, card, ++record.sequence);
      else await this.deps.channel.updateCard(record.messageId, card);
      entry.rendered = rendered;
      this.persist();
    }
    if (progress.settled) this.forget(entry);
  }

  private async send(record: CardRecord, card: object): Promise<void> {
    const options = { replyTo: record.replyTo, ...(record.replyInThread ? { replyInThread: true } : {}) };
    try {
      const { cardId } = await this.deps.channel.createCard(card);
      record.messageId = (await this.deps.channel.send(record.chatId, { cardId }, options)).messageId;
      record.cardId = cardId;
    } catch (error) {
      log.warn('workflow', 'progress-card-raw-fallback', { workflowId: record.workflowId, error: String(error) });
      record.messageId = (await this.deps.channel.send(record.chatId, { card }, options)).messageId;
    }
  }

  private forget(entry: Tracked): void {
    entry.stop();
    if (entry.timer) clearTimeout(entry.timer);
    this.tracked.delete(entry.record.workflowId);
    this.records.delete(entry.record.workflowId);
    this.persist();
  }

  private persist(): void {
    const path = this.deps.path;
    if (!path) return;
    while (this.records.size > MAX_CARDS) this.records.delete(this.records.keys().next().value as string);
    const payload = `${JSON.stringify({ version: 1, cards: [...this.records.values()] })}\n`;
    this.writes = this.writes.then(async () => {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFileAtomic(path, payload, { mode: 0o600 });
    }).catch(error => log.warn('workflow', 'progress-card-persist-failed', { error: String(error) }));
  }
}
