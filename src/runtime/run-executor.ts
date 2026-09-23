import { randomUUID } from 'node:crypto';
import type { AgentAdapter, AgentEvent, AgentRun } from '../agent/types';
import { ActiveRuns, type RunHandle } from '../bot/active-runs';
import { ProcessPool } from '../bot/process-pool';
import type { RunPolicyAllow } from '../policy/run-policy';
import { log } from '../core/logger';
import { RunRejected, SpawnFailed } from './errors';

export interface RunExecutorDeps {
  agent: AgentAdapter;
  pool: ProcessPool;
  activeRuns: ActiveRuns;
  createRunId?: () => string;
  now?: () => number;
  postDoneExitGraceMs?: number;
}

export interface SubmitRunInput {
  deadlineAt?: number;
  signal?: AbortSignal;
  scopeId: string;
  policy: RunPolicyAllow;
  sessionId?: string;
  threadId?: string;
  forkSession?: boolean;
  model?: string;
  reasoningEffort?: import('../agent/model-settings').ReasoningEffort;
  images?: readonly string[];
  stopGraceMs?: number;
  nowait?: boolean;
  observability?: {
    profile: string;
    agent: string;
    source: string;
    stage: string;
  };
}

export type RunResult = 'completed' | 'stopped' | 'expired' | 'quota' | 'failed';

export interface RunExecution {
  result: Promise<RunResult>;
  runId: string;
  scopeId: string;
  run: AgentRun;
  handle: RunHandle;
  subscribe(): AsyncIterable<AgentEvent>;
  stop(): Promise<void>;
}

const DEFAULT_POST_DONE_EXIT_GRACE_MS = 2000;

export class RunExecutor {
  private readonly agent: AgentAdapter;
  private readonly pool: ProcessPool;
  private readonly activeRuns: ActiveRuns;
  private readonly createRunId: () => string;
  private readonly now: () => number;
  private readonly postDoneExitGraceMs: number;

  constructor(deps: RunExecutorDeps) {
    this.agent = deps.agent;
    this.pool = deps.pool;
    this.activeRuns = deps.activeRuns;
    this.createRunId = deps.createRunId ?? randomUUID;
    this.now = deps.now ?? Date.now;
    this.postDoneExitGraceMs = deps.postDoneExitGraceMs ?? DEFAULT_POST_DONE_EXIT_GRACE_MS;
  }

  async submit(input: SubmitRunInput): Promise<RunExecution> {
    const submittedAt = this.now();
    const checkDeadline = () => {
      if (input.deadlineAt !== undefined && (!Number.isSafeInteger(input.deadlineAt) || input.deadlineAt <= this.now())) {
        throw new RunRejected('deadline-expired', '任务停止时间已过。');
      }
      if (input.signal?.aborted) throw new RunRejected('run-cancelled', '任务已取消。');
    };
    checkDeadline();
    if (input.policy.expiresAt <= this.now()) {
      throw new RunRejected('policy-expired', 'run policy expired before spawn');
    }
    if (this.activeRuns.newRunsPaused()) {
      throw new RunRejected(
        'reconnect-in-progress',
        this.activeRuns.newRunsPauseReason() ?? 'new runs are temporarily paused',
      );
    }
    const releaseScope = this.activeRuns.reserve(input.scopeId);
    if (!releaseScope) {
      throw new RunRejected('run-already-active', 'another run is already active for this scope');
    }

    const controller = new AbortController();
    const forwardAbort = () => controller.abort(new RunRejected('run-cancelled', '任务已取消。'));
    input.signal?.addEventListener('abort', forwardAbort, { once: true });
    if (input.signal?.aborted) forwardAbort();
    const deadlineTimer = input.deadlineAt === undefined ? undefined : setTimeout(() => {
      controller.abort(new RunRejected('deadline-expired', '已到任务停止时间。'));
    }, Math.max(0, input.deadlineAt - this.now()));
    const dispose = () => {
      if (deadlineTimer) clearTimeout(deadlineTimer);
      input.signal?.removeEventListener('abort', forwardAbort);
    };
    let release: (() => void) | undefined;
    try {
      release = input.nowait ? this.pool.tryAcquire() : await this.pool.acquire(controller.signal);
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
    if (this.activeRuns.newRunsPaused()) {
      release();
      releaseScope();
      dispose();
      throw new RunRejected(
        'reconnect-in-progress',
        this.activeRuns.newRunsPauseReason() ?? 'new runs are temporarily paused',
      );
    }

    const runId = this.createRunId();
    const startedAt = this.now();
    const queueWaitMs = startedAt - submittedAt;
    const runOptions = {
      deadlineAt: input.deadlineAt,
      runId,
      prompt: input.policy.prompt,
      cwd: input.policy.cwdRealpath,
      sessionId: input.sessionId,
      threadId: input.threadId,
      forkSession: input.forkSession,
      model: input.model,
      reasoningEffort: input.reasoningEffort,
      images: input.images,
      sandbox: input.policy.sandbox,
      permissionMode: input.policy.permissionMode,
      stopGraceMs: input.stopGraceMs,
    };
    let run: AgentRun;
    try {
      await this.agent.prepareRun?.(runOptions);
      checkDeadline();
      controller.signal.throwIfAborted();
    } catch (err) {
      release();
      releaseScope();
      dispose();
      if (err instanceof RunRejected) throw err;
      if (err instanceof SpawnFailed) throw err;
      throw new SpawnFailed('agent prepare failed', err, 'agent-prepare-failed');
    }
    if (this.activeRuns.newRunsPaused()) {
      release();
      releaseScope();
      dispose();
      throw new RunRejected(
        'reconnect-in-progress',
        this.activeRuns.newRunsPauseReason() ?? 'new runs are temporarily paused',
      );
    }
    try {
      run = this.agent.run(runOptions);
    } catch (err) {
      release();
      releaseScope();
      dispose();
      throw new SpawnFailed('agent spawn failed', err);
    }
    const dimensions = {
      runId,
      profile: input.observability?.profile ?? 'unknown',
      agent: input.observability?.agent ?? this.agent.id,
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
    });

    let handle: RunHandle;
    try {
      handle = this.activeRuns.register(input.scopeId, run);
      handle.modelSettings = { model: input.model, reasoningEffort: input.reasoningEffort };
    } catch (err) {
      releaseScope();
      release();
      dispose();
      await run.stop().catch(() => {});
      throw new RunRejected(
        'run-already-active',
        err instanceof Error ? err.message : 'another run is already active for this scope',
      );
    }
    const stopOnAbort = () => {
      handle.interrupted = true;
      handle.stopReason = input.deadlineAt !== undefined && input.deadlineAt <= this.now() ? 'deadline' : 'cancelled';
      void run.stop().catch((err) => log.warn('run', 'bounded-stop-failed', { runId, err: String(err) }));
    };
    controller.signal.addEventListener('abort', stopOnAbort, { once: true });
    if (controller.signal.aborted) stopOnAbort();
    let terminal: 'completed' | 'quota' | 'failed' = 'failed';
    let settleResult!: (state: RunResult) => void;
    const result = new Promise<RunResult>((resolve) => { settleResult = resolve; });
    let cleaned = false;
    const cleanup = async (waitForExit: boolean): Promise<void> => {
      if (cleaned) return;
      cleaned = true;
      dispose();
      controller.signal.removeEventListener('abort', stopOnAbort);
      try {
        if (waitForExit && !await run.waitForExit(this.postDoneExitGraceMs)) {
          log.warn('run', 'post-done-exit-timeout', { ...dimensions, graceMs: this.postDoneExitGraceMs });
          await run.stop();
        }
      } catch (err) {
        terminal = 'failed';
        log.warn('run', 'post-done-cleanup-failed', { ...dimensions, err: String(err) });
        await run.stop().catch(() => {});
      } finally {
        this.activeRuns.unregister(input.scopeId, run);
        release();
        settleResult(handle.stopReason === 'deadline' ? 'expired' : handle.interrupted ? 'stopped' : terminal);
      }
    };
    const fanout = new EventFanout(observeRunEvents(run.events, {
      dimensions,
      startedAt,
      now: this.now,
      onTerminal: (event) => {
        terminal = event.type === 'done' && event.terminationReason === 'normal' ? 'completed' : 'failed';
        if (input.deadlineAt !== undefined && event.type === 'error' && /\[bridge-quota\]|insufficient_quota|quota_exceeded|budget_exceeded|budget has been exceeded|credit balance (?:is )?too low|daily (?:quota|budget) (?:is )?(?:exhausted|exceeded)/i.test(event.message)) terminal = 'quota';
        // The independent watchdog can fire before this event loop's timer.
        if (input.deadlineAt !== undefined && input.deadlineAt <= this.now() && terminal !== 'completed') {
          handle.interrupted = true;
          handle.stopReason = 'deadline';
        }
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
      stop: async () => {
        if (cleaned) { await result; return; }
        handle.interrupted = true;
        try {
          await run.stop();
          await run.waitForExit(this.postDoneExitGraceMs);
        } finally {
          await cleanup(false);
        }
      },
    };
  }
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
