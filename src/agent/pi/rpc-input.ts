import { randomUUID } from 'node:crypto';
import type { Writable } from 'node:stream';

/** Pi's ImageContent shape, as its RPC commands accept it. */
export interface PiImageContent {
  type: 'image';
  data: string;
  mimeType: string;
}

type PiRpcReceipt = 'accepted' | 'inactive' | 'unknown';

interface ResponseRecord {
  id?: string;
  command?: string;
  success?: boolean;
  data?: unknown;
}

interface PendingRequest {
  /** False when the command never reached the agent; nothing can have been acted on. */
  sent: boolean;
  response?: ResponseRecord;
}

const DEFAULT_ACK_TIMEOUT_MS = 15_000;
const STATE_TIMEOUT_MS = 5_000;

/**
 * The command side of a `pi --mode rpc` process: prompt once, then steer the
 * active turn, and answer `get_state` so the run knows its session.
 *
 * Pi accepts a steering message while a turn runs and delivers it after the
 * current assistant turn's tool calls, before the next model call. Its answer
 * means the command was accepted or queued, not that the model has acted yet.
 */
export class PiRpcInput {
  private active = true;
  /** Whether a turn is running; undefined until a state answer or a session event says so. */
  private streaming: boolean | undefined;
  private stateReady: Promise<void> | undefined;
  /** A prompt held back until the state answer names the session. */
  private starting: { text: string; images: readonly PiImageContent[] } | undefined;
  private readonly deliveries = new Map<string, Promise<PiRpcReceipt>>();
  private readonly pending = new Map<string, (settled: PendingRequest) => void>();

  constructor(private readonly stdin: Writable, private readonly ackTimeoutMs = DEFAULT_ACK_TIMEOUT_MS) {}

  /** The run's first prompt. The process stays up for steering after this. */
  start(text: string, images: readonly PiImageContent[] = []): void {
    // A fresh process is about to work on the prompt; treat it as streaming until it settles.
    this.streaming = true;
    // Ask for the session before the run starts: a fast turn can settle before a
    // later answer arrives, and the session must already be on its terminal event.
    this.starting = { text, images };
    this.requestState();
  }

  /**
   * A run attached from an earlier bridge process: its input is already in the
   * host journal. Recover what was delivered, then ask whether the turn is
   * still running before accepting a steer.
   */
  restore(written: readonly string[]): void {
    for (const line of written) {
      let record: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(line);
        if (!isRecord(parsed)) continue;
        record = parsed;
      } catch {
        continue;
      }
      if (record.type === 'steer' && typeof record.id === 'string' && record.id.startsWith('msg:')) {
        this.deliveries.set(record.id.slice(4), Promise.resolve('accepted'));
      }
    }
    this.requestState();
  }

  /** Steer the active turn; a message ID is answered once and never sent twice. */
  steer(text: string, messageId: string, images: readonly PiImageContent[] = []): Promise<PiRpcReceipt> {
    const previous = this.deliveries.get(messageId);
    if (previous) return previous;
    const result = this.deliverSteer(text, messageId, images);
    this.deliveries.set(messageId, result);
    return result;
  }

  /** Stop the run: drop queued input, abort the active operation, then close the protocol. */
  async cancel(timeoutMs: number): Promise<void> {
    if (!this.writable()) {
      this.close();
      return;
    }
    // Cleared steering messages would otherwise be processed after the abort, and the
    // process is about to exit, so they are dropped rather than left pending.
    this.write({ id: `clear:${randomUUID()}`, type: 'clear_queue' });
    await this.request({ id: `abort:${randomUUID()}`, type: 'abort' }, Math.max(250, Math.min(timeoutMs, 5_000)));
    this.close();
  }

  /** End the protocol; Pi disposes the runtime and exits on stdin EOF. */
  close(): void {
    if (!this.active) return;
    this.active = false;
    for (const settle of this.pending.values()) settle({ sent: true });
    this.pending.clear();
    if (!this.stdin.destroyed && !this.stdin.writableEnded) this.stdin.end();
  }

  /** Read a record from the agent's stdout: command answers and session activity. */
  receive(raw: unknown): void {
    if (!isRecord(raw) || typeof raw.type !== 'string') return;
    if (raw.type === 'agent_start') {
      this.streaming = true;
      return;
    }
    if (raw.type === 'agent_settled') {
      this.streaming = false;
      return;
    }
    if (raw.type !== 'response') return;
    const response = raw as ResponseRecord;
    if (response.command === 'get_state' && response.success === true) {
      const data = isRecord(response.data) ? response.data : undefined;
      // A fresh run is optimistically streaming: its state answer may predate the prompt.
      if (this.streaming === undefined && typeof data?.isStreaming === 'boolean') {
        this.streaming = data.isStreaming;
      }
      this.sendPrompt();
    }
    const id = typeof response.id === 'string' ? response.id : undefined;
    const settle = id === undefined ? undefined : this.pending.get(id);
    if (id !== undefined && settle) {
      this.pending.delete(id);
      settle({ sent: true, response });
    }
  }

  private async deliverSteer(
    text: string,
    messageId: string,
    images: readonly PiImageContent[],
  ): Promise<PiRpcReceipt> {
    if (!this.writable()) return 'inactive';
    if (this.streaming === undefined) {
      this.requestState();
      await this.stateReady;
      // The state answer is missing: the command may or may not have been queued.
      if (this.streaming === undefined) return 'unknown';
    }
    if (!this.streaming) return 'inactive';
    const settled = await this.request(
      { id: `msg:${messageId}`, type: 'steer', message: text, ...(images.length > 0 ? { images } : {}) },
      this.ackTimeoutMs,
    );
    if (!settled.sent) return 'inactive';
    if (!settled.response) return 'unknown';
    return settled.response.success === true ? 'accepted' : 'inactive';
  }

  private requestState(): void {
    if (this.stateReady) return;
    this.stateReady = this.request({ id: `state:${randomUUID()}`, type: 'get_state' }, STATE_TIMEOUT_MS)
      .then(settled => {
        const data = settled.response?.success === true && isRecord(settled.response.data)
          ? settled.response.data
          : undefined;
        if (this.streaming === undefined && typeof data?.isStreaming === 'boolean') {
          this.streaming = data.isStreaming;
        }
        // No answer: start anyway rather than turn a missing state into a failed run.
        this.sendPrompt();
      });
  }

  private sendPrompt(): void {
    const starting = this.starting;
    if (!starting) return;
    this.starting = undefined;
    this.write({
      id: `prompt:${randomUUID()}`,
      type: 'prompt',
      message: starting.text,
      ...(starting.images.length > 0 ? { images: starting.images } : {}),
    });
  }

  private request(command: Record<string, unknown> & { id: string }, timeoutMs: number): Promise<PendingRequest> {
    if (!this.write(command)) return Promise.resolve({ sent: false });
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.pending.delete(command.id);
        resolve({ sent: true });
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(command.id, settled => {
        clearTimeout(timer);
        resolve(settled);
      });
    });
  }

  private write(command: object): boolean {
    if (!this.writable()) return false;
    try {
      this.stdin.write(JSON.stringify(command) + '\n', 'utf8', error => {
        if (error) this.close();
      });
      return true;
    } catch {
      this.close();
      return false;
    }
  }

  private writable(): boolean {
    return this.active && !this.stdin.destroyed && !this.stdin.writableEnded;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
