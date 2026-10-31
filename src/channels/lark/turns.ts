import type { PendingQueue } from '../../bot/pending-queue';
import type { ActiveRuns } from '../../runtime/active-runs';
import { RunStopped } from '../../runtime/errors';

/** One admission/cancellation lane shared by queued messages, wakes and timed
 * tasks. It covers preparation too, before ActiveRuns has a native execution.
 */
export class LarkTurns {
  private readonly running = new Map<string, { controller: AbortController; timedRunId?: string }>();
  private closed = false;

  constructor(private readonly pending: PendingQueue, private readonly active: ActiveRuns) {}

  isIdle(scope: string): boolean {
    return !this.closed && !this.running.has(scope) && !this.pending.hasWork(scope)
      && !this.active.get(scope) && !this.active.newRunsPaused();
  }

  timedRunId(scope: string): string | undefined { return this.running.get(scope)?.timedRunId; }

  claim(scope: string, timedRunId?: string) {
    if (this.closed || this.running.has(scope)) throw new Error('Conversation turn is already active or closed');
    const entry = { controller: new AbortController(), timedRunId };
    this.running.set(scope, entry);
    this.pending.block(scope);
    const release = () => {
      if (this.running.get(scope) !== entry) return;
      this.running.delete(scope);
      this.pending.unblock(scope);
    };
    let started = false;
    return {
      release,
      run: (work: (signal: AbortSignal) => Promise<void>) => {
        if (started || this.running.get(scope) !== entry) return Promise.reject(new Error('Turn already started or released'));
        started = true;
        return Promise.resolve().then(() => work(entry.controller.signal)).finally(release);
      },
    };
  }

  cancel(scope: string, timedRunId?: string): void {
    const entry = this.running.get(scope);
    if (entry && (!timedRunId || entry.timedRunId === timedRunId)) entry.controller.abort(new RunStopped('cancelled'));
  }

  close(): void {
    this.closed = true;
    this.pending.suspend();
    for (const entry of this.running.values()) entry.controller.abort(new RunStopped('shutdown'));
  }
}
