import type { AgentEvent } from '../agent/types';
import { retryStatus } from '../card/run-state';
import type { CotMessagesMode, TenantBrand } from '../config/schema';
import { log } from '../core/logger';
import { toolHeaderText } from '../card/tool-render';
import type { RunState } from '../card/run-state';
import {
  TenantTokenProvider,
  larkOpenApiOrigin,
} from '../lark-auth/tenant-token';

const COT_UPDATE_THROTTLE_MS = 600;
// COT validates content in UTF-8 bytes, not JavaScript characters. Keeping
// every individual text field below this conservative bound avoids an
// otherwise valid Chinese response being rejected as "content too long".
const COT_CONTENT_MAX_BYTES = 1000;
// Bounds every CoT HTTP call. Without it a hung message_cot endpoint pins
// start() — which runs before any agent event is drained and before the
// plain-reply fallback — to undici's ~300s default.
const COT_REQUEST_TIMEOUT_MS = 15_000;

export class CotClient {
  private readonly baseUrl: string;
  private readonly tenantTokens: TenantTokenProvider;

  constructor(opts: {
    tenant: TenantBrand;
    appId: string;
    appSecret: string;
    tenantTokens?: TenantTokenProvider;
  }) {
    this.baseUrl = larkOpenApiOrigin(opts.tenant);
    this.tenantTokens = opts.tenantTokens ?? new TenantTokenProvider(opts);
  }

  async tenantToken(): Promise<string> {
    return this.tenantTokens.getToken();
  }

  async request(path: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
    const token = await this.tenantToken();
    const resp = await fetch(`${this.baseUrl}${path}`, {
      signal: AbortSignal.timeout(COT_REQUEST_TIMEOUT_MS),
      ...init,
      headers: {
        'Content-Type': 'application/json;charset=utf-8',
        Authorization: `Bearer ${token}`,
        ...(init.headers ?? {}),
      },
    });
    if (!resp.ok) throw new Error(`COT HTTP ${resp.status}`);
    const text = await resp.text();
    if (!text) return {};
    const data = JSON.parse(text) as { code?: number; msg?: string; data?: Record<string, unknown> } & Record<string, unknown>;
    if (data.code !== undefined && data.code !== 0) {
      throw new Error(`COT API failed: code=${data.code} msg=${data.msg ?? '<no msg>'}`);
    }
    return data.data ?? data;
  }

  async create(chatId: string, originMessageId?: string): Promise<Record<string, unknown>> {
    // message_cot only accepts receive_id_type=chat_id. thread_id is NOT a
    // valid receive type for this endpoint (it exists only on the forward
    // APIs) — addressing the create to an omt_* thread id is rejected with
    // code=10002 "Bot/User can NOT be out of the chat" (the backend tries to
    // resolve the omt_* id as a chat the bot belongs to and finds none).
    //
    // Placement inside a topic is instead governed by origin_message_id: the
    // bubble inherits the topic of the message it originates from. Passing an
    // in-topic message id keeps the bubble in the topic; the topic's root
    // (首楼) message has no thread of its own, so a bubble originated from it
    // lands at the group top level. Callers pick origin_message_id
    // accordingly.
    return this.request('/open-apis/im/v1/message_cot?receive_id_type=chat_id', {
      method: 'POST',
      body: JSON.stringify({
        receive_id: chatId,
        ...(originMessageId ? { origin_message_id: originMessageId } : {}),
      }),
    });
  }

  async update(ref: CotRef, events: readonly CotEvent[]): Promise<void> {
    if (events.length === 0) return;
    await this.request('/open-apis/im/v1/message_cot', {
      method: 'PUT',
      body: JSON.stringify({
        cot_id: ref.cotId,
        message_id: ref.messageId,
        events,
      }),
    });
  }

  async complete(ref: CotRef, reason: string): Promise<void> {
    const cotId = encodeURIComponent(ref.cotId);
    const messageId = encodeURIComponent(ref.messageId);
    await this.request(`/open-apis/im/v1/message_cot/complete/${cotId}?message_id=${messageId}&reason=${reason}`, {
      method: 'POST',
      body: '',
    });
  }
}

interface CotRef {
  cotId: string;
  messageId: string;
}

interface CotEvent {
  event_type: string;
  content: string;
  timestamp: number;
}

export class CotPublisher {
  private readonly client: Pick<CotClient, 'create' | 'update' | 'complete'>;
  readonly chatId: string;
  readonly originMessageId: string;
  runId: string;
  scope: string;
  inputPreview: string;
  ref: CotRef | undefined;
  disabled = false;
  private buffer: CotEvent[] = [];
  private flushing: Promise<void> | undefined;
  private timer: NodeJS.Timeout | undefined;
  private preparation: Promise<void> | undefined;
  private started = false;
  private finishing: Promise<void> | undefined;
  private updateFailureCount = 0;

  constructor(opts: {
    client: Pick<CotClient, 'create' | 'update' | 'complete'>;
    chatId: string;
    originMessageId: string;
    runId?: string;
    scope?: string;
    inputPreview?: string;
  }) {
    this.client = opts.client;
    this.chatId = opts.chatId;
    this.originMessageId = opts.originMessageId;
    this.runId = opts.runId ?? '';
    this.scope = opts.scope ?? '';
    this.inputPreview = opts.inputPreview ?? '';
  }

  bind(input: { runId: string; scope: string; inputPreview: string }): void {
    this.runId = input.runId;
    this.scope = input.scope;
    this.inputPreview = input.inputPreview;
  }

  prepare(): Promise<void> {
    if (this.preparation) return this.preparation;
    this.preparation = this.createBubble();
    return this.preparation;
  }

  private async createBubble(): Promise<void> {
    // Single chat_id-addressed create. In topics the bubble follows
    // originMessageId's thread (see CotClient.create); the caller passes an
    // in-topic origin so it lands in the topic. On any failure we disable CoT
    // and let the caller fall back to a plain reply — never retry, since a
    // create that failed after committing server-side would leave a duplicate
    // bubble spinning forever.
    let created: Record<string, unknown>;
    try {
      created = await this.client.create(this.chatId, this.originMessageId);
    } catch (err) {
      this.disabled = true;
      log.warn('cot', 'create-failed', { err: err instanceof Error ? err.message : String(err) });
      return;
    }
    const cotId = stringValue(created.cot_id ?? created.cotId);
    const messageId = stringValue(created.message_id ?? created.messageId);
    if (!cotId || !messageId) {
      this.disabled = true;
      log.warn('cot', 'create-failed', {
        err: `CreateCOT missing ids: ${JSON.stringify(created).slice(0, 200)}`,
      });
      return;
    }
    this.ref = { cotId, messageId };
    log.info('cot', 'created', { cotId, messageId });
  }

  async start(): Promise<void> {
    await this.prepare();
    if (this.disabled || !this.ref || this.started) return;
    this.started = true;
    this.enqueue('RUN_STARTED', {
      threadId: this.scope,
      runId: this.runId,
      input: { query: truncateCot(this.inputPreview, COT_CONTENT_MAX_BYTES) },
    });
    this.enqueue('STEP_STARTED', {
      stepId: `step-understand-${this.runId}`,
      stepName: '理解用户问题',
    });
  }

  enqueue(eventType: string, content: unknown): void {
    if (this.disabled || !this.ref) return;
    this.buffer.push({
      event_type: eventType,
      content: JSON.stringify(content),
      timestamp: Date.now(),
    });
    this.scheduleFlush();
  }

  async finish(reason: string): Promise<void> {
    if (this.finishing) return this.finishing;
    this.finishing = this.finishOnce(reason);
    return this.finishing;
  }

  private async finishOnce(reason: string): Promise<void> {
    await this.prepare();
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    await this.flush();
    if (this.disabled || !this.ref) return;
    try {
      await this.client.complete(this.ref, reason);
      log.info('cot', 'completed', { cotId: this.ref.cotId, reason });
    } catch (err) {
      log.warn('cot', 'complete-failed', { err: err instanceof Error ? err.message : String(err) });
    }
  }

  private scheduleFlush(): void {
    if (this.timer || this.flushing) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, COT_UPDATE_THROTTLE_MS);
  }

  private async flush(): Promise<void> {
    if (this.disabled || !this.ref) return;
    if (this.flushing) {
      await this.flushing;
      if (this.buffer.length > 0 && !this.disabled) await this.flush();
      return;
    }
    const events = this.buffer.splice(0);
    if (events.length === 0) return;
    this.flushing = this.client.update(this.ref, events)
      .then(() => {
        if (this.updateFailureCount > 0) {
          log.info('cot', 'update-recovered', { afterFailures: this.updateFailureCount });
        }
        this.updateFailureCount = 0;
      })
      .catch((err) => {
        this.updateFailureCount++;
        // Progress updates are best effort and the API has no replay
        // idempotency key. Drop this failed batch rather than risk appending
        // it twice after an ambiguous timeout; future progress can still
        // update the same COT bubble and finish will still close it.
        if (this.updateFailureCount === 1 || this.updateFailureCount % 10 === 0) {
          log.warn('cot', 'update-failed', {
            err: err instanceof Error ? err.message : String(err),
            consecutiveFailures: this.updateFailureCount,
            droppedEvents: events.length,
          });
        }
      })
      .finally(() => {
        this.flushing = undefined;
        if (this.buffer.length > 0 && !this.disabled) this.scheduleFlush();
      });
    await this.flushing;
  }
}

export function finalAnswerOnlyState(state: RunState): RunState {
  return {
    ...state,
    blocks: state.finalText
      ? [{ kind: 'text', content: state.finalText, streaming: false }]
      : state.blocks.filter((b) => b.kind === 'text'),
    reasoning: { content: '', active: false },
    footer: null,
  };
}

export async function consumeCotEvents(
  events: AsyncIterable<AgentEvent>,
  publisher: CotPublisher,
  opts: { detail: CotMessagesMode },
): Promise<void> {
  let reasoningOpen = false;
  let textStepOpen = false;
  let textMessageOpen = false;
  let textMessageIndex = 0;
  let retryMessageIndex = 0;
  let textMessageId: string | undefined;
  const toolBrief = new Map<string, { name: string; input: unknown }>();
  const reasoningMessageId = `reasoning-${publisher.runId}`;
  const finalStepId = `step-process-${publisher.runId}`;

  try {
    for await (const evt of events) {
      if (evt.type === 'system' || evt.type === 'usage') continue;
      if (evt.type === 'retry') {
        closeReasoningIfNeeded();
        closeTextIfNeeded();
        const messageId = `retry-${publisher.runId}-${++retryMessageIndex}`;
        publisher.enqueue('TEXT_MESSAGE_START', { messageId, role: 'assistant' });
        publisher.enqueue('TEXT_MESSAGE_CONTENT', { messageId, delta: retryStatus(evt) });
        publisher.enqueue('TEXT_MESSAGE_END', { messageId });
        continue;
      }
      if (evt.type === 'thinking') {
        closeTextIfNeeded();
        if (!reasoningOpen) {
          reasoningOpen = true;
          publisher.enqueue('REASONING_START', { messageId: reasoningMessageId });
          publisher.enqueue('REASONING_MESSAGE_START', {
            messageId: reasoningMessageId,
            role: 'reasoning',
          });
        }
        publisher.enqueue('REASONING_MESSAGE_CONTENT', {
          messageId: reasoningMessageId,
          delta: truncateCot(evt.delta, COT_CONTENT_MAX_BYTES),
        });
        continue;
      }
      if (evt.type === 'tool_use') {
        closeReasoningIfNeeded();
        closeTextIfNeeded();
        const toolCallId = evt.id;
        const detailed = opts.detail === 'detailed';
        const showSummary = opts.detail === 'brief' || detailed;
        const title = showSummary ? cotBriefToolTitle(evt.name, evt.input, 'running') : '正在调用工具';
        toolBrief.set(toolCallId, { name: evt.name, input: evt.input });
        publisher.enqueue('TOOL_CALL_START', {
          toolCallId,
          icon: showSummary ? cotToolIcon(evt.name) : 'default',
          title: truncateCot(title, COT_CONTENT_MAX_BYTES),
          toolCallName: truncateCot(showSummary ? evt.name : 'tool', COT_CONTENT_MAX_BYTES),
        });
        if (detailed && evt.input !== undefined) {
          publisher.enqueue('TOOL_CALL_ARGS', {
            toolCallId,
            delta: truncateCot(JSON.stringify(evt.input), COT_CONTENT_MAX_BYTES),
          });
        }
        publisher.enqueue('TOOL_CALL_END', { toolCallId });
        continue;
      }
      if (evt.type === 'tool_result') {
        const detailed = opts.detail === 'detailed';
        const brief = toolBrief.get(evt.id);
        publisher.enqueue('TOOL_CALL_RESULT', {
          messageId: `tool-result-${evt.id}`,
          toolCallId: evt.id,
          role: 'tool',
          content: detailed
            ? truncateCot(evt.output ?? '', COT_CONTENT_MAX_BYTES)
            : brief
              ? truncateCot(
                  cotBriefToolTitle(brief.name, brief.input, evt.isError ? 'error' : 'done'),
                  COT_CONTENT_MAX_BYTES,
                )
              : '工具调用已完成',
        });
        toolBrief.delete(evt.id);
        continue;
      }
      if (evt.type === 'text') {
        closeReasoningIfNeeded();
        if (!textStepOpen) {
          textStepOpen = true;
          publisher.enqueue('STEP_STARTED', {
            stepId: finalStepId,
            stepName: '输出过程',
          });
        }
        if (!textMessageOpen) {
          textMessageOpen = true;
          textMessageId = `text-${publisher.runId}-${++textMessageIndex}`;
          publisher.enqueue('TEXT_MESSAGE_START', { messageId: textMessageId, role: 'assistant' });
        }
        publisher.enqueue('TEXT_MESSAGE_CONTENT', {
          messageId: textMessageId,
          delta: truncateCot(evt.delta, COT_CONTENT_MAX_BYTES),
        });
        continue;
      }
      if (evt.type === 'final_text') continue;
      if (evt.type === 'done' || evt.type === 'error') {
        closeReasoningIfNeeded();
        closeTextIfNeeded();
        if (textStepOpen) {
          publisher.enqueue('STEP_FINISHED', {
            stepId: finalStepId,
            stepName: '输出过程',
          });
        }
        if (evt.type === 'error') {
          publisher.enqueue('RUN_ERROR', {
            message: truncateCot(evt.message, COT_CONTENT_MAX_BYTES),
            code: evt.terminationReason ?? 'error',
          });
          await publisher.finish('error');
        } else {
          const status = evt.terminationReason === 'normal' ? 'done' : evt.terminationReason ?? 'done';
          publisher.enqueue('RUN_FINISHED', {
            threadId: publisher.scope,
            runId: publisher.runId,
            status,
          });
          await publisher.finish(status === 'done' ? 'done' : 'error');
        }
        return;
      }
    }
    closeReasoningIfNeeded();
    closeTextIfNeeded();
    await publisher.finish('done');
  } catch (err) {
    log.warn('cot', 'consume-failed', { err: err instanceof Error ? err.message : String(err) });
    await publisher.finish('error');
  }

  function closeReasoningIfNeeded(): void {
    if (!reasoningOpen) return;
    reasoningOpen = false;
    publisher.enqueue('REASONING_MESSAGE_END', { messageId: reasoningMessageId });
    publisher.enqueue('REASONING_END', { messageId: reasoningMessageId });
  }

  function closeTextIfNeeded(): void {
    if (!textMessageOpen || !textMessageId) return;
    publisher.enqueue('TEXT_MESSAGE_END', { messageId: textMessageId });
    textMessageOpen = false;
    textMessageId = undefined;
  }
}

export function cotBriefToolTitle(
  name: string,
  input: unknown,
  status: 'running' | 'done' | 'error' = 'running',
): string {
  return toolHeaderText({ id: 'cot-tool', name, input, status }).replace(/\*\*/g, '');
}

function cotToolIcon(name: string): string {
  const lower = String(name ?? '').toLowerCase();
  if (lower.includes('search') || lower.includes('grep') || lower.includes('rg')) return 'search';
  if (lower.includes('read')) return 'read';
  if (lower.includes('write') || lower.includes('edit')) return 'write';
  if (lower.includes('doc')) return 'doc';
  if (lower.includes('calendar')) return 'calendar';
  if (lower.includes('task')) return 'task';
  if (lower.includes('command') || lower.includes('bash')) return 'bash';
  return 'default';
}

function truncateCot(value: unknown, maxBytes: number): string {
  const text = String(value ?? '');
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  const suffix = '...';
  let end = Math.min(text.length, Math.max(0, maxBytes - suffix.length));
  while (end > 0 && Buffer.byteLength(`${text.slice(0, end)}${suffix}`, 'utf8') > maxBytes) {
    end--;
  }
  return `${text.slice(0, end)}${suffix}`;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
