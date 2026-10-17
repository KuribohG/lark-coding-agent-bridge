import type { AgentExecutionCapabilities } from '../types';

const EXEC: AgentExecutionCapabilities = Object.freeze({ finalAnswer: 'separate-event', input: 'unsupported' });
const APP_SERVER: AgentExecutionCapabilities = Object.freeze({ finalAnswer: 'separate-event', input: 'active-turn' });

export function codexExecutionCapabilities(transport: 'exec' | 'app-server' = 'exec'): AgentExecutionCapabilities {
  return transport === 'app-server' ? APP_SERVER : EXEC;
}
