import type { AgentRun, RunStopReason } from '../agent/types';

export interface ActiveSessionIdentity {
  agentId: string;
  sessionId?: string;
  threadId?: string;
}

export interface RunHandle {
  run: AgentRun;
  interrupted: boolean;
  modelSettings?: import('../agent/model-settings').ModelSettings;
  stopReason?: RunStopReason;
  sessionIdentity?: ActiveSessionIdentity;
  /** Message IDs already delivered to this native run (initial batch or steer). */
  inputMessageIds: Set<string>;
}

export function markRunStopped(handle: RunHandle, reason: RunStopReason): RunStopReason {
  handle.interrupted = true;
  return handle.stopReason ??= reason;
}

export function stopRun(handle: RunHandle, reason: RunStopReason): Promise<void> {
  return handle.run.stop(markRunStopped(handle, reason));
}

export class ActiveRuns {
  private readonly handles = new Map<string, RunHandle>();
  private readonly latestRunIds = new Map<string, string>();
  private readonly reservations = new Set<string>();
  private readonly generations = new Map<string, number>();

  generation(scope: string): number { return this.generations.get(scope) ?? 0; }
  private pauseDepth = 0;
  private pauseReason: string | undefined;

  reserve(chatId: string): (() => void) | undefined {
    if (this.handles.has(chatId) || this.reservations.has(chatId)) return undefined;
    this.reservations.add(chatId);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.reservations.delete(chatId);
    };
  }

  register(chatId: string, run: AgentRun): RunHandle {
    if (this.handles.has(chatId)) {
      throw new Error(`run already active for scope: ${chatId}`);
    }
    this.reservations.delete(chatId);
    const handle: RunHandle = { run, interrupted: false, inputMessageIds: new Set() };
    this.handles.set(chatId, handle);
    this.latestRunIds.set(chatId, run.runId);
    return handle;
  }

  /** Remains checkable after unregister, without retaining completed runs. */
  isLatest(scope: string, run: AgentRun): boolean {
    return this.latestRunIds.get(scope) === run.runId;
  }

  identifySession(chatId: string, run: AgentRun, identity: ActiveSessionIdentity): void {
    const handle = this.handles.get(chatId);
    if (handle?.run !== run) return;
    handle.sessionIdentity = { ...identity };
  }

  seedInputMessages(chatId: string, run: AgentRun, messageIds: Iterable<string>): void {
    const handle = this.handles.get(chatId);
    if (handle?.run !== run) return;
    for (const messageId of messageIds) handle.inputMessageIds.add(messageId);
  }

  recordInput(handle: RunHandle, messageId: string): void {
    handle.inputMessageIds.add(messageId);
  }

  pauseNewRuns(reason: string): () => void {
    this.pauseDepth++;
    this.pauseReason = reason;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.pauseDepth = Math.max(0, this.pauseDepth - 1);
      if (this.pauseDepth === 0) this.pauseReason = undefined;
    };
  }

  newRunsPaused(): boolean {
    return this.pauseDepth > 0;
  }

  newRunsPauseReason(): string | undefined {
    return this.pauseReason;
  }

  get(chatId: string): RunHandle | undefined {
    return this.handles.get(chatId);
  }

  unregister(chatId: string, run: AgentRun): void {
    const existing = this.handles.get(chatId);
    if (existing?.run === run) this.handles.delete(chatId);
  }

  snapshot(): RunHandle[] {
    return [...this.handles.values()];
  }

  scopes(): string[] {
    return [...this.handles.keys()];
  }

  /**
   * Interrupt the current run for this chat, if any. Returns true if an
   * interrupt was issued. Fires stop() fire-and-forget — the old run's
   * generator exits on its own as the subprocess dies.
   */
  interrupt(chatId: string, reason: RunStopReason = 'cancelled'): boolean {
    this.generations.set(chatId, this.generation(chatId) + 1);
    const h = this.handles.get(chatId);
    if (!h) return false;
    this.reservations.delete(chatId);
    this.handles.delete(chatId);
    void stopRun(h, reason).catch(() => {
      /* stop errors are non-fatal */
    });
    return true;
  }

  async stopAll(reason: RunStopReason = 'cancelled'): Promise<void> {
    for (const scope of new Set([...this.handles.keys(), ...this.reservations])) {
      this.generations.set(scope, this.generation(scope) + 1);
    }
    const all = [...this.handles.values()];
    this.handles.clear();
    this.reservations.clear();
    await Promise.allSettled(all.map((h) => stopRun(h, reason)));
  }

  async waitForAll(timeoutMs = 300_000): Promise<void> {
    const all = [...this.handles.values()];
    await Promise.allSettled(all.map((h) => h.run.waitForExit(timeoutMs)));
  }
}
