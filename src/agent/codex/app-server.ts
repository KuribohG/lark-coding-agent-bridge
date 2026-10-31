import { terminateChild } from '../../platform/terminate';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import type { SpawnedProcessByStdio } from '../../platform/spawn';
import { spawnWithDeadline } from '../deadline';
import type { AgentEvent, AgentRun, AgentRunOptions } from '../types';
import { CodexJsonlTranslator } from './jsonl';
import { getBuildInfo } from '../../build-info';
import { log } from '../../core/logger';
import {
  isActiveTurnNotSteerable,
  summarizeCodexErrorInfo,
  type CodexErrorSummary,
} from './error-info';

type ObjectValue = Record<string, unknown>;
const object = (v: unknown): ObjectValue => v !== null && typeof v === 'object' ? v as ObjectValue : {};
const text = (v: unknown): string => typeof v === 'string' ? v : '';
const THREAD_SOURCE = 'appServer';
const SERVICE_NAME = 'lark-channel-bridge';
// App-server Unix sockets speak WebSocket, while Bridge's protocol adapter is
// JSONL over stdio. Keep this translation local so daemon lifecycle stays owned
// by Codex. On Windows its native byte proxy provides the AF_UNIX connection.
const WS_PROXY = fileURLToPath(new URL(
  import.meta.url.endsWith('.ts')
    ? '../../../bin/codex-app-server-ws-proxy.mjs'
    : '../bin/codex-app-server-ws-proxy.mjs',
  import.meta.url,
));

class RpcError extends Error {
  readonly method: string;
  readonly code: unknown;
  readonly data: unknown;
  readonly codexError: CodexErrorSummary;

  constructor(message: string, input: {
    method: string;
    code?: unknown;
    data?: unknown;
    codexError?: CodexErrorSummary;
  }) {
    super(message);
    this.name = 'RpcError';
    this.method = input.method;
    this.code = input.code;
    this.data = input.data;
    this.codexError = input.codexError ?? {};
  }
}

/**
 * In daemon mode each run is a short-lived proxy to Codex's persistent
 * app-server. In per-run mode the app-server is scoped to this run and must
 * not create background memory jobs that would die with the process.
 */
export function startAppServerRun(input: {
  binary: string;
  opts: AgentRunOptions;
  env: NodeJS.ProcessEnv;
  sandbox: string;
  appServerMode?: 'daemon' | 'per-run';
  daemonSocketPath?: string;
  prompt: string;
  developerInstructions?: string;
  modelProviderId?: string;
  initialNotice?: string;
  threadConfig?: Readonly<Record<string, unknown>>;
  stopGraceMs: number;
  configOverrides?: readonly string[];
}): AgentRun {
  const { opts } = input;
  const appServerMode = input.appServerMode ?? 'per-run';
  let command = input.binary;
  const args = appServerMode === 'daemon'
    ? (() => {
        if (!input.daemonSocketPath) throw new Error('daemon app-server socket path is required');
        return [WS_PROXY, input.daemonSocketPath, ...(process.platform === 'win32' ? [input.binary] : [])];
      })()
    : ['app-server', '--listen', 'stdio://',
        '-c', 'approval_policy="never"', '-c', 'shell_environment_policy.inherit="all"'];
  if (appServerMode === 'daemon') {
    command = process.execPath;
  } else {
    for (const override of input.configOverrides ?? []) args.push('-c', override);
  }
  if (appServerMode === 'per-run') {
    // Existing memories and startup processing remain available, but this
    // short-lived process must not add its own thread as a generation input.
    args.push('-c', 'memories.generate_memories=false');
  }
  if (opts.forkSession && appServerMode === 'per-run') args.push('-c', 'features.goals=false');
  const child = spawnWithDeadline(command, args, {
    cwd: opts.cwd, env: input.env, stdio: ['pipe', 'pipe', 'pipe'],
  }, opts.deadlineAt) as SpawnedProcessByStdio<Writable, Readable, Readable>;
  const translator = new CodexJsonlTranslator();
  const questionItems = new Set<string>();
  const events: AgentEvent[] = [];
  let wake: (() => void) | undefined;
  let ended = false;
  let stopping = false;
  let stopPromise: Promise<void> | undefined;
  let threadId: string | undefined;
  let turnId: string | undefined;
  let nextId = 0;
  let stderr = '';
  let exited = false;
  let resolveExit!: () => void;
  const exit = new Promise<void>(resolve => { resolveExit = resolve; });
  const pending = new Map<number, {
    resolve(value: ObjectValue): void;
    reject(error: Error): void;
    timer: NodeJS.Timeout;
    method: string;
  }>();
  const statuses = new Set<string>();
  const push = (batch: AgentEvent[]) => {
    events.push(...batch);
    wake?.();
    wake = undefined;
  };
  const pushStatusOnce = (code: string, content: string) => {
    if (ended || statuses.has(code)) return;
    statuses.add(code);
    push([{ type: 'status', code, content }]);
  };
  const finish = (batch: AgentEvent[]) => {
    if (ended) return;
    ended = true;
    push(batch);
    child.stdin.end();
  };
  const failPending = (error: Error) => {
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(error); }
    pending.clear();
  };
  const write = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);
  const request = (method: string, params: unknown, timeoutMs = 30_000): Promise<ObjectValue> => {
    if (exited || ended) return Promise.reject(new Error('app-server connection closed'));
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`app-server ${method} acknowledgement timed out; delivery is unknown`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer, method });
      write({ id, method, params });
    });
  };
  const onExit = () => {
    if (exited) return;
    exited = true;
    resolveExit();
    failPending(new Error('app-server disconnected; delivery is unknown'));
    if (!ended) finish(stopping ? translator.finish('interrupted')
      : opts.deadlineAt !== undefined && child.exitCode === 124 ? translator.finish('timeout')
      : translator.fail(`app-server exited before completion${stderr ? `: ${stderr}` : ''}`));
  };
  child.once('error', (error) => { finish(translator.fail(`app-server spawn failed: ${error.message}`)); onExit(); });
  child.once('close', onExit);
  child.stdin.on('error', () => failPending(new Error('app-server input closed; delivery is unknown')));
  child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-2000); });

  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on('line', (line) => {
    let message: ObjectValue;
    try { message = object(JSON.parse(line)); } catch { return; }
    if (typeof message.id === 'number' && !message.method) {
      const p = pending.get(message.id);
      if (!p) return;
      pending.delete(message.id);
      clearTimeout(p.timer);
      if (message.error) {
        const rpcError = object(message.error);
        const data = rpcError.data;
        p.reject(new RpcError(text(rpcError.message) || 'app-server rejected request', {
          method: p.method,
          code: rpcError.code,
          data,
          codexError: summarizeCodexErrorInfo(data),
        }));
      }
      else p.resolve(object(message.result));
      return;
    }
    if (message.id !== undefined && message.method) {
      // This bridge has no approval/form UI. Never silently grant a server request.
      write({ id: message.id, error: { code: -32601, message: 'Interactive server requests are not supported by this bridge' } });
      return;
    }
    const method = text(message.method);
    const p = object(message.params);
    if (method === 'account/rateLimits/updated') {
      log.info('codex', 'rate-limits-updated', rateLimitFields(object(p.rateLimits)));
      return;
    }
    if (method === 'configWarning') {
      log.warn('codex', 'config-warning', {
        summary: text(p.summary),
        details: text(p.details) || undefined,
        path: text(p.path) || undefined,
      });
      return;
    }
    if (ended) return;
    const eventThreadId = text(p.threadId);
    if (eventThreadId && threadId && eventThreadId !== threadId) return;
    if (method === 'warning') {
      const warning = text(p.message) || 'Codex reported a warning';
      log.warn('codex', 'runtime-warning', { message: warning, eventThreadId: eventThreadId || undefined });
      pushStatusOnce(`codex_warning:${warning}`, `⚠️ ${truncate(warning, 500)}`);
      return;
    }
    if (method === 'mcpServer/startupStatus/updated') {
      const name = text(p.name) || 'unknown';
      const status = text(p.status);
      const failureReason = text(p.failureReason);
      const error = text(p.error);
      if (status === 'failed') {
        log.warn('codex', 'mcp-startup-failed', { serverName: name, status, failureReason: failureReason || undefined, error: error || undefined });
        pushStatusOnce(
          `mcp_startup_failed:${name}:${failureReason || error}`,
          failureReason === 'reauthenticationRequired'
            ? `⚠️ MCP 服务 ${name} 需要重新授权，相关工具暂时不可用。`
            : `⚠️ MCP 服务 ${name} 启动失败${error ? `：${truncate(error, 300)}` : '。'}`,
        );
      } else {
        log.info('codex', 'mcp-startup-status', { serverName: name, status, failureReason: failureReason || undefined });
      }
      return;
    }
    if (method === 'turn/started') {
      turnId = text(object(p.turn).id) || turnId;
      return;
    }
    if (p.turnId && turnId && p.turnId !== turnId) return;
    if (method === 'thread/status/changed') {
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
        pushStatusOnce('thread_system_error', '⚠️ Codex thread 进入系统错误状态，任务可能无法继续。');
      } else {
        log.info('codex', 'thread-status', fields);
      }
    } else if (method === 'error') {
      const error = object(p.error);
      const message = text(error.message) || 'Codex reported an error';
      const summary = summarizeCodexErrorInfo(error);
      log.warn('codex', 'error-notification', {
        message,
        willRetry: p.willRetry === true,
        additionalDetails: text(error.additionalDetails) || undefined,
        ...summary,
      });
      translator.recordError(message, summary.failureKind);
      if (p.willRetry === true) {
        pushStatusOnce('codex_retry', '⚠️ Codex 请求失败，正在自动重试。');
      }
    } else if (method === 'item/agentMessage/delta') {
      opts.onMessageDelta?.(text(p.itemId), text(p.delta));
    } else if (method === 'item/started' || method === 'item/completed') {
      const item = object(p.item);
      const completed = method === 'item/completed';
      if (item.type === 'agentMessage' && completed) {
        const questions = parseAsyncQuestions(item.questions);
        if (questions.length && text(item.id)) {
          const id = text(item.id);
          if (!questionItems.has(id)) {
            questionItems.add(id);
            push([{ type: 'user_input', id, threadId: threadId!, questions }]);
          }
        } else {
          push(translator.translate({ type: 'item.completed', item: { ...item, type: 'agent_message' } }));
        }
      } else if (item.type === 'commandExecution') {
        push(translator.translate({ type: completed ? 'item.completed' : 'item.started', item: {
          ...item, type: 'command_execution', aggregated_output: item.aggregatedOutput, exit_code: item.exitCode,
        } }));
      } else if (item.type === 'reasoning' && completed) {
        const summary = Array.isArray(item.summary) ? item.summary.filter(x => typeof x === 'string').join('\n') : '';
        if (summary) push([{ type: 'thinking', delta: summary }]);
      } else if (item.type === 'contextCompaction' && completed) {
        push([{
          type: 'status',
          code: 'context_compaction',
          content: '上下文已自动压缩，任务继续执行。',
        }]);
      } else if (['mcpToolCall', 'dynamicToolCall', 'fileChange'].includes(text(item.type))) {
        const id = text(item.id);
        push(completed ? [{ type: 'tool_result', id, output: JSON.stringify(item.result ?? item.contentItems ?? item.changes ?? item.error ?? ''), isError: item.status === 'failed' || item.success === false }]
          : [{ type: 'tool_use', id, name: text(item.tool) || text(item.type), input: item.arguments ?? item.changes }]);
      }
    } else if (method === 'thread/tokenUsage/updated') {
      const tokenUsage = object(p.tokenUsage);
      const usage = object(tokenUsage.last);
      push([{ type: 'usage', inputTokens: Number(usage.inputTokens) || 0, outputTokens: Number(usage.outputTokens) || 0,
        cachedInputTokens: Number(usage.cachedInputTokens) || 0, reasoningOutputTokens: Number(usage.reasoningOutputTokens) || 0,
        contextWindowTokens: Number(tokenUsage.modelContextWindow) || undefined }]);
    } else if (method === 'turn/completed') {
      const turn = object(p.turn);
      if (turnId && turn.id !== turnId) return;
      turnId = undefined;
      if (turn.status === 'completed') {
        finish(translator.translate({ type: 'turn.completed' }));
      } else if (turn.status === 'interrupted') {
        finish(translator.finish('interrupted'));
      } else {
        const error = object(turn.error);
        const message = text(error.message) || 'Codex turn failed';
        const summary = summarizeCodexErrorInfo(error);
        log.warn('codex', 'turn-failed', {
          message,
          additionalDetails: text(error.additionalDetails) || undefined,
          ...summary,
        });
        finish(translator.fail(message, summary.failureKind));
      }
    }
  });

  const ready = (async () => {
    await request('initialize', {
      clientInfo: {
        name: 'lark_channel_bridge',
        title: 'Lark Channel Bridge',
        version: getBuildInfo().version,
      },
    });
    write({ method: 'initialized' });
    if (input.initialNotice) pushStatusOnce('provider-restart-required', input.initialNotice);
    if (stopping) return;
    const creatingThread = !opts.threadId;
    const threadParams = {
      ...(opts.threadId ? { threadId: opts.threadId, excludeTurns: true } : {}),
      ...(opts.forkSession ? { ephemeral: true } : {}),
      ...(creatingThread || opts.forkSession ? { threadSource: THREAD_SOURCE } : {}),
      ...(creatingThread ? { serviceName: SERVICE_NAME } : {}),
      ...(input.developerInstructions ? { developerInstructions: input.developerInstructions } : {}),
      ...(input.modelProviderId ? { modelProvider: input.modelProviderId } : {}),
      ...(input.threadConfig ? { config: input.threadConfig } : {}),
      cwd: opts.cwd, model: opts.model, sandbox: input.sandbox, approvalPolicy: 'never',
    };
    let thread: ObjectValue;
    try {
      thread = await request(creatingThread ? 'thread/start' : opts.forkSession ? 'thread/fork' : 'thread/resume', threadParams);
    } catch (error) {
      if (stopping || creatingThread || opts.forkSession || !(error instanceof RpcError)
        || error.code !== -32600
        || !['modelProviderMismatch', 'modelProviderNotConfigured'].includes(text(object(error.data).type))) throw error;
      // Provider identity is immutable on newer Codex threads. Fork preserves
      // history under the selected provider and leaves the source untouched.
      thread = await request('thread/fork', { ...threadParams, threadSource: THREAD_SOURCE });
      log.info('codex', 'provider-thread-forked', {
        sourceThreadId: opts.threadId,
        threadId: text(object(thread.thread).id),
        modelProvider: input.modelProviderId ?? object(error.data).currentModelProvider,
      });
      pushStatusOnce('provider-thread-forked', '已切换模型 Provider，历史已保留到新会话。');
    }
    threadId = text(object(thread.thread).id);
    if (!threadId) throw new Error('app-server did not return a thread id');
    push(translator.translate({ type: 'thread.started', thread_id: threadId }));
    if (stopping) return;
    const result = await request('turn/start', {
      threadId, input: [{ type: 'text', text: input.prompt, text_elements: [] },
        ...(opts.images ?? []).map(path => ({ type: 'localImage', path }))],
      ...(opts.reasoningEffort ? { effort: opts.reasoningEffort } : {}),
    });
    if (!ended) turnId = text(object(result.turn).id) || turnId;
  })();
  void ready.catch(error => {
    if (!stopping) log.warn('codex', 'app-server-request-failed', rpcErrorFields(error));
    finish(stopping
      ? translator.finish('interrupted')
      : translator.fail(errorMessage(error), error instanceof RpcError ? error.codexError.failureKind : undefined));
  });

  async function waitForExit(timeoutMs: number): Promise<boolean> {
    if (exited) return true;
    let timer: NodeJS.Timeout | undefined;
    const result = await Promise.race([exit.then(() => true), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); })]);
    if (timer) clearTimeout(timer);
    return result;
  }

  return {
    runId: opts.runId,
    events: { async *[Symbol.asyncIterator]() {
      while (!ended || events.length) {
        if (events.length) yield events.shift()!;
        else await new Promise<void>(resolve => { wake = resolve; });
      }
    } },
    async steer(prompt, messageId) {
      await ready;
      if (ended || stopping || !threadId || !turnId) return 'inactive';
      const expectedTurnId = turnId;
      try {
        const result = await request('turn/steer', { threadId, expectedTurnId, clientUserMessageId: messageId,
          input: [{ type: 'text', text: prompt, text_elements: [] }] });
        if (result.turnId !== expectedTurnId) throw new Error('app-server returned an unexpected steer turn id; delivery is unknown');
        return 'accepted';
      } catch (error) {
        if (error instanceof RpcError) {
          if (isActiveTurnNotSteerable(error.codexError.codexErrorInfo)
            || isActiveTurnNotSteerable(error.data)
            || /no active turn|not.*active|turn.*(?:mismatch|does not match)|not steerable|cannot steer.*active turn|active turn.*cannot accept/i.test(error.message)) {
            return 'inactive';
          }
          log.warn('codex', 'turn-steer-failed', rpcErrorFields(error));
        }
        throw error;
      }
    },
    stop() {
      if (stopPromise) return stopPromise;
      stopping = true;
      stopPromise = (async () => {
        if (!ended && threadId && turnId) {
          await request('turn/interrupt', { threadId, turnId }, Math.min(input.stopGraceMs, 2000)).catch(() => {});
          if (await waitForExit(input.stopGraceMs)) return;
        }
        if (!exited) {
          terminateChild(child, 'SIGTERM');
          if (!await waitForExit(input.stopGraceMs)) {
            terminateChild(child, 'SIGKILL');
            await waitForExit(input.stopGraceMs);
          }
        }
      })();
      return stopPromise;
    },
    waitForExit,
  };
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

function rpcErrorFields(error: unknown): ObjectValue {
  if (error instanceof RpcError) {
    return {
      message: error.message,
      method: error.method,
      rpcCode: error.code,
      rpcData: error.data,
      ...error.codexError,
    };
  }
  return { message: errorMessage(error) };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function parseAsyncQuestions(value: unknown): Array<{ title: string; options?: string[] }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap(raw => {
    const q = object(raw);
    if (!text(q.title).trim()) return [];
    const options = Array.isArray(q.options) ? q.options.filter((v): v is string => typeof v === 'string' && Boolean(v.trim())) : [];
    return [{ title: text(q.title), ...(options.length ? { options } : {}) }];
  });
}
