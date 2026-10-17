import type { AgentExecutionCapabilities } from '../types';

export const CLAUDE_EXECUTION_CAPABILITIES: AgentExecutionCapabilities = Object.freeze({
  finalAnswer: 'separate-event', input: 'active-session',
});
