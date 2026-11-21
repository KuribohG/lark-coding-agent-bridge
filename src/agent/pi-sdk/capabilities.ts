import type { AgentExecutionCapabilities } from '../types';

/**
 * The SDK transport streams deltas and a separate final answer event through
 * the shared PiRunTranslator, and supports steering at assistant-turn
 * boundaries. Both Pi transports share these capabilities; only how the
 * process is hosted differs.
 */
export const PI_SDK_EXECUTION_CAPABILITIES: AgentExecutionCapabilities = Object.freeze({
  finalAnswer: 'separate-event',
  input: 'active-turn',
});
