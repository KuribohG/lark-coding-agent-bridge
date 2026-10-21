import { terminateChild } from '../../platform/terminate';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import type { SpawnedProcessByStdio } from '../../platform/spawn';
import { spawnWithDeadline } from '../deadline';
import type { AgentEvent, AgentRun, AgentRunOptions } from '../types';
import { CodexJsonlTranslator } from './jsonl';

type ObjectValue = Record<string, unknown>;
const object = (v: unknown): ObjectValue => v !== null && typeof v === 'object' ? v as ObjectValue : {};
const text = (v: unknown): string => typeof v === 'string' ? v : '';

class RpcError extends Error {}

/** One stdio server per run keeps profile environments and process lifetimes isolated. */
export function startAppServerRun(input: {
  binary: string;
  opts: AgentRunOptions;
  env: NodeJS.ProcessEnv;
  sandbox: string;
  prompt: string;
  stopGraceMs: number;
  configOverrides?: readonly string[];
}): AgentRun {
  const { opts } = input;
  const args = ['app-server', '--listen', 'stdio://',
    '-c', 'approval_policy="never"', '-c', 'shell_environment_policy.inherit="all"'];
  for (const override of input.configOverrides ?? []) args.push('-c', override);
  if (opts.forkSession) args.push('-c', 'features.goals=false');
  const child = spawnWithDeadline(input.binary, args, {
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
  }>();
  const push = (batch: AgentEvent[]) => {
    events.push(...batch);
    wake?.();
    wake = undefined;
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
      pending.set(id, { resolve, reject, timer });
      write({ id, method, params });
    });
  };
  const onExit = () => {
    if (exited) return;
    exited = true;
    resolveExit();
    failPending(new Error('app-server disconnected; delivery is unknown'));
    if (!ended) finish(stopping ? translator.finish('interrupted') : translator.fail(`app-server exited before completion${stderr ? `: ${stderr}` : ''}`));
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
      if (message.error) p.reject(new RpcError(text(object(message.error).message) || 'app-server rejected request'));
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
    if (ended || p.threadId !== threadId) return;
    if (method === 'turn/started') {
      turnId = text(object(p.turn).id) || turnId;
      return;
    }
    if (p.turnId && turnId && p.turnId !== turnId) return;
    if (method === 'item/agentMessage/delta') {
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
      } else if (['mcpToolCall', 'dynamicToolCall', 'fileChange'].includes(text(item.type))) {
        const id = text(item.id);
        push(completed ? [{ type: 'tool_result', id, output: JSON.stringify(item.result ?? item.contentItems ?? item.changes ?? item.error ?? ''), isError: item.status === 'failed' || item.success === false }]
          : [{ type: 'tool_use', id, name: text(item.tool) || text(item.type), input: item.arguments ?? item.changes }]);
      }
    } else if (method === 'thread/tokenUsage/updated') {
      const usage = object(object(p.tokenUsage).last);
      push([{ type: 'usage', inputTokens: Number(usage.inputTokens) || 0, outputTokens: Number(usage.outputTokens) || 0,
        cachedInputTokens: Number(usage.cachedInputTokens) || 0, reasoningOutputTokens: Number(usage.reasoningOutputTokens) || 0 }]);
    } else if (method === 'turn/completed') {
      const turn = object(p.turn);
      if (turnId && turn.id !== turnId) return;
      turnId = undefined;
      finish(turn.status === 'completed' ? translator.translate({ type: 'turn.completed' })
        : turn.status === 'interrupted' ? translator.finish('interrupted')
        : translator.fail(text(object(turn.error).message) || 'Codex turn failed'));
    }
  });

  const ready = (async () => {
    await request('initialize', { clientInfo: { name: 'lark_channel_bridge', version: '0.7.1' } });
    write({ method: 'initialized' });
    if (stopping) return;
    const thread = await request(opts.threadId ? opts.forkSession ? 'thread/fork' : 'thread/resume' : 'thread/start', {
      ...(opts.threadId ? { threadId: opts.threadId, excludeTurns: true } : {}),
      ...(opts.forkSession ? { ephemeral: true } : {}),
      cwd: opts.cwd, model: opts.model, sandbox: input.sandbox, approvalPolicy: 'never',
    });
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
  void ready.catch(error => finish(stopping ? translator.finish('interrupted') : translator.fail(String(error))));

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
        if (error instanceof RpcError && /no active turn|not.*active|turn.*(?:mismatch|does not match)/i.test(error.message)) return 'inactive';
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

function parseAsyncQuestions(value: unknown): Array<{ title: string; options?: string[] }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap(raw => {
    const q = object(raw);
    if (!text(q.title).trim()) return [];
    const options = Array.isArray(q.options) ? q.options.filter((v): v is string => typeof v === 'string' && Boolean(v.trim())) : [];
    return [{ title: text(q.title), ...(options.length ? { options } : {}) }];
  });
}
