import { randomUUID } from 'node:crypto';
import type { Writable } from 'node:stream';
import { coveredInputs, type ClaudeRunLedger } from './run-ledger';

type Receipt = 'accepted' | 'inactive';
type RawEvent = Record<string, unknown>;
const object = (value: unknown): RawEvent => value !== null && typeof value === 'object' ? value as RawEvent : {};

/**
 * Claude's stdin: writes inputs and control messages, and confirms that Claude took each
 * supplement in. Whether an input has been answered is the ledger's business.
 */
export class ClaudeStreamInput {
  private active = true;
  private sessionId: string;
  private readonly deliveries = new Map<string, Promise<Receipt>>();
  private readonly pending = new Map<string, { resolve(value: Receipt): void; reject(error: Error): void; timer: NodeJS.Timeout }>();

  constructor(
    private readonly stdin: Writable,
    private readonly ledger: Pick<ClaudeRunLedger, 'sent'>,
    sessionId?: string,
    private readonly ackTimeoutMs = 30_000,
  ) {
    this.sessionId = sessionId ?? '';
  }

  start(prompt: string): void {
    this.write(prompt, randomUUID());
  }

  /** Track the input an earlier bridge process wrote to this agent instead of sending a prompt. */
  restore(written: readonly string[]): void {
    for (const line of written) {
      let event: RawEvent;
      try { event = object(JSON.parse(line)); } catch { continue; }
      if (event.type === 'user' && typeof event.uuid === 'string') this.ledger.sent(event.uuid);
    }
  }

  get currentSessionId(): string | undefined {
    return this.sessionId || undefined;
  }

  /** Write a control-protocol message; false once the input stream is closed. */
  control(message: object): boolean {
    if (!this.active || this.stdin.destroyed || this.stdin.writableEnded) return false;
    try {
      this.stdin.write(JSON.stringify(message) + '\n', 'utf8', (error) => {
        if (error) this.close(new Error('Claude stdin write failed; delivery is unknown'));
      });
      return true;
    } catch {
      this.close(new Error('Claude stdin write failed; delivery is unknown'));
      return false;
    }
  }

  /**
   * Ask Claude to end the turn itself: it cancels running tools and records the
   * interruption in the transcript, which a signal would leave as a failed tool.
   */
  interrupt(): boolean {
    return this.control({ type: 'control_request', request_id: randomUUID(), request: { subtype: 'interrupt' } });
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

  /** True for protocol receipts, which are not part of the run's output. */
  receive(raw: unknown): boolean {
    const event = object(raw);
    if (event.parent_tool_use_id) return false;
    if (event.type === 'system' && event.subtype === 'init' && typeof event.session_id === 'string') {
      this.sessionId = event.session_id;
    }
    if (event.type === 'command_lifecycle') {
      if (event.state === 'queued' || event.state === 'started') this.acknowledge(event.command_uuid);
      return true;
    }
    if (event.type === 'user' && event.isReplay === true) {
      this.acknowledge(event.uuid);
      return true;
    }
    // A result naming an input proves it arrived, even if its receipt never did.
    if (event.type === 'result') for (const uuid of coveredInputs(event) ?? []) this.acknowledge(uuid);
    return false;
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
    this.ledger.sent(uuid);
    try {
      this.stdin.write(JSON.stringify({ type: 'user', uuid, session_id: this.sessionId, parent_tool_use_id: null,
        message: { role: 'user', content: prompt } }) + '\n', 'utf8', callback);
    } catch {
      this.close(new Error('Claude stdin write failed; delivery is unknown'));
    }
  }
}
