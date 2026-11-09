import type { AgentEvent, AgentQuestion } from '../types';
import { CodexJsonlTranslator } from './jsonl';
import { log } from '../../core/logger';
import { summarizeCodexErrorInfo } from './error-info';
import { object, text, type AppServerRpc, type ObjectValue } from './app-server-rpc';

/** Event queue and thread/turn identity shared by one app-server run. */
export class AppServerRunState {
  readonly translator = new CodexJsonlTranslator();
  threadId: string | undefined;
  turnId: string | undefined;
  private readonly queue: AgentEvent[] = [];
  private readonly statuses = new Set<string>();
  private wake: (() => void) | undefined;
  private isEnded = false;

  constructor(private readonly onFinish: () => void) {}

  get ended(): boolean {
    return this.isEnded;
  }

  push(batch: AgentEvent[]): void {
    this.queue.push(...batch);
    this.wake?.();
    this.wake = undefined;
  }

  pushStatusOnce(code: string, content: string): void {
    if (this.isEnded || this.statuses.has(code)) return;
    this.statuses.add(code);
    this.push([{ type: 'status', code, content }]);
  }

  finish(batch: AgentEvent[]): void {
    if (this.isEnded) return;
    this.isEnded = true;
    this.push(batch);
    this.onFinish();
  }

  async *drain(): AsyncGenerator<AgentEvent> {
    while (!this.isEnded || this.queue.length) {
      if (this.queue.length) yield this.queue.shift()!;
      else await new Promise<void>(resolve => { this.wake = resolve; });
    }
  }
}

/** Routes app-server stdout lines: responses, server requests and notifications. */
export class AppServerProtocol {
  private readonly questionItems = new Set<string>();
  /** Server requests an earlier bridge process already answered. */
  private readonly answeredServerRequests = new Set<unknown>();

  constructor(
    private readonly state: AppServerRunState,
    private readonly rpc: AppServerRpc,
    private readonly onMessageDelta: (itemId: string, delta: string) => void,
  ) {}

  markServerRequestAnswered(id: unknown): void {
    this.answeredServerRequests.add(id);
  }

  handleLine(line: string): void {
    let message: ObjectValue;
    try { message = object(JSON.parse(line)); } catch { return; }
    if (typeof message.id === 'number' && !message.method) {
      this.rpc.handleResponse(message.id, message);
      return;
    }
    if (message.id !== undefined && message.method) {
      if (this.answeredServerRequests.has(message.id)) return;
      // This bridge has no approval/form UI. Never silently grant a server request.
      this.rpc.write({ id: message.id, error: { code: -32601, message: 'Interactive server requests are not supported by this bridge' } });
      return;
    }
    this.handleNotification(text(message.method), object(message.params));
  }

  /** Notifications are filtered in tiers: run-wide, then by thread, then by turn. */
  private handleNotification(method: string, p: ObjectValue): void {
    switch (method) {
      case 'account/rateLimits/updated':
        log.info('codex', 'rate-limits-updated', rateLimitFields(object(p.rateLimits)));
        return;
      case 'configWarning':
        log.warn('codex', 'config-warning', {
          summary: text(p.summary),
          details: text(p.details) || undefined,
          path: text(p.path) || undefined,
        });
        return;
    }
    const { state } = this;
    if (state.ended) return;
    const eventThreadId = text(p.threadId);
    if (eventThreadId && state.threadId && eventThreadId !== state.threadId) return;
    switch (method) {
      case 'warning': return this.onWarning(p, eventThreadId);
      case 'mcpServer/startupStatus/updated': return this.onMcpStartupStatus(p);
      case 'turn/started':
        state.turnId = text(object(p.turn).id) || state.turnId;
        return;
    }
    if (p.turnId && state.turnId && p.turnId !== state.turnId) return;
    switch (method) {
      case 'thread/status/changed': return this.onThreadStatus(p);
      case 'error': return this.onError(p);
      case 'item/agentMessage/delta': return this.onMessageDelta(text(p.itemId), text(p.delta));
      case 'item/started': return this.onItem(object(p.item), false);
      case 'item/completed': return this.onItem(object(p.item), true);
      case 'thread/tokenUsage/updated': return this.onTokenUsage(p);
      case 'turn/completed': return this.onTurnCompleted(object(p.turn));
    }
  }

  private onWarning(p: ObjectValue, eventThreadId: string): void {
    const warning = text(p.message) || 'Codex reported a warning';
    log.warn('codex', 'runtime-warning', { message: warning, eventThreadId: eventThreadId || undefined });
    this.state.pushStatusOnce(`codex_warning:${warning}`, `⚠️ ${truncate(warning, 500)}`);
  }

  private onMcpStartupStatus(p: ObjectValue): void {
    const name = text(p.name) || 'unknown';
    const status = text(p.status);
    const failureReason = text(p.failureReason);
    const error = text(p.error);
    if (status === 'failed') {
      log.warn('codex', 'mcp-startup-failed', { serverName: name, status, failureReason: failureReason || undefined, error: error || undefined });
      this.state.pushStatusOnce(
        `mcp_startup_failed:${name}:${failureReason || error}`,
        failureReason === 'reauthenticationRequired'
          ? `⚠️ MCP 服务 ${name} 需要重新授权，相关工具暂时不可用。`
          : `⚠️ MCP 服务 ${name} 启动失败${error ? `：${truncate(error, 300)}` : '。'}`,
      );
    } else {
      log.info('codex', 'mcp-startup-status', { serverName: name, status, failureReason: failureReason || undefined });
    }
  }

  private onThreadStatus(p: ObjectValue): void {
    const threadStatus = object(p.status);
    const status = text(threadStatus.type) || 'unknown';
    const activeFlags = Array.isArray(threadStatus.activeFlags)
      ? threadStatus.activeFlags.filter((value): value is string => typeof value === 'string')
      : undefined;
    const fields = {
      threadStatus: status,
      activeFlags,
    };
    if (status === 'systemError') {
      log.warn('codex', 'thread-status', fields);
      this.state.pushStatusOnce('thread_system_error', '⚠️ Codex thread 进入系统错误状态，任务可能无法继续。');
    } else {
      log.info('codex', 'thread-status', fields);
    }
  }

  private onError(p: ObjectValue): void {
    const error = object(p.error);
    const message = text(error.message) || 'Codex reported an error';
    const summary = summarizeCodexErrorInfo(error);
    log.warn('codex', 'error-notification', {
      message,
      willRetry: p.willRetry === true,
      additionalDetails: text(error.additionalDetails) || undefined,
      ...summary,
    });
    this.state.translator.recordError(message, summary.failureKind);
    if (p.willRetry === true) {
      this.state.pushStatusOnce('codex_retry', '⚠️ Codex 请求失败，正在自动重试。');
    }
  }

  private onItem(item: ObjectValue, completed: boolean): void {
    const { state } = this;
    if (item.type === 'agentMessage' && completed) {
      this.onAgentMessageCompleted(item);
    } else if (item.type === 'commandExecution') {
      state.push(state.translator.translate({ type: completed ? 'item.completed' : 'item.started', item: {
        ...item, type: 'command_execution', aggregated_output: item.aggregatedOutput, exit_code: item.exitCode,
      } }));
    } else if (item.type === 'reasoning' && completed) {
      const summary = Array.isArray(item.summary) ? item.summary.filter(x => typeof x === 'string').join('\n') : '';
      if (summary) state.push([{ type: 'thinking', delta: summary }]);
    } else if (item.type === 'contextCompaction' && completed) {
      state.push([{
        type: 'status',
        code: 'context_compaction',
        content: '上下文已自动压缩，任务继续执行。',
      }]);
    } else if (['mcpToolCall', 'dynamicToolCall', 'fileChange'].includes(text(item.type))) {
      const id = text(item.id);
      state.push(completed ? [{ type: 'tool_result', id, output: JSON.stringify(item.result ?? item.contentItems ?? item.changes ?? item.error ?? ''), isError: item.status === 'failed' || item.success === false }]
        : [{ type: 'tool_use', id, name: text(item.tool) || text(item.type), input: item.arguments ?? item.changes }]);
    }
  }

  private onAgentMessageCompleted(item: ObjectValue): void {
    const { state } = this;
    const questions = parseAsyncQuestions(item.questions);
    if (questions.length && text(item.id)) {
      const id = text(item.id);
      if (!this.questionItems.has(id)) {
        this.questionItems.add(id);
        state.push([{ type: 'user_input', id, mode: 'async', threadId: state.threadId!, questions }]);
      }
    } else {
      state.push(state.translator.translate({ type: 'item.completed', item: { ...item, type: 'agent_message' } }));
    }
  }

  private onTokenUsage(p: ObjectValue): void {
    const tokenUsage = object(p.tokenUsage);
    const usage = object(tokenUsage.last);
    this.state.push([{ type: 'usage', inputTokens: Number(usage.inputTokens) || 0, outputTokens: Number(usage.outputTokens) || 0,
      cachedInputTokens: Number(usage.cachedInputTokens) || 0, reasoningOutputTokens: Number(usage.reasoningOutputTokens) || 0,
      contextWindowTokens: Number(tokenUsage.modelContextWindow) || undefined }]);
  }

  private onTurnCompleted(turn: ObjectValue): void {
    const { state } = this;
    if (state.turnId && turn.id !== state.turnId) return;
    state.turnId = undefined;
    if (turn.status === 'completed') {
      state.finish(state.translator.translate({ type: 'turn.completed' }));
    } else if (turn.status === 'interrupted') {
      state.finish(state.translator.finish('interrupted'));
    } else {
      const error = object(turn.error);
      const message = text(error.message) || 'Codex turn failed';
      const summary = summarizeCodexErrorInfo(error);
      log.warn('codex', 'turn-failed', {
        message,
        additionalDetails: text(error.additionalDetails) || undefined,
        ...summary,
      });
      state.finish(state.translator.fail(message, summary.failureKind));
    }
  }
}

function rateLimitFields(value: ObjectValue): ObjectValue {
  const primary = object(value.primary);
  const secondary = object(value.secondary);
  return {
    limitId: text(value.limitId) || undefined,
    limitName: text(value.limitName) || undefined,
    planType: text(value.planType) || undefined,
    primaryUsedPercent: numberValue(primary.usedPercent),
    secondaryUsedPercent: numberValue(secondary.usedPercent),
    rateLimitReachedType: text(value.rateLimitReachedType) || undefined,
    spendControlReached: typeof value.spendControlReached === 'boolean' ? value.spendControlReached : undefined,
  };
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function parseAsyncQuestions(value: unknown): AgentQuestion[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(raw => {
    const q = object(raw);
    if (!text(q.title).trim()) return [];
    const options = Array.isArray(q.options) ? q.options.filter((v): v is string => typeof v === 'string' && Boolean(v.trim())) : [];
    return [{ question: text(q.title), options: options.map(label => ({ label })) }];
  });
}
