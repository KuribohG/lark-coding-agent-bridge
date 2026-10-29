import type { ProcessStreamFinish } from '../process-run';
import type { AgentEvent } from '../types';

type JsonRecord = Record<string, unknown>;

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
  private textBlocksWithDelta = new Set<number>();
  private thinkingBlocksWithDelta = new Set<number>();
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
      case 'message_start':
        if (messageRole(raw.message) === 'assistant') {
          this.lastError = undefined;
          this.resetAssistantBlocks();
        }
        return [];
      case 'message_update':
        return this.translateAssistantUpdate(raw);
      case 'message_end':
        return this.translateMessageEnd(raw.message);
      case 'tool_execution_start':
        return this.translateToolStart(raw);
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
        if (raw.aborted === true && this.lastError) {
          return [this.error(this.lastError)];
        }
        return [{
          type: 'done',
          ...(this.sessionId ? { sessionId: this.sessionId } : {}),
          terminationReason: raw.aborted === true ? 'interrupted' : 'normal',
        }];
      }
      default:
        return [];
    }
  }

  finish(input: ProcessStreamFinish): AgentEvent[] {
    if (this.terminal) return [];
    this.terminal = true;
    if (input.interrupted) {
      return [this.done('interrupted')];
    }
    if (input.timedOut || input.exitCode === 124) {
      return [this.done('timeout')];
    }
    if (input.runtimeError) {
      return [this.error(`pi runtime error: ${input.runtimeError.message}`)];
    }
    if (input.exitCode !== 0 && input.exitCode !== null) {
      const detail = input.stderr ? `: ${input.stderr.slice(0, 500)}` : '';
      return [this.error(`pi exited with code ${input.exitCode}${detail}`)];
    }
    if (this.lastError) return [this.error(this.lastError)];
    return [this.done('normal')];
  }

  terminalEmitted(): boolean {
    return this.terminal;
  }

  private translateAssistantUpdate(raw: JsonRecord): AgentEvent[] {
    const update = recordValue(raw.assistantMessageEvent);
    if (!update || typeof update.type !== 'string') return [];
    const index = numberValue(update.contentIndex) ?? 0;
    switch (update.type) {
      case 'start':
        this.resetAssistantBlocks();
        return [];
      case 'text_delta': {
        const delta = stringValue(update.delta);
        if (!delta) return [];
        this.textBlocksWithDelta.add(index);
        return [{ type: 'text', delta }];
      }
      case 'text_end': {
        const content = stringValue(update.content);
        if (!content || this.textBlocksWithDelta.has(index)) return [];
        this.textBlocksWithDelta.add(index);
        return [{ type: 'text', delta: content }];
      }
      case 'thinking_delta': {
        const delta = stringValue(update.delta);
        if (!delta) return [];
        this.thinkingBlocksWithDelta.add(index);
        return [{ type: 'thinking', delta }];
      }
      case 'thinking_end': {
        const content = stringValue(update.content);
        if (!content || this.thinkingBlocksWithDelta.has(index)) return [];
        this.thinkingBlocksWithDelta.add(index);
        return [{ type: 'thinking', delta: content }];
      }
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
    const events: AgentEvent[] = [];
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
    if (stopReason === 'error') {
      const messageText = stringValue(message.errorMessage) ?? this.lastError ?? 'pi model request failed';
      this.terminal = true;
      events.push(this.error(messageText));
    } else if (stopReason === 'aborted') {
      this.terminal = true;
      events.push(this.done('interrupted'));
    }
    return events;
  }

  private translateToolStart(raw: JsonRecord): AgentEvent[] {
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
    const attempt = numberValue(raw.attempt);
    const maxAttempts = numberValue(raw.maxAttempts);
    const delayMs = numberValue(raw.delayMs);
    if (attempt === undefined || maxAttempts === undefined || delayMs === undefined) return [];
    return [{ type: 'retry', attempt, maxAttempts, delayMs }];
  }

  private resetAssistantBlocks(): void {
    this.textBlocksWithDelta.clear();
    this.thinkingBlocksWithDelta.clear();
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
