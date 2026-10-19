import type { AgentExecutionCapabilities } from '../types';

const APP_SERVER: AgentExecutionCapabilities = Object.freeze({ finalAnswer: 'separate-event', input: 'active-turn' });

export function codexExecutionCapabilities(): AgentExecutionCapabilities {
  return APP_SERVER;
}
