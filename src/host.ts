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
export { agentBackendSpec, isRegisteredAgentKind } from './agent/backend-spec';
export { resolveAgentState } from './agent/state-layout';
export type { AgentStateLayout, AgentStateContext, AgentStateSettings } from './agent/state-layout';
export { probeAgentAuth } from './agent/auth-probe';
export type { AgentAuthProbeState, ProbeAgentAuthOptions, AgentAuthProbeResult } from './agent/auth-probe';
export { supportedModels, validateModelId, append1mSuffix, strip1mSuffix, has1mSuffix } from './agent/models';
export { availableEfforts, extendedEfforts, highestEffort } from './agent/model-settings';
export { readCodexModels } from './agent/codex/models';
export { spawnWithDeadline } from './agent/deadline';
export { ClaudeAdapter } from './agent/claude/adapter';
export type { ClaudeAdapterOptions, ClaudeAuthMode } from './agent/claude/adapter';
export { CodexAdapter } from './agent/codex/adapter';
export type { CodexAdapterOptions, CodexAuthMode } from './agent/codex/adapter';
export { AgyAdapter } from './agent/agy/adapter';
export type { AgyAdapterOptions, AgyAuthMode } from './agent/agy/adapter';
export { ModelProviderRegistry, NATIVE_MODEL_PROVIDER } from './model-provider/provider';
export type { ModelProviderOption, ModelProviderSelection, ResolvedModelProvider } from './model-provider/provider';
export { normalizeModelService } from './model-service/config';
export type { ModelServiceConfig, ModelProtocol, ModelSecretRef, ModelEndpoint, NormalizeModelServiceOptions } from './model-service/config';
export { createBridgeWorkflowRuntime } from './workflows/bridge/runtime';
export type { BridgeWorkflowRuntimeDeps } from './workflows/bridge/runtime';
export { resolveWorkerExecution, createBridgeWorkerPolicy, bridgeAgentKind } from './workflows/bridge/execution';
export type { BridgeWorkerPolicyOptions } from './workflows/bridge/execution';
export { CellChild, CellConnection } from './agent/cell/client';
export type { CellTarget } from './agent/cell/client';
export { PiSdkAdapter } from './agent/pi-sdk/adapter';
export { resolvePiSdkPaths } from './agent/pi-sdk/paths';
export { DshAdapter } from './agent/dsh/adapter';
export { createDshHarness, createExecutionHost, dshProfile, dshLease, dshStorageChecks,
  dshRecovery, dshEventDigest, nativeSession, publicText, usageOf } from './host/dsh-harness';
export type { AgentAuthMode } from './agent/launch-options';
export type { AgentKind } from './config/profile-schema';
export type { AgentAvailability } from './agent/preflight';
export type { AgentRun, AgentRunOptions, AgentEvent, StopSettlement, NativeTurnBinding,
  AgentQuestion, AgentQuestionAnswer } from './agent/types';
export type { SubmitRunInput, RunExecution, GovernedRunExecution, RunResult } from './runtime/run-executor';
export type { ConversationRuntimeOptions, ConversationIdentity, ConversationInput, ConversationStatus,
  ConversationSessionCandidate, ConversationSessionList } from './runtime/conversation';
export type { ExecutionController, ProfileExecutionControllerOptions } from './runtime/execution-controller';
export type { RunOutputPlugin, RunOutputContext, RunOutputOptions } from './runtime/run-output';
