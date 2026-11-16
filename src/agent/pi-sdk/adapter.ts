import { existsSync } from 'node:fs';
import { log } from '../../core/logger';
import { SpawnFailed } from '../errors';
import { parseEffort } from '../model-settings';
import { validateModelId } from '../models';
import { checkAgentAvailability, AgentPreflightError, type AgentAvailability } from '../preflight';
import { preparedRun, snapshotRunOptions } from '../prepared-run';
import { resolveSystemPrompt, type AgentSystemPrompt } from '../system-prompt';
import type {
  AgentAdapter,
  AgentBotIdentity,
  AgentEvent,
  AgentExecutionCapabilities,
  AgentInput,
  AgentInputReceipt,
  AgentRunOptions,
  NativeAgentRun,
  PreparedAgentRun,
  RunStopReason,
} from '../types';
import { withExecutionContract } from '../execution';
import type { PiConfig } from '../pi/config';
import { PiRunTranslator } from '../pi/jsonl-translator';
import { piThinkingLevel } from '../pi/thinking';
import { PI_SDK_EXECUTION_CAPABILITIES } from './capabilities';
import { AsyncEventQueue } from './event-queue';
import { PiHostClient, type PiHostLaunch, type PiHostRunAck, type PiHostSessionInfo } from './host-client';
import { PI_SDK_MIN_NODE, resolvePiAgentDir, resolvePiSdkPaths, type PiSdkPaths } from './paths';

export interface PiSdkAdapterOptions {
  config: PiConfig;
  systemPrompt?: AgentSystemPrompt;
  env?: NodeJS.ProcessEnv;
  stopGraceMs?: number;
  profileStateDir?: string;
}

const OPEN_TIMEOUT_MS = 60_000;
const PROMPT_ACK_TIMEOUT_MS = 30_000;
const READ_ONLY_TOOLS = ['read', 'grep', 'find', 'ls'] as const;

interface RunState {
  runId: string;
  sessionId?: string;
  promptDispatched: boolean;
  ended: boolean;
  stopped: boolean;
  timedOut: boolean;
  stopGraceMs: number;
  deadlineSignal: Promise<void>;
  resolveDeadline: () => void;
  endSignal: Promise<void>;
  resolveEnd: () => void;
  forceEnd?: () => void;
  deadlineTimer?: NodeJS.Timeout;
  stopping?: boolean;
}

export class PiSdkAdapter implements AgentAdapter {
  readonly id = 'pi';
  readonly displayName = 'Pi Coding Agent (SDK)';
  readonly capabilities: AgentExecutionCapabilities = PI_SDK_EXECUTION_CAPABILITIES;

  private readonly config: PiConfig;
  private readonly systemPrompt: AgentSystemPrompt | undefined;
  private readonly env: NodeJS.ProcessEnv;
  private readonly defaultStopGraceMs: number;
  private botIdentity: AgentBotIdentity | undefined;
  private client: PiHostClient | undefined;
  private starting: Promise<PiHostClient> | undefined;
  private paths: PiSdkPaths | undefined;

  constructor(opts: PiSdkAdapterOptions) {
    this.config = opts.config;
    this.systemPrompt = opts.systemPrompt;
    this.env = { ...opts.env };
    this.defaultStopGraceMs = opts.stopGraceMs ?? 5000;
  }

  setBotIdentity(identity: AgentBotIdentity): void {
    this.botIdentity = identity;
  }

  /** Stop the shared host; the next run starts a fresh one. */
  async shutdown(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    this.starting = undefined;
    this.paths = undefined;
    await client?.dispose();
  }

  async isAvailable(): Promise<boolean> {
    return (await this.checkAvailability()).ok;
  }

  async checkAvailability(): Promise<AgentAvailability> {
    let paths: PiSdkPaths;
    try {
      paths = this.resolvePaths();
    } catch (error) {
      const failure = new AgentPreflightError({
        code: 'agent-binary-not-found',
        agentId: 'pi',
        agentName: this.displayName,
        command: this.config.binaryPath,
        binaryPath: this.config.binaryPath,
        field: 'sdkPath',
        ...(error instanceof Error ? { stderrExcerpt: error.message.slice(0, 500) } : {}),
      });
      return { ok: false, error: failure, diagnostic: failure.diagnostic };
    }

    const node = await checkAgentAvailability({
      agentId: 'pi',
      agentName: this.displayName,
      command: paths.nodePath,
      binaryPath: paths.nodePath,
      // `node --version` prints `v22.23.3`; the shared version matcher expects
      // a plain `\d+.\d+.\d+` token, so ask Node for the bare version.
      args: ['-p', 'process.versions.node'],
      env: this.env,
      minimumVersion: PI_SDK_MIN_NODE.join('.'),
    });
    if (!node.ok) return node;

    for (const [file, field] of [
      [paths.sdkPath, 'sdkPath'],
      [paths.hostScript, 'hostScript'],
    ] as const) {
      if (existsSync(file)) continue;
      const failure = new AgentPreflightError({
        code: 'agent-binary-not-found',
        agentId: 'pi',
        agentName: this.displayName,
        command: file,
        binaryPath: file,
        field,
      });
      return { ok: false, error: failure, diagnostic: failure.diagnostic };
    }
    return { ok: true, version: node.version };
  }

  async prepareRun(input: AgentRunOptions): Promise<PreparedAgentRun> {
    const opts = snapshotRunOptions({
      ...input,
      systemPrompt: input.systemPrompt ?? resolveSystemPrompt(this.systemPrompt, this.botIdentity),
    });
    if (!opts.cwd) throw new Error('cwd is required for pi sdk preparation');
    if (opts.forkSession && !opts.sessionId) throw new Error('fork requires a parent session');
    if (opts.model) validateModelId(opts.model);
    if (opts.reasoningEffort) parseEffort(opts.reasoningEffort, 'pi');
    if (opts.sandbox === 'workspace-write') {
      throw new SpawnFailed(
        'Pi has no portable workspace sandbox; use read-only or full access',
        new Error('Pi has no portable workspace sandbox; use read-only or full access'),
        'agent-prepare-failed',
      );
    }
    if (opts.execSandbox?.enabled) {
      throw new SpawnFailed(
        'pi sdk cannot enforce the Landlock exec sandbox',
        new Error('The Pi SDK host is shared across runs and cannot apply a per-run Landlock domain; use pi.transport=cli for sandboxed profiles'),
        'agent-prepare-failed',
      );
    }
    const availability = await this.checkAvailability();
    if (!availability.ok) {
      throw new SpawnFailed(
        'pi sdk availability check failed',
        availability.error,
        availability.diagnostic.code,
        availability.diagnostic,
      );
    }
    return preparedRun(
      { model: opts.model, reasoningEffort: opts.reasoningEffort },
      () => withExecutionContract(this.startRun(opts), this.capabilities),
    );
  }

  private startRun(opts: AgentRunOptions): NativeAgentRun {
    if (!opts.cwd) throw new Error('cwd is required for PiSdkAdapter.run');
    const sandbox = opts.sandbox ?? 'danger-full-access';
    if (sandbox === 'workspace-write') {
      throw new Error('Pi has no portable workspace sandbox; use read-only or full access');
    }

    const state = createRunState(opts, this.defaultStopGraceMs);
    if (opts.deadlineAt !== undefined) {
      state.deadlineTimer = setTimeout(() => {
        state.timedOut = true;
        state.resolveDeadline();
        void this.stopRun(state, 'deadline');
      }, Math.max(0, opts.deadlineAt - Date.now()));
      state.deadlineTimer.unref?.();
    }
    return {
      runId: opts.runId,
      events: this.runEvents(opts, state, sandbox),
      sendInput: async (input: AgentInput) => this.steerRun(state, input),
      stop: (reason?: RunStopReason) => this.stopRun(state, reason),
      waitForExit: async (timeoutMs: number) => waitForSignal(state.endSignal, timeoutMs),
    };
  }

  private async steerRun(state: RunState, input: AgentInput): Promise<AgentInputReceipt> {
    if (state.ended || !state.sessionId) {
      return { status: 'inactive', messageId: input.messageId };
    }
    const client = this.client;
    if (!client || client.isClosed) {
      return { status: 'inactive', messageId: input.messageId };
    }
    try {
      await client.request('run.steer', {
        sessionId: state.sessionId,
        runId: state.runId,
        text: input.text,
      }, 10_000);
      return { status: 'accepted', messageId: input.messageId, scope: 'active-turn' };
    } catch (error) {
      // A lost acknowledgement is not proof of rejection; never auto-replay.
      return { status: 'unknown', messageId: input.messageId, message: errorMessage(error) };
    }
  }

  private async *runEvents(
    opts: AgentRunOptions,
    state: RunState,
    sandbox: string,
  ): AsyncGenerator<AgentEvent> {
    const translator = new PiRunTranslator();
    let offFrame: (() => void) | undefined;
    let queue: AsyncEventQueue<AgentEvent> | undefined;
    try {
      let client: PiHostClient;
      try {
        client = await this.ensureClient();
      } catch (error) {
        yield errorEvent(`failed to start pi sdk host: ${errorMessage(error)}`);
        return;
      }
      if (state.stopped || state.timedOut) {
        yield doneEvent(undefined, state.timedOut ? 'timeout' : 'interrupted');
        return;
      }

      let opened: PiHostSessionInfo | undefined;
      try {
        opened = await untilDeadline(
          client.request<PiHostSessionInfo>('session.open', this.openParams(opts, sandbox), OPEN_TIMEOUT_MS),
          state,
        );
      } catch (error) {
        if (state.timedOut) {
          yield doneEvent(undefined, 'timeout');
          return;
        }
        if (state.stopped) {
          yield doneEvent(undefined, 'interrupted');
          return;
        }
        yield errorEvent(`pi sdk session failed: ${errorMessage(error)}`);
        return;
      }
      if (!opened) {
        yield doneEvent(undefined, state.timedOut ? 'timeout' : 'interrupted');
        return;
      }
      state.sessionId = opened.sessionId;
      for (const event of translator.translate({
        type: 'session',
        id: opened.sessionId,
        ...(opts.cwd ? { cwd: opts.cwd } : {}),
      })) {
        yield event;
      }
      // A stop/deadline can land while the consumer is between events.
      if (state.stopped || state.timedOut) {
        yield doneEvent(state.sessionId, state.timedOut ? 'timeout' : 'interrupted');
        return;
      }

      let endOutcome: string | undefined;
      let endError: string | undefined;
      queue = new AsyncEventQueue<AgentEvent>();
      state.forceEnd = () => queue!.end();
      offFrame = client.onFrame((frame) => {
        if (
          frame.type === 'run.event' &&
          frame.sessionId === state.sessionId &&
          frame.runId === state.runId &&
          frame.event !== undefined
        ) {
          for (const event of translator.translate(frame.event)) queue!.push(event);
          if (translator.terminalEmitted()) queue!.end();
          return;
        }
        if (frame.type === 'run.end' && frame.sessionId === state.sessionId && frame.runId === state.runId) {
          endOutcome = typeof frame.outcome === 'string' ? frame.outcome : 'settled';
          endError = typeof frame.error === 'string' ? frame.error : undefined;
          queue!.end();
          return;
        }
        if (frame.type === 'host.exit') {
          queue!.push({
            type: 'error',
            message: `pi sdk host exited during the run: ${String(frame.error ?? 'unknown reason')}`,
            terminationReason: 'failed',
          });
          queue!.end();
        }
      });

      try {
        if (state.stopped || state.timedOut) {
          yield doneEvent(state.sessionId, state.timedOut ? 'timeout' : 'interrupted');
          return;
        }
        state.promptDispatched = true;
        const ack = await untilDeadline(
          client.request<PiHostRunAck>('run.prompt', this.promptParams(opts, state), PROMPT_ACK_TIMEOUT_MS),
          state,
        );
        if (!ack) throw new Error('pi sdk host did not acknowledge the prompt before the deadline');
      } catch (error) {
        if (state.timedOut) {
          void this.stopRun(state, 'deadline');
          yield doneEvent(state.sessionId, 'timeout');
          return;
        }
        if (state.stopped) {
          yield doneEvent(state.sessionId, 'interrupted');
          return;
        }
        yield errorEvent(`pi sdk prompt failed: ${errorMessage(error)}`);
        return;
      }

      let sawTerminal = false;
      for await (const event of queue) {
        const shaped = state.timedOut && (event.type === 'done' || event.type === 'error')
          ? doneEvent(state.sessionId, 'timeout')
          : event;
        if (shaped.type === 'done' || shaped.type === 'error') sawTerminal = true;
        yield shaped;
      }
      if (sawTerminal) return;
      if (state.timedOut) {
        yield doneEvent(state.sessionId, 'timeout');
        return;
      }
      if (endOutcome === 'error') {
        yield errorEvent(endError ?? 'pi sdk run failed');
        return;
      }
      if (endOutcome === 'aborted' || state.stopped) {
        yield doneEvent(state.sessionId, 'interrupted');
        return;
      }
      for (const event of translator.finish({
        exitCode: 0,
        stderr: '',
        interrupted: false,
        timedOut: false,
      })) {
        yield event;
      }
    } finally {
      offFrame?.();
      state.ended = true;
      if (state.deadlineTimer) clearTimeout(state.deadlineTimer);
      state.resolveEnd();
    }
  }

  private openParams(opts: AgentRunOptions, sandbox: string): Record<string, unknown> {
    const systemPrompt = opts.systemPrompt ?? resolveSystemPrompt(this.systemPrompt, this.botIdentity);
    const thinkingLevel = this.thinkingLevel(opts);
    const readOnly = sandbox === 'read-only';
    return {
      ...(opts.sessionId && !opts.forkSession ? { sessionId: opts.sessionId } : {}),
      ...(opts.forkSession ? { forkFrom: opts.sessionId } : {}),
      cwd: opts.cwd,
      systemPrompt,
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.modelProvider?.pi ? { modelProvider: opts.modelProvider.pi } : {}),
      ...(opts.modelProvider?.env ? { providerEnv: opts.modelProvider.env } : {}),
      ...(opts.env ? { runEnv: opts.env } : {}),
      ...(thinkingLevel ? { thinkingLevel } : {}),
      ...(readOnly ? { tools: [...READ_ONLY_TOOLS] } : {}),
      noExtensions: readOnly || opts.deadlineAt !== undefined,
      ...(this.config.sessionPersistence ? { sessionPersistence: this.config.sessionPersistence } : {}),
    };
  }

  private promptParams(opts: AgentRunOptions, state: RunState): Record<string, unknown> {
    const thinkingLevel = this.thinkingLevel(opts);
    return {
      sessionId: state.sessionId,
      runId: state.runId,
      text: opts.prompt,
      systemPrompt: opts.systemPrompt ?? resolveSystemPrompt(this.systemPrompt, this.botIdentity),
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.modelProvider?.pi ? { modelProvider: opts.modelProvider.pi } : {}),
      ...(opts.modelProvider?.env ? { providerEnv: opts.modelProvider.env } : {}),
      ...(opts.env ? { runEnv: opts.env } : {}),
      ...(thinkingLevel ? { thinkingLevel } : {}),
    };
  }

  private thinkingLevel(opts: AgentRunOptions): string | undefined {
    if (!opts.reasoningEffort) return undefined;
    const effort = parseEffort(opts.reasoningEffort, 'pi');
    return effort ? piThinkingLevel(effort) : undefined;
  }

  private async stopRun(state: RunState, reason?: RunStopReason): Promise<void> {
    if (reason === 'deadline') state.timedOut = true;
    state.stopped = !state.timedOut;
    if (state.ended || state.stopping) return;
    state.stopping = true;
    const client = this.client;
    if (!client || client.isClosed || !state.sessionId) {
      state.forceEnd?.();
      if (!state.sessionId) {
        // Startup never finished; the generator observes `stopped` once it runs.
        state.resolveDeadline();
      }
      return;
    }
    if (!state.promptDispatched) {
      // The run has not reached the host yet; the generator checks `stopped`
      // before dispatching and will not start it.
      state.forceEnd?.();
      return;
    }
    const graceMs = Math.max(500, state.stopGraceMs);
    try {
      await client.request('run.abort', { sessionId: state.sessionId, runId: state.runId }, graceMs);
    } catch (error) {
      log.warn('agent', 'pi-sdk-abort-failed', { message: errorMessage(error), runId: state.runId });
    }
    if (await waitForSignal(state.endSignal, graceMs)) return;
    try {
      await client.request('session.dispose', { sessionId: state.sessionId }, 5000);
    } catch (error) {
      log.warn('agent', 'pi-sdk-dispose-failed', { message: errorMessage(error), runId: state.runId });
    }
    state.forceEnd?.();
  }

  private async ensureClient(): Promise<PiHostClient> {
    if (this.client && !this.client.isClosed) return this.client;
    if (this.starting) return this.starting;
    const paths = this.resolvePaths();
    const launch: PiHostLaunch = {
      nodePath: paths.nodePath,
      hostScript: paths.hostScript,
      sdkPath: paths.sdkPath,
      agentDir: resolvePiAgentDir(this.config),
      env: this.env,
      ...(this.config.idleTtlMs !== undefined ? { idleTtlMs: this.config.idleTtlMs } : {}),
      ...(this.config.maxSessions !== undefined ? { maxSessions: this.config.maxSessions } : {}),
    };
    const client = new PiHostClient(launch);
    this.client = client;
    const starting = client.start()
      .then(() => client)
      .catch((error) => {
        if (this.client === client) this.client = undefined;
        throw error;
      })
      .finally(() => {
        if (this.starting === starting) this.starting = undefined;
      });
    this.starting = starting;
    return starting;
  }

  private resolvePaths(): PiSdkPaths {
    this.paths ??= resolvePiSdkPaths(this.config);
    return this.paths;
  }
}

function createRunState(opts: AgentRunOptions, defaultStopGraceMs: number): RunState {
  let resolveDeadline!: () => void;
  const deadlineSignal = new Promise<void>((resolve) => {
    resolveDeadline = resolve;
  });
  let resolveEnd!: () => void;
  const endSignal = new Promise<void>((resolve) => {
    resolveEnd = resolve;
  });
  return {
    runId: opts.runId,
    promptDispatched: false,
    ended: false,
    stopped: false,
    timedOut: false,
    stopGraceMs: opts.stopGraceMs ?? defaultStopGraceMs,
    deadlineSignal,
    resolveDeadline,
    endSignal,
    resolveEnd,
  };
}

async function untilDeadline<T>(promise: Promise<T>, state: RunState): Promise<T | undefined> {
  const result = await Promise.race([
    promise.then((value) => ({ value })),
    state.deadlineSignal.then(() => ({ deadline: true as const })),
  ]);
  return 'deadline' in result ? undefined : result.value;
}

function waitForSignal(signal: Promise<void>, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), Math.max(0, timeoutMs));
    void signal.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

function doneEvent(
  sessionId: string | undefined,
  terminationReason: 'normal' | 'interrupted' | 'timeout',
): AgentEvent {
  return {
    type: 'done',
    ...(sessionId ? { sessionId } : {}),
    terminationReason,
  };
}

function errorEvent(message: string): AgentEvent {
  return { type: 'error', message: message.slice(0, 4096), terminationReason: 'failed' };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
