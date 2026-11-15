import { randomUUID } from 'node:crypto';
import type { AgentQuestion, AgentQuestionMode } from '../agent/types';
import type { RunResult } from './run-executor';
import type { RunState } from './run-state';

/** What happens in one conversation, as a front end that is not the bridge's own UI sees it. */
export type ConversationEvent =
  | { type: 'run.started'; runId: string }
  /** A full snapshot; it replaces every earlier state of the same run. */
  | { type: 'run.state'; runId: string; state: RunState }
  | { type: 'run.question'; runId: string; id: string; mode: AgentQuestionMode; questions: readonly AgentQuestion[] }
  | { type: 'run.question.settled'; runId: string; id: string; status: string }
  | { type: 'run.finished'; runId: string; result: RunResult }
  | { type: 'run.failed'; runId: string; error: string };

export type SequencedConversationEvent = ConversationEvent & { sequence: number };

/** Sent first to every subscriber: a cursor is only valid within the stream that issued it. */
export interface ConversationStreamOpened {
  type: 'stream.opened';
  stream: string;
  /** Sequence of the newest event already published in this conversation, 0 when none. */
  sequence: number;
}

export type ConversationStreamEvent = ConversationStreamOpened | SequencedConversationEvent;

export interface ConversationCursor {
  stream?: string;
  after?: number;
}

interface Stream {
  events: SequencedConversationEvent[];
  listeners: Set<(event: ConversationStreamEvent) => void>;
}

const MAX_BUFFERED_EVENTS = 256;
const MAX_IDLE_STREAMS = 1024;

/**
 * Per-conversation event streams that outlive any one transport connection.
 * A subscriber that reconnects with its cursor receives what it missed from a
 * bounded buffer; superseded state snapshots are not kept, so sequences
 * increase but are not dense.
 */
export class ConversationEvents {
  readonly id = randomUUID();
  private readonly streams = new Map<string, Stream>();
  private sequence = 0;

  publish(scope: string, event: ConversationEvent): SequencedConversationEvent {
    const stream = this.stream(scope);
    const sequenced = { ...event, sequence: ++this.sequence };
    if (event.type === 'run.state') {
      const stale = stream.events.findIndex(old => old.type === 'run.state' && old.runId === event.runId);
      if (stale >= 0) stream.events.splice(stale, 1);
    }
    stream.events.push(sequenced);
    if (stream.events.length > MAX_BUFFERED_EVENTS) stream.events.splice(0, stream.events.length - MAX_BUFFERED_EVENTS);
    for (const listener of [...stream.listeners]) deliver(listener, sequenced);
    return sequenced;
  }

  /** Replays buffered events newer than the cursor, then delivers live ones. Returns the unsubscribe function. */
  subscribe(scope: string, cursor: ConversationCursor, listener: (event: ConversationStreamEvent) => void): () => void {
    const stream = this.stream(scope);
    const after = cursor.stream === this.id && Number.isSafeInteger(cursor.after) ? cursor.after! : 0;
    deliver(listener, { type: 'stream.opened', stream: this.id, sequence: stream.events.at(-1)?.sequence ?? 0 });
    for (const event of stream.events) if (event.sequence > after) deliver(listener, event);
    stream.listeners.add(listener);
    return () => { stream.listeners.delete(listener); };
  }

  private stream(scope: string): Stream {
    let stream = this.streams.get(scope);
    // Re-insert so the least recently used conversations are the first to be dropped.
    if (stream) this.streams.delete(scope);
    else stream = { events: [], listeners: new Set() };
    this.streams.set(scope, stream);
    if (this.streams.size > MAX_IDLE_STREAMS) {
      for (const [key, candidate] of this.streams) {
        if (this.streams.size <= MAX_IDLE_STREAMS) break;
        if (candidate !== stream && candidate.listeners.size === 0) this.streams.delete(key);
      }
    }
    return stream;
  }
}

/** One subscriber's failure must not reach the run or the other subscribers. */
function deliver(listener: (event: ConversationStreamEvent) => void, event: ConversationStreamEvent): void {
  try { listener(event); } catch { /* the transport that threw closes itself */ }
}
