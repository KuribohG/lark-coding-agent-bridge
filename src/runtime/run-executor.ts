import { snapshotRunOptions } from '../agent/prepared-run';
import { randomUUID } from 'node:crypto';
import type { AgentAdapter, AgentEvent, AgentRun, NativeTurnBinding, PreparedAgentRun, RunStopReason, StopSettlement } from '../agent/types';
import { ActiveRuns, markRunStopped, stopRun, type RunHandle } from './active-runs';
import { ProcessPool } from './process-pool';
import type { RunPolicyAllow } from '../policy/run-policy';
import { log } from '../core/logger';
import { SpawnFailed } from '../agent/errors';
import { RunRejected, RunStopped, abortStopReason } from './errors';
import { retryingRun } from './retrying-run';
import { agentFailureKind } from '../agent/execution';
import type { ResolvedModelProvider } from '../model-provider/types';
import type { AgentKind } from '../config/profile-schema';
import type { RunHostBinding } from '../agent/run-host';

export interface RunExecutorDeps {
  /** Resolve the adapter from the originating chat/topic scope for each run. */
  resolveAgent: (scopeId: string, agentKind?: AgentKind) => AgentAdapter;
  pool: ProcessPool;
  activeRuns: ActiveRuns;
  createRunId?: () => string;
  now?: () => number;
  postDoneExitGraceMs?: number;
  resolveModelProvider?: (
    agentKind: AgentKind,
    model?: string,
  ) => Promise<ResolvedModelProvider | undefined>;
}

export interface SubmitRunInput {
  /** Host-durable logical execution identity, independent of an attempt UUID. */
  executionId?: string;
  attemptId?: string;
  retryPolicy?: 'none' | 'legacy';
  /** Opt in to host-ledger reconciliation and retained unknown resources. */
  governed?: boolean;
  quiescenceTimeoutMs?: number;
  nativeTurn?: NativeTurnBinding;
  /** Adapter captured with the run's profile and capability snapshot. */
  agent?: AgentAdapter;
  /** Authorized root used for adapter resolution; scopeId remains the execution mutex. */
  agentScopeId?: string;
  /** Explicit managed-worker backend; authorization remains rooted in agentScopeId. */
  agentKind?: AgentKind;
  requireFinalAnswer?: boolean;
  env?: Readonly<Record<string, string>>;
  priority?: 'foreground' | 'background';
  /** Revalidate a managed worker's authorization after waiting for admission. */
  validateBeforeRun?(): Promise<void>;
  deadlineAt?: number;
  signal?: AbortSignal;
  scopeId: string;
  systemPrompt?: string;
  policy: RunPolicyAllow;
  sessionId?: string;
  threadId?: string;
  forkSession?: boolean;
  model?: string;
  reasoningEffort?: import('../agent/model-settings').ReasoningEffort;
  images?: readonly string[];
  stopGraceMs?: number;
  /** The caller presents and answers agent questions for this run. */
  userQuestions?: boolean;
  /** Text written before tool calls belongs to the delivered answer. */
  answerIncludesInterimText?: boolean;
  /** Keep the native process alive across bridge restarts under this run host. */
  host?: RunHostBinding;
  nowait?: boolean;
  observability?: {
    profile: string;
    agent: string;
    source: string;
    stage: string;
  };
}

export type RunResult = 'completed' | 'stopped' | 'expired' | 'quota' | 'failed' | 'unknown';

export interface RunExecution {
  result: Promise<RunResult>;
  runId: string;
  scopeId: string;
  run: AgentRun;
  handle: RunHandle;
  subscribe(): AsyncIterable<AgentEvent>;
  stop(reason?: RunStopReason): Promise<void>;
  /** Explicit host reconciliation may release a proved-drained quarantine. */
  reconcile(): Promise<StopSettlement>;
}

const DEFAULT_POST_DONE_EXIT_GRACE_MS = 2000;
const beforeSubmission = (error: unknown): Error & { confirmedNotSubmitted: true } =>
  Object.assign(error instanceof Error ? error : new Error(String(error)), { confirmedNotSubmitted: true as const });

export class RunExecutor {
  private readonly resolveAgent: (scopeId: string, agentKind?: AgentKind) => AgentAdapter;
  private readonly pool: ProcessPool;
  private readonly activeRuns: ActiveRuns;
  private readonly createRunId: () => string;
  private readonly now: () => number;
  private readonly postDoneExitGraceMs: number;
  private readonly resolveModelProvider:
    | ((agentKind: AgentKind, model?: string) => Promise<ResolvedModelProvider | undefined>)
    | undefined;

  constructor(deps: RunExecutorDeps) {
    this.resolveAgent = deps.resolveAgent;
    this.pool = deps.pool;
    this.activeRuns = deps.activeRuns;
    this.createRunId = deps.createRunId ?? randomUUID;
    this.now = deps.now ?? Date.now;
    this.postDoneExitGraceMs = deps.postDoneExitGraceMs ?? DEFAULT_POST_DONE_EXIT_GRACE_MS;
    this.resolveModelProvider = deps.resolveModelProvider;
  }

  async submit(input: SubmitRunInput): Promise<RunExecution> {
    const governed = input.governed === true || input.retryPolicy === 'none';
    const submittedAt = this.now();
    // Admission refusals happen before anything reaches the agent.
    const slot = await this.admit(input).catch((err: unknown) => { throw beforeSubmission(err); });
    const runId = input.executionId ?? this.createRunId();
    const startedAt = this.now();
    const queueWaitMs = startedAt - submittedAt;
    const { controller } = slot;
    let handle!: RunHandle;
    const { agent, modelProvider, prepared, run } = await this.launch(input, slot, runId, () => Boolean(handle?.interrupted));
    const dimensions = {
      runId,
      profile: input.observability?.profile ?? 'unknown',
      agent: input.observability?.agent ?? agent.id,
      scope: input.scopeId,
      source: input.observability?.source ?? 'unknown',
      stage: input.observability?.stage ?? 'submit',
    };
    log.info('run', 'started', {
      ...dimensions,
      queueWaitMs,
      accessMode: input.policy.accessMode,
      sandbox: input.policy.sandbox,
      permissionMode: input.policy.permissionMode,
      modelProvider: prepared.provider?.id ?? modelProvider?.id,
      ...(prepared.provider?.requestedId ? { requestedModelProvider: prepared.provider.requestedId } : {}),
    });

    try {
      handle = this.activeRuns.register(input.scopeId, run);
      handle.modelSettings = { ...prepared.modelSettings };
    } catch (err) {
      slot.abandon();
      await run.stop('cleanup').catch(() => {});
      throw new RunRejected(
        'run-already-active',
        err instanceof Error ? err.message : 'another run is already active for this scope',
      );
    }
    const stopOnAbort = () => {
      void stopRun(handle, abortStopReason(controller.signal)).catch((err) => log.warn('run', 'bounded-stop-failed', { runId, err: String(err) }));
    };
    controller.signal.addEventListener('abort', stopOnAbort, { once: true });
    if (controller.signal.aborted) stopOnAbort();
    let terminal: 'completed' | 'quota' | 'failed' | 'unknown' = 'failed';
    let terminalObserved = false, nativeInterrupted = false;
    let settleResult!: (state: RunResult) => void;
    const result = new Promise<RunResult>((resolve) => { settleResult = resolve; });
    let cleaned = false, resultSettled = false;
    let cleaning: Promise<void> | undefined;
    const finish = (state: RunResult) => { if (!resultSettled) { resultSettled = true; settleResult(state); } };
    const quiescenceTimeoutMs = input.quiescenceTimeoutMs ?? this.postDoneExitGraceMs;
    const confirmQuiescence = async (): Promise<StopSettlement> => {
      if (run.waitForQuiescence) return run.waitForQuiescence(quiescenceTimeoutMs);
      return { state: await run.waitForExit(quiescenceTimeoutMs) ? 'quiescent' : 'unknown' };
    };
    const cleanup = async (waitForExit: boolean, reconciled = false): Promise<void> => {
      if (cleaned) return;
      if (cleaning) return cleaning;
      cleaning = (async () => {
      slot.dispose();
      controller.signal.removeEventListener('abort', stopOnAbort);
      if (!governed) {
        // Preserve upstream finally cleanup for ordinary hosts that have no
        // durable ledger/reconciliation API. Do not silently opt them in.
        cleaned = true;
        try {
          if (waitForExit && !await run.waitForExit(this.postDoneExitGraceMs)) {
            log.warn('run', 'post-done-exit-timeout', { ...dimensions, graceMs: this.postDoneExitGraceMs });
            await run.stop('cleanup');
          }
        } catch (err) {
          terminal = 'failed';
          log.warn('run', 'post-done-cleanup-failed', { ...dimensions, err: String(err) });
          await run.stop('cleanup').catch(error => log.warn('run', 'cleanup-stop-failed', { ...dimensions, err: String(error) }));
        } finally {
          this.activeRuns.unregister(input.scopeId, run);
          slot.releasePool();
          finish(handle.stopReason === 'deadline' ? 'expired' : handle.interrupted ? 'stopped' : terminal);
        }
        return;
      }
      let settlement: StopSettlement = { state: 'unknown' };
      try {
        settlement = await confirmQuiescence();
        if (waitForExit && settlement.state !== 'quiescent') {
          log.warn('run', 'post-done-exit-timeout', { ...dimensions, graceMs: this.postDoneExitGraceMs });
          await run.stop('cleanup');
          settlement = await confirmQuiescence();
        }
      } catch (err) {
        log.warn('run', 'post-done-cleanup-failed', { ...dimensions, err: String(err) });
      }
      handle.quiescence = settlement.state;
      if (settlement.state !== 'quiescent' || terminal === 'unknown' && !reconciled) {
        handle.quiescence = 'unknown';
        finish('unknown');
        // The live handle, mutex and pool lease remain owned until explicit
        // host reconciliation. Ending a stream never proves native drain.
        return;
      }
      cleaned = true;
      this.activeRuns.unregister(input.scopeId, run);
      slot.releasePool();
      finish(terminal === 'completed' || terminal === 'quota' || terminal === 'failed' && terminalObserved && !nativeInterrupted ? terminal
        : handle.stopReason === 'deadline' ? 'expired' : handle.interrupted ? 'stopped' : terminal);
      })();
      try { await cleaning; } finally { cleaning = undefined; }
    };
    const fanout = new EventFanout(observeRunEvents(run.events, {
      dimensions,
      startedAt,
      now: this.now,
      onTerminal: (event) => {
        terminalObserved = true;
        nativeInterrupted = (event.type === 'done' || event.type === 'error') && event.terminationReason !== 'normal' && event.terminationReason !== 'failed';
        terminal = event.type === 'done' && event.terminationReason === 'normal' ? 'completed' : 'failed';
        if (governed && event.type === 'error' && agentFailureKind(event) === 'delivery_unknown') terminal = 'unknown';
        if (input.deadlineAt !== undefined && event.type === 'error' && agentFailureKind(event) === 'quota') terminal = 'quota';
        // Native watchdogs report their cause even if the JS deadline timer has not run.
        if ((event.type === 'done' || event.type === 'error') && event.terminationReason === 'timeout') markRunStopped(handle, 'deadline');
      },
    }), async () => {
      await cleanup(!handle.interrupted);
    });

    return {
      result,
      runId,
      scopeId: input.scopeId,
      run,
      handle,
      subscribe: () => fanout.subscribe(),
      reconcile: async () => {
        await cleanup(false, true);
        return { state: handle.quiescence ?? 'unknown' };
      },
      stop: async (reason = 'cancelled') => {
        if (cleaned) { await result; return; }
        try {
          await stopRun(handle, reason);
        } finally {
          await cleanup(false);
        }
      },
    };
  }

  /** Reserves the scope and a pool slot, honouring the deadline, caller signal and reconnect pause. */
  private async admit(input: SubmitRunInput): Promise<AdmittedRun> {
    const generation = this.activeRuns.generation(input.scopeId);
    const checkDeadline = () => {
      if (this.activeRuns.generation(input.scopeId) !== generation) throw new RunStopped('cancelled');
      if (input.deadlineAt !== undefined && (!Number.isSafeInteger(input.deadlineAt) || input.deadlineAt <= this.now())) {
        throw new RunRejected('deadline-expired', '任务停止时间已过。');
      }
      if (input.signal?.aborted) throw new RunStopped(abortStopReason(input.signal));
    };
    checkDeadline();
    if (input.policy.expiresAt <= this.now()) {
      throw new RunRejected('policy-expired', 'run policy expired before spawn');
    }
    this.assertNewRunsAllowed();
    const releaseScope = this.activeRuns.reserve(input.scopeId);
    if (!releaseScope) {
      throw new RunRejected('run-already-active', 'another run is already active for this scope');
    }

    const controller = new AbortController();
    const forwardAbort = () => controller.abort(new RunStopped(abortStopReason(input.signal!)));
    input.signal?.addEventListener('abort', forwardAbort, { once: true });
    if (input.signal?.aborted) forwardAbort();
    const deadlineTimer = input.deadlineAt === undefined ? undefined : setTimeout(() => {
      controller.abort(new RunStopped('deadline'));
    }, Math.max(0, input.deadlineAt - this.now()));
    const dispose = () => {
      if (deadlineTimer) clearTimeout(deadlineTimer);
      input.signal?.removeEventListener('abort', forwardAbort);
    };
    let release: (() => void) | undefined;
    try {
      release = input.nowait ? this.pool.tryAcquire(input.priority) : await this.pool.acquire(controller.signal, input.priority);
      checkDeadline();
      controller.signal.throwIfAborted();
      if (release) await input.validateBeforeRun?.();
      checkDeadline();
      controller.signal.throwIfAborted();
    } catch (err) {
      release?.();
      releaseScope();
      dispose();
      throw err;
    }
    if (!release) {
      releaseScope();
      dispose();
      throw new RunRejected('pool-full', 'process pool is full');
    }
    const releasePool = release;
    const slot: AdmittedRun = {
      controller,
      checkDeadline,
      dispose,
      releasePool,
      abandon: () => {
        releasePool();
        releaseScope();
        dispose();
      },
    };
    this.abandonIfPaused(slot);
    return slot;
  }

  /** Resolves, prepares and starts the agent; any failure gives the admitted slot back. */
  private async launch(input: SubmitRunInput, slot: AdmittedRun, runId: string, interrupted: () => boolean) {
    let agent: AgentAdapter;
    try {
      const scope = input.agentScopeId ?? input.scopeId;
      agent = input.agent ?? (input.agentKind ? this.resolveAgent(scope, input.agentKind) : this.resolveAgent(scope));
      if (input.agentKind && agent.id !== input.agentKind) throw new Error('Resolved worker backend does not match its binding');
      if (input.requireFinalAnswer && agent.capabilities.finalAnswer !== 'separate-event') {
        throw new Error('Worker backend does not provide authoritative final answers');
      }
    } catch (err) {
      slot.abandon();
      throw beforeSubmission(new SpawnFailed('agent resolve failed', err, 'agent-prepare-failed'));
    }
    let modelProvider: ResolvedModelProvider | undefined;
    try {
      modelProvider = await this.resolveModelProvider?.(agent.id as AgentKind, input.model);
    } catch (err) {
      slot.abandon();
      throw beforeSubmission(new SpawnFailed('model provider resolve failed', err, 'agent-prepare-failed'));
    }
    const runOptions = snapshotRunOptions({
      nativeTurn: input.nativeTurn,
      env: input.env,
      deadlineAt: input.deadlineAt,
      runId,
      prompt: input.policy.prompt,
      systemPrompt: input.systemPrompt,
      cwd: input.policy.cwdRealpath,
      sessionId: input.sessionId,
      threadId: input.threadId,
      forkSession: input.forkSession,
      model: modelProvider?.model ?? input.model,
      modelProvider,
      reasoningEffort: input.reasoningEffort,
      images: input.images,
      sandbox: input.policy.sandbox,
      permissionMode: input.policy.permissionMode,
      stopGraceMs: input.stopGraceMs,
      userQuestions: input.userQuestions,
      answerIncludesInterimText: input.answerIncludesInterimText,
      host: input.host,
    });
    let prepared: PreparedAgentRun;
    try {
      prepared = await agent.prepareRun(runOptions);
      await input.validateBeforeRun?.();
      slot.checkDeadline();
      slot.controller.signal.throwIfAborted();
    } catch (err) {
      slot.abandon();
      if (err instanceof RunRejected) throw beforeSubmission(err);
      if (err instanceof SpawnFailed) throw beforeSubmission(err);
      throw beforeSubmission(new SpawnFailed('agent prepare failed', err, 'agent-prepare-failed'));
    }
    try { this.abandonIfPaused(slot); } catch (err) { throw beforeSubmission(err); }
    let run: AgentRun;
    try {
      const initialRun = prepared.start();
      run = input.retryPolicy === 'none' ? initialRun : retryingRun({
        agent,
        initialRun,
        options: runOptions,
        exitGraceMs: this.postDoneExitGraceMs,
        canRetry: () => !slot.controller.signal.aborted && !interrupted()
          && !this.activeRuns.newRunsPaused()
          && (input.deadlineAt === undefined || input.deadlineAt > this.now()),
      });
    } catch (err) {
      slot.abandon();
      throw new SpawnFailed('agent spawn failed', err);
    }
    return { agent, modelProvider, prepared, run };
  }

  private assertNewRunsAllowed(): void {
    if (this.activeRuns.newRunsPaused()) {
      throw new RunRejected(
        'reconnect-in-progress',
        this.activeRuns.newRunsPauseReason() ?? 'new runs are temporarily paused',
      );
    }
  }

  /** A reconnect can pause new runs while this one waits for the pool or prepares. */
  private abandonIfPaused(slot: AdmittedRun): void {
    try {
      this.assertNewRunsAllowed();
    } catch (err) {
      slot.abandon();
      throw err;
    }
  }
}

/** A run that passed admission: it holds its scope reservation and a pool slot. */
interface AdmittedRun {
  controller: AbortController;
  checkDeadline(): void;
  /** Stops the deadline timer and caller-signal forwarding. */
  dispose(): void;
  releasePool(): void;
  /** Gives everything back when the run never starts. */
  abandon(): void;
}

function observeRunEvents(
  events: AsyncIterable<AgentEvent>,
  opts: {
    dimensions: Record<string, unknown>;
    startedAt: number;
    now: () => number;
    onTerminal(event: AgentEvent): void;
  },
): AsyncIterable<AgentEvent> {
  return {
    async *[Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
      for await (const event of events) {
        if (event.type === 'done') {
          opts.onTerminal(event);
          log.info('run', 'completed', {
            ...opts.dimensions,
            result: event.terminationReason,
            durationMs: opts.now() - opts.startedAt,
          });
          yield event;
          return;
        }
        if (event.type === 'error') {
          opts.onTerminal(event);
          log.warn('run', 'failed', {
            ...opts.dimensions,
            result: event.terminationReason,
            durationMs: opts.now() - opts.startedAt,
            error: event.message,
          });
          yield event;
          return;
        }
        yield event;
      }
    },
  };
}

class EventFanout {
  private readonly source: AsyncIterable<AgentEvent>;
  private readonly onDone: () => Promise<void>;
  private readonly buffer: AgentEvent[] = [];
  private readonly waiters = new Set<() => void>();
  private started = false;
  private done = false;
  private error: unknown;

  constructor(source: AsyncIterable<AgentEvent>, onDone: () => Promise<void>) {
    this.source = source;
    this.onDone = onDone;
    this.start();
  }

  subscribe(): AsyncIterable<AgentEvent> {
    return {
      [Symbol.asyncIterator]: () => {
        let index = 0;
        return {
          next: async (): Promise<IteratorResult<AgentEvent>> => {
            this.start();
            if (index < this.buffer.length) {
              return { done: false, value: this.buffer[index++]! };
            }
            if (this.error) throw this.error;
            if (this.done) return { done: true, value: undefined };
            await new Promise<void>((resolve) => {
              const wake = (): void => {
                this.waiters.delete(wake);
                resolve();
              };
              this.waiters.add(wake);
            });
            if (index < this.buffer.length) {
              return { done: false, value: this.buffer[index++]! };
            }
            if (this.error) throw this.error;
            return { done: true, value: undefined };
          },
        };
      },
    };
  }

  private start(): void {
    if (this.started) return;
    this.started = true;
    void this.pump();
  }

  private async pump(): Promise<void> {
    try {
      for await (const event of this.source) {
        this.buffer.push(event);
        this.wakeAll();
        if (isTerminalEvent(event)) break;
      }
    } catch (err) {
      this.error = err;
    } finally {
      await this.onDone();
      this.done = true;
      this.wakeAll();
    }
  }

  private wakeAll(): void {
    for (const wake of [...this.waiters]) wake();
  }
}

function isTerminalEvent(event: AgentEvent): boolean {
  return event.type === 'done' || event.type === 'error';
}
