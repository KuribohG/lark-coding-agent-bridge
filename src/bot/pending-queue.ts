import type { NormalizedMessage } from '@larksuite/channel';
import { readFile } from 'node:fs/promises';
import { log } from '../core/logger';
import { writeFileAtomic } from '../platform/atomic-write';
import type { AgentEntry } from '../runtime/agent-entry';

/** Routing metadata is set by the bridge command handler, never parsed from message text. */
export type PendingMessage = NormalizedMessage & { agentEntry?: AgentEntry };

interface PendingEntry {
  messages: PendingMessage[];
  timer?: NodeJS.Timeout;
  queuedAt: number;
}

export type FlushHandler = (scope: string, batch: PendingMessage[]) => void;

const MAX_MESSAGES_PER_SCOPE = 100;
export const MAX_PENDING_CHARS_PER_SCOPE = 200_000;
const MAX_BATCH_WAIT_MS = 5_000;

interface PersistedPendingEntry {
  scope: string;
  queuedAt: number;
  messages: PendingMessage[];
}

/**
 * Per-scope debounce queue. `scope` is the session scope string (typically
 * `chatId` for p2p / regular group, `chatId:threadId` for topic groups).
 * Accumulates messages within the same scope inside a quiet window, then
 * flushes as a single batch.
 *
 * `block(scope)` pauses the debounce timer while an agent run is active on
 * that scope — pushed messages still accumulate but no flush fires until
 * `unblock(scope)`, which arms a fresh quiet window.
 *
 * Commands should bypass this queue — they're cheap and should be responsive.
 */
export class PendingQueue {
  private readonly map = new Map<string, PendingEntry>();
  private readonly blocked = new Set<string>();
  private readonly delayMs: () => number;
  private readonly onFlush: FlushHandler;
  private readonly path: string | undefined;
  private saving: Promise<void> = Promise.resolve();
  private dirty = false;
  private loadedFromDisk = false;
  private persistenceError: unknown;
  private detached = false;
  private writesHeld = false;

  constructor(
    delayMs: number | (() => number),
    onFlush: FlushHandler,
    path?: string,
  ) {
    this.delayMs = typeof delayMs === 'number' ? () => delayMs : delayMs;
    this.onFlush = onFlush;
    this.path = path;
  }

  async load(): Promise<void> {
    if (!this.path) return;
    try {
      const raw = JSON.parse(await readFile(this.path, 'utf8')) as unknown;
      if (!Array.isArray(raw)) throw new Error('pending queue must be an array');
      for (const value of raw) {
        const entry = normalizePersistedEntry(value);
        if (!entry) continue;
        const existing = this.map.get(entry.scope);
        if (existing) {
          const known = new Set(existing.messages.map((message) => message.messageId));
          existing.messages.push(...entry.messages.filter((message) => !known.has(message.messageId)));
          existing.queuedAt = Math.min(existing.queuedAt, entry.queuedAt);
        } else {
          this.map.set(entry.scope, {
            messages: entry.messages,
            queuedAt: entry.queuedAt,
          });
        }
      }
      this.loadedFromDisk = true;
      log.info('queue', 'loaded', {
        scopes: this.map.size,
        messages: [...this.map.values()].reduce((total, entry) => total + entry.messages.length, 0),
      });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.fail('queue', err, { step: 'load' });
      }
    }
  }

  resume(): void {
    if (!this.loadedFromDisk) return;
    this.loadedFromDisk = false;
    for (const [scope, entry] of this.map) {
      if (!this.blocked.has(scope) && entry.messages.length > 0) {
        entry.timer = this.armTimer(scope, entry);
      }
    }
  }

  async reload(): Promise<void> {
    await this.load();
    this.writesHeld = false;
    await this.flushPersistence();
  }

  suspend(): void {
    this.loadedFromDisk = true;
    for (const entry of this.map.values()) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = undefined;
    }
  }

  detach(): void {
    this.detached = true;
    this.suspend();
  }

  holdPersistence(): void {
    this.writesHeld = true;
  }

  push(scope: string, msg: PendingMessage): number | undefined {
    const existing = this.map.get(scope);
    if (existing) {
      if (
        existing.messages.length >= MAX_MESSAGES_PER_SCOPE ||
        pendingChars(existing.messages) + msg.content.length > MAX_PENDING_CHARS_PER_SCOPE
      ) {
        log.warn('queue', 'full', {
          scope,
          queued: existing.messages.length,
          chars: pendingChars(existing.messages),
        });
        return undefined;
      }
      if (existing.timer) clearTimeout(existing.timer);
      existing.messages.push(msg);
      existing.timer = this.blocked.has(scope) || this.loadedFromDisk
        ? undefined
        : this.armTimer(scope, existing);
      this.schedulePersist();
      return existing.messages.length;
    }
    if (msg.content.length > MAX_PENDING_CHARS_PER_SCOPE) {
      log.warn('queue', 'full', { scope, queued: 0, chars: msg.content.length });
      return undefined;
    }
    const entry: PendingEntry = {
      messages: [msg],
      queuedAt: Date.now(),
    };
    this.map.set(scope, {
      ...entry,
      timer: this.blocked.has(scope) || this.loadedFromDisk
        ? undefined
        : this.armTimer(scope, entry),
    });
    this.schedulePersist();
    return 1;
  }

  cancel(scope: string): PendingMessage[] {
    const entry = this.map.get(scope);
    if (!entry) return [];
    if (entry.timer) clearTimeout(entry.timer);
    this.map.delete(scope);
    this.schedulePersist();
    return entry.messages;
  }

  hasWork(scope: string): boolean {
    return this.blocked.has(scope) || this.map.has(scope);
  }

  isBlocked(scope: string): boolean {
    return this.blocked.has(scope);
  }

  cancelAll(): void {
    for (const entry of this.map.values()) {
      if (entry.timer) clearTimeout(entry.timer);
    }
    this.map.clear();
    this.blocked.clear();
    this.schedulePersist();
  }

  /** Pause the debounce timer; pushed messages keep accumulating. */
  block(scope: string): void {
    if (this.blocked.has(scope)) return;
    this.blocked.add(scope);
    const entry = this.map.get(scope);
    if (entry) entry.queuedAt = Date.now();
    if (entry?.timer) {
      clearTimeout(entry.timer);
      entry.timer = undefined;
    }
    log.info('queue', 'blocked', { scope, queued: entry?.messages.length ?? 0 });
  }

  /** Resume the debounce timer; arms a fresh quiet window if anything queued. */
  unblock(scope: string): void {
    if (!this.blocked.has(scope)) return;
    this.blocked.delete(scope);
    const entry = this.map.get(scope);
    if (entry) entry.queuedAt = Date.now();
    log.info('queue', 'unblocked', { scope, queued: entry?.messages.length ?? 0 });
    if (!entry || entry.messages.length === 0) return;
    if (entry.timer) clearTimeout(entry.timer);
    if (this.loadedFromDisk) {
      entry.timer = undefined;
      return;
    }
    entry.timer = this.armTimer(scope, entry);
  }

  async flushPersistence(): Promise<void> {
    if (this.detached) return;
    this.schedulePersist();
    await this.saving;
    if (this.persistenceError) throw this.persistenceError;
  }

  private armTimer(scope: string, entry: PendingEntry): NodeJS.Timeout {
    const quietWindow = Math.max(0, this.delayMs());
    const maxWaitRemaining = Math.max(0, MAX_BATCH_WAIT_MS - (Date.now() - entry.queuedAt));
    return setTimeout(() => this.flushScope(scope), Math.min(quietWindow, maxWaitRemaining));
  }

  private flushScope(scope: string): void {
    const entry = this.map.get(scope);
    if (!entry) return;
    entry.timer = undefined;
    // Command entries get their own turn, keeping their capabilities out of direct-message batches.
    const isDirect = (message: PendingMessage) => !message.agentEntry || message.agentEntry.kind === 'direct';
    const boundary = entry.messages[0] && !isDirect(entry.messages[0]) ? 1
      : entry.messages.findIndex(message => !isDirect(message));
    const batch = entry.messages.splice(0, boundary < 0 ? entry.messages.length : boundary);
    if (entry.messages.length === 0) this.map.delete(scope);
    this.schedulePersist();
    try {
      this.onFlush(scope, batch);
    } catch (err) {
      log.fail('queue', err, { scope, batchSize: batch.length });
    } finally {
      if (this.map.get(scope) === entry && !entry.timer && !this.blocked.has(scope) && !this.loadedFromDisk) {
        entry.timer = this.armTimer(scope, entry);
      }
    }
  }

  private schedulePersist(): void {
    if (this.detached || this.writesHeld) return;
    const path = this.path;
    if (!path) return;
    this.dirty = true;
    this.saving = this.saving
      .then(async () => {
        while (this.dirty) {
          this.dirty = false;
          const payload: PersistedPendingEntry[] = [...this.map.entries()]
            .filter(([, entry]) => entry.messages.length > 0)
            .map(([scope, entry]) => ({
              scope,
              queuedAt: entry.queuedAt,
              messages: entry.messages,
            }));
          await writeFileAtomic(path, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
          this.persistenceError = undefined;
        }
      })
      .catch((err: unknown) => {
        this.persistenceError = err;
        log.fail('queue', err, { step: 'persist' });
      });
  }
}

function pendingChars(messages: readonly NormalizedMessage[]): number {
  return messages.reduce((total, message) => total + message.content.length, 0);
}

function normalizePersistedEntry(value: unknown): PersistedPendingEntry | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Partial<PersistedPendingEntry>;
  if (typeof raw.scope !== 'string' || raw.scope.length === 0 || !Array.isArray(raw.messages)) {
    return undefined;
  }
  const messages = raw.messages.filter((message): message is PendingMessage => (
    Boolean(message) &&
    typeof message === 'object' &&
    typeof (message as NormalizedMessage).messageId === 'string' &&
    typeof (message as NormalizedMessage).chatId === 'string' &&
    typeof (message as NormalizedMessage).content === 'string'
  ));
  if (messages.length === 0) return undefined;
  return {
    scope: raw.scope,
    queuedAt: Number.isFinite(raw.queuedAt) ? raw.queuedAt! : Date.now(),
    messages: messages.slice(-MAX_MESSAGES_PER_SCOPE),
  };
}
