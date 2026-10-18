import type { AgentRunOptions } from '../agent/types';
import type { InboxJob } from './types';

/** A watcher supplies an idempotent event and prepares evidence, never runs an agent. */
export interface InboxTaskEvent {
  key: string;
  title: string;
  reason: string;
  url: string;
  time: number;
  data: unknown;
  evidenceDir?: string;
  maxAttempts?: number;
  initial?: Partial<Pick<InboxJob, 'state' | 'replyDraft' | 'analysis' | 'missingInfo' | 'result' | 'error' |
    'analysisTopic' | 'deliveredAt' | 'startDelivery' | 'resultDelivery' | 'inputTokens' | 'outputTokens' | 'attempt'>>;
}

export type InboxTaskResult = { text: string; inputTokens: number; outputTokens: number };
export interface PreparedInboxTask {
  cwd: string;
  prompt: string;
  cached?: InboxTaskResult;
}
export interface InboxTaskDriver {
  accepts(job: InboxJob): boolean;
  prepare(job: InboxJob, signal: AbortSignal): Promise<PreparedInboxTask>;
  completed?(job: InboxJob, result: InboxTaskResult, settings: Pick<AgentRunOptions, 'model' | 'reasoningEffort'>): Promise<void>;
}

/** Shared FIFO slot for conversation analysis and every registered task source. */
export class InboxAnalysisQueue {
  private tail: Promise<void> = Promise.resolve();
  async run(signal: AbortSignal, task: (signal: AbortSignal) => Promise<void>): Promise<void> {
    const previous = this.tail;
    let release!: () => void;
    const turn = new Promise<void>(resolve => { release = resolve; });
    this.tail = previous.then(() => turn);
    let cancel!: () => void;
    const cancelled = new Promise<void>(resolve => { cancel = resolve; });
    signal.addEventListener('abort', cancel, { once: true });
    try {
      if (!signal.aborted) await Promise.race([previous, cancelled]);
      // Let the lifecycle record cancellation even when it never acquired a slot.
      await task(signal);
    } finally { signal.removeEventListener('abort', cancel); release(); }
  }
}
