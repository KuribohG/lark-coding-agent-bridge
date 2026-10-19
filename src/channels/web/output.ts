import { processAgentStream } from '../../runtime/run-stream';
import type { RunState } from '../../runtime/run-state';
import type { RunOutputPlugin } from '../../runtime/run-output';

export type WebRunEvent =
  | { type: 'run.started'; runId: string; scope: string; sequence: number }
  | { type: 'run.state'; runId: string; scope: string; sequence: number; state: RunState };

/** JSON snapshots for an HTTP/SSE/WebSocket host; never contains a Lark card. */
export function createWebRunOutput(publish: (event: WebRunEvent) => Promise<void>): RunOutputPlugin {
  return {
    id: 'web',
    async render(input) {
      let sequence = 0;
      let previous: string | undefined;
      const identity = { runId: input.runId, scope: input.scope };
      await publish({ ...identity, type: 'run.started', sequence: sequence++ });
      await processAgentStream(input.handle, input.events, input.scope, input.idleTimeoutMs,
        input.recordSession, async current => {
          const state = structuredClone(input.filterForPrefs(current));
          const serialized = JSON.stringify(state);
          if (serialized === previous) return;
          await publish({ ...identity, type: 'run.state', sequence: sequence++, state });
          previous = serialized;
        });
    },
  };
}
