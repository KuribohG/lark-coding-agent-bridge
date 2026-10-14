import type { AgentRun } from '../agent/types';
import type { ActiveRuns } from './active-runs';

export type FollowupResult = 'accepted' | 'queued' | 'cancelled' | 'unknown';

/** Serialize input preparation and delivery without blocking /stop. */
export class FollowupRouter {
  private readonly tails = new WeakMap<AgentRun, Promise<unknown>>();

  deliver(input: {
    scope: string;
    messageId: string;
    activeRuns: ActiveRuns;
    prepare(): Promise<string>;
  }): Promise<FollowupResult> {
    const { scope, activeRuns } = input;
    const handle = activeRuns.get(scope);
    if (!handle?.run.steer || handle.interrupted) return Promise.resolve('queued');
    const generation = activeRuns.generation(scope);
    const cancelled = () => generation !== activeRuns.generation(scope) || handle.interrupted;
    const result = (this.tails.get(handle.run) ?? Promise.resolve()).then(async (): Promise<FollowupResult> => {
      if (cancelled()) return 'cancelled';
      let prompt: string;
      try { prompt = await input.prepare(); } catch { return cancelled() ? 'cancelled' : 'queued'; }
      if (cancelled()) return 'cancelled';
      if (activeRuns.get(scope) !== handle) return 'queued';
      try {
        const result = await handle.run.steer!(prompt, input.messageId);
        if (cancelled()) return 'cancelled';
        return result === 'accepted' ? 'accepted' : 'queued';
      } catch {
        // An acknowledgement may have been lost after acceptance. Never replay automatically.
        return cancelled() ? 'cancelled' : 'unknown';
      }
    });
    this.tails.set(handle.run, result);
    return result;
  }
}
