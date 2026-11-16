import type { AgentExecutionCapabilities } from '../types';

/**
 * The SDK transport streams deltas and a separate final answer event through
 * the shared PiRunTranslator, and supports steering at assistant-turn
 * boundaries. The CLI transport cannot steer (see ../pi/capabilities.ts).
 */
export const PI_SDK_EXECUTION_CAPABILITIES: AgentExecutionCapabilities = Object.freeze({
  finalAnswer: 'separate-event',
  input: 'active-turn',
});
