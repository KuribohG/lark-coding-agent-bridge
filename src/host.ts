// Minimal headless library. No channel, web console, bot, CLI or model loop.
import { configureLogger } from './core/logger';

// Hosts may speak a protocol on stdout, so log lines only go to a configured file.
configureLogger({ stdout: false });

export { configureLogger };
export { RunExecutor } from './runtime/run-executor';
export { ActiveRuns } from './runtime/active-runs';
export { ProcessPool } from './runtime/process-pool';
export { createConversationRuntime, ConversationRuntime } from './runtime/conversation';
export { ProfileExecutionController, profileForAgentKind } from './runtime/execution-controller';
export { presentRunOutput } from './runtime/run-output';
export { checkRuntimeAgentAvailability } from './runtime/agent-runtime';
export { ScopeExecutionStore } from './session/scope-execution';
export { agentBackendSpec } from './agent/backend-spec';
export { supportedModels } from './agent/models';
export { availableEfforts } from './agent/model-settings';
export { ClaudeAdapter } from './agent/claude/adapter';
export { CodexAdapter } from './agent/codex/adapter';
export { DshAdapter } from './agent/dsh/adapter';
export { createDshHarness, createExecutionHost, dshProfile, dshLease, dshStorageChecks,
  dshRecovery, dshEventDigest, nativeSession, publicText, usageOf } from './agent/dsh/harness';
export type { AgentRun, AgentRunOptions, AgentEvent, StopSettlement, NativeTurnBinding,
  AgentQuestion, AgentQuestionAnswer } from './agent/types';
export type { SubmitRunInput, RunExecution, GovernedRunExecution, RunResult } from './runtime/run-executor';
export type { ConversationRuntimeOptions, ConversationIdentity, ConversationInput, ConversationStatus,
  ConversationSessionCandidate, ConversationSessionList } from './runtime/conversation';
export type { ExecutionController, ProfileExecutionControllerOptions } from './runtime/execution-controller';
export type { RunOutputPlugin, RunOutputContext, RunOutputOptions } from './runtime/run-output';
