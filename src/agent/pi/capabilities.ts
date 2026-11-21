import type { AgentExecutionCapabilities } from '../types';

/**
 * RPC mode keeps one process per run and accepts steering messages while the
 * turn runs; both the CLI and SDK transports now deliver input mid-turn.
 */
export const PI_EXECUTION_CAPABILITIES: AgentExecutionCapabilities = Object.freeze({
  finalAnswer: 'separate-event',
  input: 'active-turn',
});
