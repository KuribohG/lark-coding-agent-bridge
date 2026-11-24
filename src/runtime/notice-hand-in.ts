import { randomUUID } from 'node:crypto';
import { NOTICE_PROMPT_MAX, workflowNoticePrompt } from './agent-entry';

/** A notice the main agent has not been given yet. */
export interface PendingNotice { id: string; kind: string; summary: string; createdAt?: number }

export interface NoticeHandInDeps {
  /** The notices of the scope's workflow that the main agent has not been given, oldest first. */
  undelivered(scope: string): PendingNotice[];
  /**
   * Hands `text` to the turn that is running in the scope, the way a user's follow-up reaches it: `accepted` once the
   * agent has it, `queued` when no turn can take it now, `unknown` when it was sent and the receipt was lost.
   */
  steer(scope: string, messageId: string, text: string): Promise<'accepted' | 'queued' | 'cancelled' | 'unknown'>;
  /** `delivered`: a turn of the main agent has the notices. Otherwise they are only not to be sent again. */
  markNotified(scope: string, ids: string[], delivered: boolean): void;
  now?(): number;
}

/**
 * Notices that report how things stand rather than answer the main agent: they are gathered this long before they go
 * into its running turn, so that several arrive as one message. Anything else goes in at once.
 */
const GATHERED = new Set(['todo', 'review_due']);
export const NOTICE_GATHER_MS = 2 * 60_000;
/** A running turn is looked at for notices to hand in no more often than this, whether or not it took the last ones. */
export const NOTICE_GAP_MS = 20_000;

/**
 * The main agent is in a turn, and a turn that waits on background work lasts for hours: a wake that waited for it to
 * end left replies and warnings unread all that time. What the workflow raised meanwhile goes into the turn instead,
 * as a user's follow-up would. A turn that cannot take input keeps the notices for the wake that follows it.
 */
export class NoticeHandIn {
  /** When each scope's running turn was last looked at. */
  private readonly looked = new Map<string, number>();

  constructor(private readonly deps: NoticeHandInDeps) {}

  async run(scope: string): Promise<void> {
    const now = this.deps.now?.() ?? Date.now();
    if (now - (this.looked.get(scope) ?? -Infinity) < NOTICE_GAP_MS) return;
    const pending = this.deps.undelivered(scope);
    if (!pending.length) return;
    if (pending.every(notice => GATHERED.has(notice.kind) && now - (notice.createdAt ?? 0) < NOTICE_GATHER_MS)) return;
    this.looked.set(scope, now);
    const batch = pending.slice(0, NOTICE_PROMPT_MAX);
    const result = await this.deps.steer(scope, `workflow-notices:${randomUUID()}`, workflowNoticePrompt(batch));
    // A lost receipt may mean that it arrived: it is not sent twice, and the notices stay pending in the status.
    if (result === 'accepted' || result === 'unknown') this.deps.markNotified(scope, batch.map(notice => notice.id), result === 'accepted');
  }
}
