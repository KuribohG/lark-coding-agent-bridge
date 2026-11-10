import type { ProcessStreamFinish } from '../process-run';
import type { AgentEvent } from '../types';

type JsonRecord = Record<string, unknown>;

/**
 * Pi streams text token by token (measured ~1.7 characters per `text_delta` on
 * deepseek-flash), while Claude reports whole content blocks. Forwarding every
 * delta floods every downstream consumer: a single answer becomes thousands of
 * CoT `TEXT_MESSAGE_CONTENT` events, and a batch large enough to trip the API's
 * per-request event limit is dropped outright. Buffer a block and release it on
 * its `text_end`, on a block or tool boundary, or once it grows past this many
 * UTF-8 bytes — the CoT rejects a content field above 1000 bytes.
 */
const TEXT_FLUSH_BYTES = 600;

/**
 * Translate Pi's JSONL session-event stream into the bridge contract.
 *
 * JSON mode has one header plus session events. Pi 0.73 ends at process exit;
 * current releases also emit `agent_settled`. Both paths finish here.
 */
export class PiRunTranslator {
  private sessionId: string | undefined;
  private terminal = false;
  private lastError: string | undefined;
  private finalText: string | undefined;
  private textBlocksWithDelta = new Set<number>();
  private pendingText: string[] = [];
  private pendingTextBytes = 0;
  private pendingTextIndex: number | undefined;
  private startedTools = new Set<string>();

  translate(raw: unknown): AgentEvent[] {
    if (this.terminal || !isRecord(raw) || typeof raw.type !== 'string') return [];

    switch (raw.type) {
      case 'session': {
        const sessionId = stringValue(raw.id);
        if (!sessionId) return [];
        this.sessionId = sessionId;
        return [{
          type: 'system',
          sessionId,
          ...(stringValue(raw.cwd) ? { cwd: stringValue(raw.cwd) } : {}),
        }];
      }
      case 'message_start': {
        if (messageRole(raw.message) !== 'assistant') return [];
        this.lastError = undefined;
        const text = this.flushText();
        this.resetAssistantBlocks();
        return text;
      }
      case 'message_update':
        return this.translateAssistantUpdate(raw);
      case 'message_end':
        return this.translateMessageEnd(raw.message);
      case 'tool_execution_start':
        return [...this.flushText(), ...this.translateToolStart(raw)];
      case 'tool_execution_end':
        return this.translateToolEnd(raw);
      case 'auto_retry_start':
        return this.translateRetry(raw);
      case 'summarization_retry_scheduled':
        return this.translateRetry(raw);
      case 'auto_retry_end':
        if (raw.success === false) {
          this.lastError = stringValue(raw.finalError) ?? this.lastError;
        }
        return [];
      case 'agent_settled': {
        this.terminal = true;
        const text = this.flushText();
        if (this.lastError) {
          return [...text, this.error(this.lastError)];
        }
        return raw.aborted === true ? [...text, this.done('interrupted')] : [...text, ...this.complete()];
      }
      default:
        return [];
    }
  }

  finish(input: ProcessStreamFinish): AgentEvent[] {
    if (this.terminal) return [];
    this.terminal = true;
    const text = this.flushText();
    if (input.interrupted) {
      return [...text, this.done('interrupted')];
    }
    if (input.timedOut || input.exitCode === 124) {
      return [...text, this.done('timeout')];
    }
    if (input.runtimeError) {
      return [...text, this.error(`pi runtime error: ${input.runtimeError.message}`)];
    }
    if (input.exitCode !== 0) {
      const detail = input.stderr ? `: ${input.stderr.slice(0, 500)}` : '';
      return [...text, this.error(`pi exited with code ${input.exitCode}${detail}`)];
    }
    if (this.lastError) return [...text, this.error(this.lastError)];
    return [...text, ...this.complete()];
  }

  terminalEmitted(): boolean {
    return this.terminal;
  }

  private translateAssistantUpdate(raw: JsonRecord): AgentEvent[] {
    const update = recordValue(raw.assistantMessageEvent);
    if (!update || typeof update.type !== 'string') return [];
    const index = numberValue(update.contentIndex) ?? 0;
    switch (update.type) {
      case 'start': {
        const text = this.flushText();
        this.resetAssistantBlocks();
        return text;
      }
      case 'text_start':
        return this.flushText();
      case 'text_delta': {
        const delta = stringValue(update.delta);
        if (!delta) return [];
        // A previous block that never sent `text_end` still has to reach the
        // consumer before this one starts accumulating.
        const text = this.pendingTextIndex !== undefined && this.pendingTextIndex !== index
          ? this.flushText() : [];
        this.textBlocksWithDelta.add(index);
        this.pendingTextIndex = index;
        this.pendingText.push(delta);
        this.pendingTextBytes += Buffer.byteLength(delta, 'utf8');
        return this.pendingTextBytes >= TEXT_FLUSH_BYTES ? [...text, ...this.flushText()] : text;
      }
      case 'text_end': {
        const content = stringValue(update.content);
        // Deltas are authoritative once seen; only a block that never streamed
        // them needs its final content released here.
        if (content && !this.textBlocksWithDelta.has(index)) {
          this.textBlocksWithDelta.add(index);
          this.pendingTextIndex = index;
          this.pendingText.push(content);
          this.pendingTextBytes += Buffer.byteLength(content, 'utf8');
        }
        return this.flushText();
      }
      // Pi streams the provider's raw chain of thought token by token. Claude
      // only surfaces provider-supplied reasoning summaries and drops raw
      // thinking blocks (see claude/stream-json.ts), so forward nothing here to
      // keep both harnesses showing the same thing. Passing Pi's deltas through
      // shreds the Lark CoT bubble into one- to two-character fragments.
      case 'thinking_start':
      case 'thinking_delta':
      case 'thinking_end':
        return [];
      case 'error': {
        const message = errorMessage(update.error);
        if (message) this.lastError = message;
        return [];
      }
      default:
        return [];
    }
  }

  private translateMessageEnd(value: unknown): AgentEvent[] {
    const message = recordValue(value);
    if (!message || message.role !== 'assistant') return [];
    const events: AgentEvent[] = this.flushText();
    if (this.textBlocksWithDelta.size === 0) {
      const text = textContent(message.content);
      if (text) {
        this.textBlocksWithDelta.add(0);
        events.push({ type: 'text', delta: text });
      }
    }
    const usage = recordValue(message.usage);
    if (usage) {
      const cost = recordValue(usage.cost);
      events.push({
        type: 'usage',
        inputTokens: numberValue(usage.input),
        outputTokens: numberValue(usage.output),
        cachedInputTokens: numberValue(usage.cacheRead),
        costUsd: numberValue(cost?.total),
      });
    }
    const stopReason = stringValue(message.stopReason);
    this.finalText = stopReason === 'stop' && !this.startedTools.size
      && !(Array.isArray(message.content) && message.content.some(block => recordValue(block)?.type === 'toolCall'))
      ? textContent(message.content) || undefined : undefined;
    if (stopReason === 'error') {
      // Pi can retry a failed assistant message before settling the agent.
      this.lastError = stringValue(message.errorMessage) ?? this.lastError ?? 'pi model request failed';
    } else if (stopReason === 'aborted') {
      this.terminal = true;
      events.push(this.done('interrupted'));
    }
    return events;
  }

  private translateToolStart(raw: JsonRecord): AgentEvent[] {
    this.finalText = undefined;
    const id = stringValue(raw.toolCallId);
    const name = stringValue(raw.toolName);
    if (!id || !name || this.startedTools.has(id)) return [];
    this.startedTools.add(id);
    return [{ type: 'tool_use', id, name, input: raw.args ?? {} }];
  }

  private translateToolEnd(raw: JsonRecord): AgentEvent[] {
    const id = stringValue(raw.toolCallId);
    if (!id) return [];
    this.startedTools.delete(id);
    return [{
      type: 'tool_result',
      id,
      output: toolOutput(raw.result),
      isError: raw.isError === true,
    }];
  }

  private translateRetry(raw: JsonRecord): AgentEvent[] {
    this.finalText = undefined;
    const attempt = numberValue(raw.attempt);
    const maxAttempts = numberValue(raw.maxAttempts);
    const delayMs = numberValue(raw.delayMs);
    if (attempt === undefined || maxAttempts === undefined || delayMs === undefined) return [];
    return [{ type: 'retry', attempt, maxAttempts, delayMs }];
  }

  private resetAssistantBlocks(): void {
    this.finalText = undefined;
    this.textBlocksWithDelta.clear();
  }

  /** Release whatever text a block accumulated, in one event. */
  private flushText(): AgentEvent[] {
    const index = this.pendingTextIndex;
    const delta = this.pendingText.join('');
    this.pendingText = [];
    this.pendingTextBytes = 0;
    this.pendingTextIndex = undefined;
    return index !== undefined && delta ? [{ type: 'text', delta }] : [];
  }

  private complete(): AgentEvent[] {
    return [
      ...(this.finalText && !this.startedTools.size ? [{ type: 'final_text' as const, content: this.finalText }] : []),
      this.done('normal'),
    ];
  }

  private done(terminationReason: 'normal' | 'interrupted' | 'timeout'): AgentEvent {
    return {
      type: 'done',
      ...(this.sessionId ? { sessionId: this.sessionId } : {}),
      terminationReason,
    };
  }

  private error(message: string): AgentEvent {
    return {
      type: 'error',
      message: truncate(message, 4096),
      terminationReason: 'failed',
    };
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function recordValue(value: unknown): JsonRecord | undefined {
  return isRecord(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function messageRole(value: unknown): string | undefined {
  return stringValue(recordValue(value)?.role);
}

function textContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value
    .map((block) => {
      const item = recordValue(block);
      return item?.type === 'text' ? stringValue(item.text) ?? '' : '';
    })
    .filter(Boolean)
    .join('');
}

function toolOutput(value: unknown): string {
  if (typeof value === 'string') return value;
  const result = recordValue(value);
  if (result) {
    const text = textContent(result.content);
    if (text) return text;
  }
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return String(value);
  }
}

function errorMessage(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  const record = recordValue(value);
  return stringValue(record?.errorMessage)
    ?? stringValue(record?.message)
    ?? stringValue(record?.error);
}

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}
