import { randomUUID } from 'node:crypto';
import type { Writable } from 'node:stream';
import { isTaskNotificationResult } from './stream-json';

type Receipt = 'accepted' | 'inactive';
type RawEvent = Record<string, unknown>;
const object = (value: unknown): RawEvent => value !== null && typeof value === 'object' ? value as RawEvent : {};

/** Keep stdin open until a result covers every input sent to this process. */
export class ClaudeStreamInput {
  private active = true;
  private sessionId: string;
  private readonly initialId = randomUUID();
  private readonly outstanding = new Set<string>();
  private readonly deliveries = new Map<string, Promise<Receipt>>();
  private readonly pending = new Map<string, { resolve(value: Receipt): void; reject(error: Error): void; timer: NodeJS.Timeout }>();

  constructor(private readonly stdin: Writable, sessionId?: string, private readonly ackTimeoutMs = 30_000) {
    this.sessionId = sessionId ?? '';
  }

  start(prompt: string): void {
    this.write(prompt, this.initialId);
  }

  errorMessage(message: string): string {
    return [...this.outstanding].some(uuid => uuid !== this.initialId)
      ? `${message}; supplemental input delivery is unknown` : message;
  }

  steer(prompt: string, messageId: string): Promise<Receipt> {
    const previous = this.deliveries.get(messageId);
    if (previous) return previous;
    if (!this.active || this.stdin.destroyed || this.stdin.writableEnded) return Promise.resolve('inactive');
    const uuid = randomUUID();
    const result = new Promise<Receipt>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(uuid);
        reject(new Error('Claude input acknowledgement timed out; delivery is unknown'));
      }, this.ackTimeoutMs);
      this.pending.set(uuid, { resolve, reject, timer });
      this.write(prompt, uuid, (error) => {
        if (error) this.close(new Error('Claude stdin write failed; delivery is unknown'));
      });
    });
    this.deliveries.set(messageId, result);
    return result;
  }

  /** Undefined hides protocol receipts and results preceding a pending input. */
  receive(raw: unknown): unknown {
    const event = object(raw);
    if (event.parent_tool_use_id) return raw;
    if (event.type === 'system' && event.subtype === 'init' && typeof event.session_id === 'string') {
      this.sessionId = event.session_id;
    }
    if (event.type === 'command_lifecycle') {
      if (event.state === 'queued' || event.state === 'started') this.acknowledge(event.command_uuid);
      return undefined;
    }
    if (event.type === 'user' && event.isReplay === true) {
      this.acknowledge(event.uuid);
      return undefined;
    }
    if (event.type !== 'result' || isTaskNotificationResult(event)) return raw;

    // Replay/queued receipts confirm intake, not which generation consumed it.
    const covered = Array.isArray(event.user_message_uuids) ? event.user_message_uuids
      : typeof event.user_message_uuid === 'string' ? [event.user_message_uuid] : undefined;
    for (const uuid of covered ?? []) {
      this.acknowledge(uuid);
      if (typeof uuid === 'string') this.outstanding.delete(uuid);
    }
    const failed = event.is_error || (typeof event.subtype === 'string' && event.subtype.startsWith('error'));
    const hasSupplements = [...this.outstanding].some(uuid => uuid !== this.initialId);
    if (failed || (!covered && hasSupplements)) {
      const error = hasSupplements
        ? 'Claude did not confirm completion of all supplemental inputs; delivery is unknown'
        : 'Claude task failed';
      this.close(new Error(error));
      if (!hasSupplements) return raw;
      return { ...event, is_error: true, errors: [
        ...(Array.isArray(event.errors) ? event.errors : [event.result ?? event.subtype ?? 'Claude result lacks input IDs (requires Claude Code 2.1.302+)']),
        error,
      ] };
    }
    // Older CLIs can still complete a single prompt without correlation fields.
    if (!covered) this.outstanding.delete(this.initialId);
    if (this.outstanding.size > 0) return undefined;
    this.close();
    return raw;
  }

  close(error = new Error('Claude input stream closed; delivery is unknown')): void {
    this.active = false;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
    if (!this.stdin.destroyed && !this.stdin.writableEnded) this.stdin.end();
  }

  private acknowledge(uuid: unknown): void {
    if (typeof uuid !== 'string') return;
    const entry = this.pending.get(uuid);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(uuid);
    entry.resolve('accepted');
  }

  private write(prompt: string, uuid: string, callback?: (error?: Error | null) => void): void {
    this.outstanding.add(uuid);
    try {
      this.stdin.write(JSON.stringify({ type: 'user', uuid, session_id: this.sessionId, parent_tool_use_id: null,
        message: { role: 'user', content: prompt } }) + '\n', 'utf8', callback);
    } catch {
      this.close(new Error('Claude stdin write failed; delivery is unknown'));
    }
  }
}
