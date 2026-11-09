import { terminateChild } from '../../platform/terminate';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import type { SpawnedProcessByStdio } from '../../platform/spawn';
import { hostedProcessOf, readRunHostInput, spawnAgentProcess } from '../run-host';
import type { AgentRunOptions, NativeAgentRun } from '../types';
import { getBuildInfo } from '../../build-info';
import { log } from '../../core/logger';
import { isActiveTurnNotSteerable } from './error-info';
import {
  AppServerRpc,
  RpcError,
  errorMessage,
  object,
  rpcErrorFields,
  text,
  type ObjectValue,
} from './app-server-rpc';
import { AppServerProtocol, AppServerRunState } from './app-server-protocol';

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

type AppServerRunInput = {
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
  /** Groups hosted runs that depend on one shared app-server daemon. */
  hostTag?: string;
};

interface RunContext {
  input: AppServerRunInput;
  rpc: AppServerRpc;
  state: AppServerRunState;
  isStopping(): boolean;
}

/**
 * In daemon mode each run is a short-lived proxy to Codex's persistent
 * app-server. In per-run mode the app-server is scoped to this run and must
 * not create background memory jobs that would die with the process.
 */
export function startAppServerRun(input: AppServerRunInput): NativeAgentRun {
  const { opts } = input;
  const { command, args } = appServerCommand(input);
  const child = spawnAgentProcess(command, args, {
    cwd: opts.cwd, env: input.env, stdio: ['pipe', 'pipe', 'pipe'],
  }, { agent: 'codex', deadlineAt: opts.deadlineAt, host: opts.host, tag: input.hostTag }) as SpawnedProcessByStdio<Writable, Readable, Readable>;
  const hosted = hostedProcessOf(child);
  const state = new AppServerRunState(() => child.stdin.end());
  const { translator } = state;
  let stopping = false;
  let stopPromise: Promise<void> | undefined;
  let stderr = '';
  let exited = false;
  let resolveExit!: () => void;
  const exit = new Promise<void>(resolve => { resolveExit = resolve; });
  const rpc = new AppServerRpc(line => child.stdin.write(line), () => exited || state.ended);
  const protocol = new AppServerProtocol(state, rpc, (itemId, delta) => opts.onMessageDelta?.(itemId, delta));
  const onExit = () => {
    if (exited) return;
    exited = true;
    resolveExit();
    rpc.failPending(new Error('app-server disconnected; delivery is unknown'));
    if (!state.ended) state.finish(stopping ? translator.finish('interrupted')
      : opts.deadlineAt !== undefined && child.exitCode === 124 ? translator.finish('timeout')
      : translator.fail(`app-server exited before completion${stderr ? `: ${stderr}` : ''}`));
  };
  child.once('error', (error) => { state.finish(translator.fail(`app-server spawn failed: ${error.message}`)); onExit(); });
  child.once('close', onExit);
  child.stdin.on('error', () => rpc.failPending(new Error('app-server input closed; delivery is unknown')));
  child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-2000); });
  createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', line => protocol.handleLine(line));

  const run: RunContext = { input, rpc, state, isStopping: () => stopping };
  const ready = opts.host?.attach
    ? Promise.resolve(restoreHostedRequests(opts.host.key, run, protocol))
    : startTurn(run);
  void ready.catch(error => {
    if (!stopping) log.warn('codex', 'app-server-request-failed', rpcErrorFields(error));
    state.finish(stopping
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
    ...(hosted ? { detachOnShutdown: true } : {}),
    events: { [Symbol.asyncIterator]: () => state.drain() },
    async sendInput({ text, messageId }) {
      await ready;
      const { threadId, turnId } = state;
      if (state.ended || stopping || !threadId || !turnId) return { status: 'inactive', messageId };
      const expectedTurnId = turnId;
      try {
        const result = await rpc.request('turn/steer', { threadId, expectedTurnId, clientUserMessageId: messageId,
          input: [{ type: 'text', text, text_elements: [] }] });
        if (result.turnId !== expectedTurnId) throw new Error('app-server returned an unexpected steer turn id; delivery is unknown');
        return { status: 'accepted', messageId, scope: 'active-turn' };
      } catch (error) {
        if (error instanceof RpcError) {
          if (isSteerTargetInactive(error)) return { status: 'inactive', messageId };
          log.warn('codex', 'turn-steer-failed', rpcErrorFields(error));
        }
        throw error;
      }
    },
    stop(reason) {
      if (stopPromise) return stopPromise;
      stopping = true;
      if (hosted && reason === 'shutdown') {
        // The turn keeps running under its host; the next bridge process reattaches.
        hosted.detach();
        stopPromise = waitForExit(input.stopGraceMs).then(() => {});
        return stopPromise;
      }
      stopPromise = (async () => {
        const { threadId, turnId } = state;
        if (!state.ended && threadId && turnId) {
          await rpc.request('turn/interrupt', { threadId, turnId }, Math.min(input.stopGraceMs, 2000)).catch(() => {});
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

function appServerCommand(input: AppServerRunInput): { command: string; args: string[] } {
  const { opts } = input;
  if (input.appServerMode === 'daemon') {
    // A reattached run keeps the connection its host already holds.
    if (!input.daemonSocketPath && !opts.host?.attach) throw new Error('daemon app-server socket path is required');
    return {
      command: process.execPath,
      args: [WS_PROXY, input.daemonSocketPath ?? '', ...(process.platform === 'win32' ? [input.binary] : [])],
    };
  }
  const args = ['app-server', '--listen', 'stdio://',
    '-c', 'approval_policy="never"', '-c', 'shell_environment_policy.inherit="all"'];
  for (const override of input.configOverrides ?? []) args.push('-c', override);
  // Existing memories and startup processing remain available, but this
  // short-lived process must not add its own thread as a generation input.
  args.push('-c', 'memories.generate_memories=false');
  if (opts.forkSession) args.push('-c', 'features.goals=false');
  return { command: input.binary, args };
}

async function startTurn({ input, rpc, state, isStopping }: RunContext): Promise<void> {
  const { opts } = input;
  await rpc.request('initialize', {
    clientInfo: {
      name: 'lark_channel_bridge',
      title: 'Lark Channel Bridge',
      version: getBuildInfo().version,
    },
  });
  rpc.write({ method: 'initialized' });
  if (input.initialNotice) state.pushStatusOnce('provider-restart-required', input.initialNotice);
  if (isStopping()) return;
  const thread = await openThread({ input, rpc, state, isStopping });
  state.threadId = text(object(thread.thread).id);
  const threadId = state.threadId;
  if (!threadId) throw new Error('app-server did not return a thread id');
  state.push(state.translator.translate({ type: 'thread.started', thread_id: threadId }));
  if (isStopping()) return;
  const result = await rpc.request('turn/start', {
    threadId, input: [{ type: 'text', text: input.prompt, text_elements: [] },
      ...(opts.images ?? []).map(path => ({ type: 'localImage', path }))],
    ...(opts.reasoningEffort ? { effort: opts.reasoningEffort } : {}),
  });
  if (!state.ended) state.turnId = text(object(result.turn).id) || state.turnId;
}

async function openThread({ input, rpc, state, isStopping }: RunContext): Promise<ObjectValue> {
  const { opts } = input;
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
  try {
    return await rpc.request(creatingThread ? 'thread/start' : opts.forkSession ? 'thread/fork' : 'thread/resume', threadParams);
  } catch (error) {
    if (isStopping() || creatingThread || opts.forkSession || !(error instanceof RpcError)
      || error.code !== -32600
      || !['modelProviderMismatch', 'modelProviderNotConfigured'].includes(text(object(error.data).type))) throw error;
    // Provider identity is immutable on newer Codex threads. Fork preserves
    // history under the selected provider and leaves the source untouched.
    const thread = await rpc.request('thread/fork', { ...threadParams, threadSource: THREAD_SOURCE });
    log.info('codex', 'provider-thread-forked', {
      sourceThreadId: opts.threadId,
      threadId: text(object(thread.thread).id),
      modelProvider: input.modelProviderId ?? object(error.data).currentModelProvider,
    });
    state.pushStatusOnce('provider-thread-forked', '已切换模型 Provider，历史已保留到新会话。');
    return thread;
  }
}

/**
 * A reattached host replays the run from its start. The answers to requests
 * the previous bridge process sent restore the thread and turn, so nothing
 * is sent again.
 */
function restoreHostedRequests(key: string, { rpc, state }: RunContext, protocol: AppServerProtocol): void {
  for (const line of readRunHostInput(key)) {
    let message: ObjectValue;
    try { message = object(JSON.parse(line)); } catch { continue; }
    if (message.method === undefined) {
      if (message.id !== undefined) protocol.markServerRequestAnswered(message.id);
      continue;
    }
    if (typeof message.id !== 'number') continue;
    const method = text(message.method);
    rpc.restorePending(message.id, method, (result) => {
      if (method === 'thread/start' || method === 'thread/resume' || method === 'thread/fork') {
        state.threadId = text(object(result.thread).id) || state.threadId;
        if (state.threadId) state.push(state.translator.translate({ type: 'thread.started', thread_id: state.threadId }));
      } else if (method === 'turn/start' && !state.ended) {
        state.turnId = text(object(result.turn).id) || state.turnId;
      }
    });
  }
}

function isSteerTargetInactive(error: RpcError): boolean {
  return isActiveTurnNotSteerable(error.codexError.codexErrorInfo)
    || isActiveTurnNotSteerable(error.data)
    || /no active turn|not.*active|turn.*(?:mismatch|does not match)|not steerable|cannot steer.*active turn|active turn.*cannot accept/i.test(error.message);
}
