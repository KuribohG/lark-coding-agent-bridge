import type { AgentExecutionCapabilities } from '../types';

export const PI_EXECUTION_CAPABILITIES: AgentExecutionCapabilities = Object.freeze({
  finalAnswer: 'stream',
  input: 'unsupported',
});
