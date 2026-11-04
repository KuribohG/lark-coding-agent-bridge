// Minimal headless library. No channel, web console, bot, CLI or model loop.
export { RunExecutor } from './run-executor';
export { ActiveRuns } from './active-runs';
export { ProcessPool } from './process-pool';
export { createDshHarness, createExecutionHost, DshAdapter, dshProfile, dshLease, dshStorageChecks,
  dshRecovery, dshEventDigest, nativeSession, publicText, usageOf } from '../agent/dsh/adapter';
export type { AgentRun, AgentRunOptions, AgentEvent, StopSettlement, NativeTurnBinding } from '../agent/types';
export type { SubmitRunInput, RunExecution, RunResult } from './run-executor';
