import type { AgentExecutionCapabilities } from '../types';

export const DSH_EXECUTION_CAPABILITIES: AgentExecutionCapabilities = Object.freeze({
  finalAnswer: 'separate-event',
  input: 'unsupported',
  lifecycle: 'session',
});
