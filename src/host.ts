// Minimal headless library. No channel, web console, bot, CLI or model loop.
export { RunExecutor } from './runtime/run-executor';
export { ActiveRuns } from './runtime/active-runs';
export { ProcessPool } from './runtime/process-pool';
export { createConversationRuntime, ConversationRuntime } from './runtime/conversation';
export { ProfileExecutionController, profileForAgentKind } from './runtime/execution-controller';
export { presentRunOutput } from './runtime/run-output';
export { ClaudeAdapter } from './agent/claude/adapter';
export { CodexAdapter } from './agent/codex/adapter';
export { DshAdapter } from './agent/dsh/adapter';
export { createDshHarness, createExecutionHost, dshProfile, dshLease, dshStorageChecks,
  dshRecovery, dshEventDigest, nativeSession, publicText, usageOf } from './agent/dsh/harness';
export type { AgentRun, AgentRunOptions, AgentEvent, StopSettlement, NativeTurnBinding } from './agent/types';
export type { SubmitRunInput, RunExecution, GovernedRunExecution, RunResult } from './runtime/run-executor';
export type { ConversationRuntimeOptions, ConversationIdentity, ConversationInput, ConversationStatus } from './runtime/conversation';
export type { ExecutionController, ProfileExecutionControllerOptions } from './runtime/execution-controller';
export type { RunOutputPlugin, RunOutputContext, RunOutputOptions } from './runtime/run-output';
