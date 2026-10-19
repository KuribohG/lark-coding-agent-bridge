import { executionCapabilities } from '../agent/execution';
import type { AgentEvent } from '../agent/types';
import type { RunHandle } from './active-runs';
import type { RunState } from './run-state';
import type { RunExecution } from './run-executor';

export interface RunOutputOptions {
  idleTimeoutMs?: number;
  recordSession(event: AgentEvent): void;
  filterForPrefs(state: RunState): RunState;
}

export interface RunOutputContext extends RunOutputOptions {
  runId: string;
  scope: string;
  handle: RunHandle;
  events: AsyncIterable<AgentEvent>;
  subscribe(): AsyncIterable<AgentEvent>;
  separateFinalAnswer: boolean;
}

/** A host-injected output adapter. Transport credentials and UI rendering stay here. */
export interface RunOutputPlugin {
  readonly id: string;
  render(context: RunOutputContext): Promise<void>;
}

export async function presentRunOutput(
  execution: RunExecution,
  output: RunOutputPlugin,
  options: RunOutputOptions,
): Promise<void> {
  try {
    await output.render({
      ...options, runId: execution.runId, scope: execution.scopeId, handle: execution.handle,
      events: execution.subscribe(), subscribe: () => execution.subscribe(),
      separateFinalAnswer: executionCapabilities(execution.run).finalAnswer === 'separate-event',
    });
  } catch (error) {
    // A broken output must not leave an unobserved agent executing indefinitely.
    await execution.stop().catch(() => {});
    throw error;
  }
}
