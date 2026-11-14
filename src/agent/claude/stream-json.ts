import type { AgentEvent } from '../types';

interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

interface ClaudeRawEvent {
  type?: string;
  subtype?: string;
  session_id?: string;
  cwd?: string;
  model?: string;
  message?: { id?: string; content?: ContentBlock[] | string };
  parent_tool_use_id?: string | null;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
  };
  total_cost_usd?: number;
  is_error?: boolean;
  result?: string;
  errors?: string[];
  origin?: { kind?: string };
  content?: string;
  status?: string | null;
  compact_result?: string;
  compact_error?: string;
  compact_metadata?: { trigger?: string; pre_tokens?: number; post_tokens?: number };
  trigger?: string;
  original_model?: string;
  fallback_model?: string;
  attempt?: number;
  max_retries?: number;
  retry_delay_ms?: number;
  error_status?: number | null;
  error?: string;
  key?: string;
  text?: string;
  color?: string;
  tool_name?: string;
  decision_reason?: string;
}

/**
 * Claude emits content blocks separately, then repeats the final text in result.
 *
 * Claude has no separate commentary channel: text written before a tool call may
 * be the answer itself. With `answerIncludesInterimText`, earlier messages are
 * still released as progress and are also prepended to the final answer.
 */
export class ClaudeRunTranslator {
  private pendingText: string[] = [];
  private interimText: string[] = [];
  private messageId?: string;

  constructor(private readonly answerIncludesInterimText = false) {}

  *flushProgress(): Generator<AgentEvent> {
    if (this.answerIncludesInterimText) {
      const text = this.pendingText.join('');
      if (text.trim()) this.interimText.push(text);
    }
    for (const delta of this.pendingText) yield { type: 'text', delta };
    this.pendingText = [];
  }

  *translate(raw: unknown): Generator<AgentEvent> {
    if (!raw || typeof raw !== 'object') return;
    const event = raw as ClaudeRawEvent;
    // Nested task results cannot finish the parent, nor replace its pending answer.
    if (event.parent_tool_use_id) {
      if (event.type !== 'result') yield* translateEvent(event);
      return;
    }
    if (event.type === 'assistant') {
      const id = event.message?.id;
      if (id && this.messageId && id !== this.messageId) yield* this.flushProgress();
      this.messageId = id ?? this.messageId;
      const events = [...translateEvent(event)];
      if (events.some(e => e.type === 'tool_use')) {
        yield* this.flushProgress();
        if (this.answerIncludesInterimText) {
          const text = events.flatMap(e => e.type === 'text' ? [e.delta] : []).join('');
          if (text.trim()) this.interimText.push(text);
        }
        yield* events;
      } else {
        for (const e of events) {
          if (e.type === 'text') this.pendingText.push(e.delta);
          else yield e;
        }
      }
      return;
    }
    if (event.type === 'result') {
      if (!event.is_error && !event.subtype?.startsWith('error') && typeof event.result === 'string') {
        this.pendingText = [];
        const content = [...this.interimText, event.result].filter(text => text.trim()).join('\n\n');
        this.interimText = [];
        if (content) yield { type: 'final_text', content };
      } else yield* this.flushProgress();
    }
    yield* translateEvent(event);
  }

  /**
   * Release what was written before a wait on background tasks. The wait can
   * last hours, so the answer so far is handed over now instead of at the end.
   */
  *releaseHeld(): Generator<AgentEvent> {
    yield* this.flushProgress();
    const content = this.interimText.join('\n\n');
    this.interimText = [];
    if (content.trim()) yield { type: 'interim_answer', content };
  }

  /** Finish on a held result whose text was already released as progress. */
  *finishHeld(raw: unknown): Generator<AgentEvent> {
    const event = raw as ClaudeRawEvent;
    const content = this.answerIncludesInterimText ? this.interimText.join('\n\n') : event.result ?? '';
    this.pendingText = [];
    this.interimText = [];
    if (content.trim()) yield { type: 'final_text', content };
    yield* translateEvent(event);
  }
}

// Turns Claude starts by itself when a background task finishes. A resumed
// session also replays one, with an empty result, for each task orphaned by an
// earlier process before the prompt's own turn.
export function isTaskNotificationResult(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false;
  const evt = raw as ClaudeRawEvent;
  return evt.type === 'result' && evt.origin?.kind === 'task-notification';
}

export function* translateEvent(raw: unknown): Generator<AgentEvent> {
  if (!raw || typeof raw !== 'object') return;
  const evt = raw as ClaudeRawEvent;

  if (evt.type === 'system' && evt.subtype === 'init') {
    yield {
      type: 'system',
      sessionId: evt.session_id,
      cwd: evt.cwd,
      model: evt.model,
    };
    return;
  }

  if (evt.type === 'system') {
    yield* translateSystemNotice(evt);
    return;
  }

  if (evt.type === 'assistant' && Array.isArray(evt.message?.content)) {
    for (const block of evt.message.content) {
      // Thinking blocks carry the raw chain of thought. Codex only surfaces
      // provider-supplied reasoning summaries, so drop them here to keep the
      // two harnesses aligned on what reaches the CoT and other displays.
      if (block.type === 'thinking') continue;
      if (block.type === 'text' && typeof block.text === 'string' && block.text) {
        yield { type: 'text', delta: block.text };
      } else if (block.type === 'tool_use' && block.id && block.name) {
        yield { type: 'tool_use', id: block.id, name: block.name, input: block.input };
      }
    }
    return;
  }

  if (evt.type === 'user' && Array.isArray(evt.message?.content)) {
    for (const block of evt.message.content) {
      if (block.type === 'tool_result' && block.tool_use_id) {
        const output =
          typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
        yield {
          type: 'tool_result',
          id: block.tool_use_id,
          output,
          isError: block.is_error === true,
        };
      }
    }
    return;
  }

  if (evt.type === 'result') {
    if (evt.is_error || evt.subtype?.startsWith('error')) {
      yield { type: 'error', message: evt.errors?.join('\n') || evt.result || evt.subtype || 'Claude task failed', terminationReason: 'failed' };
      return;
    }
    if (evt.usage) {
      yield {
        type: 'usage',
        inputTokens: evt.usage.input_tokens,
        outputTokens: evt.usage.output_tokens,
        cachedInputTokens: evt.usage.cache_read_input_tokens,
        costUsd: evt.total_cost_usd,
      };
    }
    yield { type: 'done', sessionId: evt.session_id, terminationReason: 'normal' };
  }
}

const noticeLimit = 500;

function truncate(value: string): string {
  return value.length > noticeLimit ? `${value.slice(0, noticeLimit)}…` : value;
}

function tokens(value: number | undefined): string | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? `${Math.round(value / 1000)}K` : undefined;
}

/** Runtime notices Claude shows in its TUI but -p only reports as system events. */
function* translateSystemNotice(evt: ClaudeRawEvent): Generator<AgentEvent> {
  switch (evt.subtype) {
    case 'compact_boundary': {
      const meta = evt.compact_metadata ?? {};
      const before = tokens(meta.pre_tokens);
      const after = tokens(meta.post_tokens);
      const size = before ? `（${before}${after ? ` → ${after}` : ''} tokens）` : '';
      const kind = meta.trigger === 'manual' ? '上下文已压缩' : '上下文已自动压缩';
      yield { type: 'status', code: 'context_compaction', content: `🗜️ ${kind}${size}，任务继续执行。` };
      return;
    }
    case 'status':
      if (evt.compact_result === 'failed') {
        const detail = evt.compact_error ? `：${truncate(evt.compact_error)}` : '。';
        yield { type: 'status', code: 'context_compaction_failed', content: `⚠️ 上下文压缩失败${detail}` };
      }
      return;
    case 'api_retry': {
      if (typeof evt.attempt !== 'number' || typeof evt.max_retries !== 'number') return;
      const rateLimited = evt.error_status === 429 || evt.error === 'rate_limit';
      yield {
        type: 'retry',
        attempt: evt.attempt,
        maxAttempts: evt.max_retries,
        delayMs: Math.max(0, evt.retry_delay_ms ?? 0),
        failureKind: rateLimited ? 'rate_limit' : 'transient',
      };
      return;
    }
    case 'model_fallback':
    case 'model_refusal_fallback':
    case 'model_consent_fallback': {
      const route = evt.original_model && evt.fallback_model ? `${evt.original_model} → ${evt.fallback_model}` : '';
      const detail = evt.content?.trim();
      const content = !detail ? `模型已切换${route ? `：${route}` : '。'}`
        : route && !detail.includes(evt.fallback_model ?? '') ? `${truncate(detail)}（${route}）` : truncate(detail);
      yield { type: 'status', code: evt.subtype, content: `⚠️ ${content}` };
      return;
    }
    case 'model_refusal_no_fallback': {
      const detail = evt.content?.trim() || `${evt.original_model ?? '模型'} 拒绝了本次请求，且没有可用的降级模型。`;
      yield { type: 'status', code: evt.subtype, content: `⚠️ ${truncate(detail)}` };
      return;
    }
    case 'notification':
      if ((evt.color === 'error' || evt.color === 'warning') && evt.text?.trim()) {
        yield { type: 'status', code: `notification:${evt.key ?? ''}`, content: `⚠️ ${truncate(evt.text.trim())}` };
      }
      return;
    case 'permission_denied': {
      const reason = evt.decision_reason ? `：${truncate(evt.decision_reason)}` : '。';
      yield { type: 'status', code: 'tool-permission-denied', content: `⚠️ 工具 ${evt.tool_name ?? '未知'} 被拒绝执行${reason}` };
      return;
    }
  }
}
