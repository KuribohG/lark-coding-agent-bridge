import type { AgentEvent, AgentRunOptions } from '../agent/types';
import type { ModelSettings, ReasoningEffort } from '../agent/model-settings';
import type { RunProfileConfig } from '../config/profile-schema';

/** Background execution availability is independent of a messaging connection. */
export interface ExecutionProfile {
  readonly config: RunProfileConfig;
  readonly available: boolean;
  readonly error?: string;
  /** Aborted when this execution policy is replaced or revoked. */
  readonly signal?: AbortSignal;
  settings(model?: string, effort?: ReasoningEffort): Promise<ModelSettings>;
  execute(options: AgentRunOptions & { cwd: string }, signal: AbortSignal,
    onEvent?: (event: AgentEvent) => void): Promise<{ text: string; inputTokens: number; outputTokens: number }>;
}

export interface ExecutionProvider {
  resolve(profile: string): Promise<ExecutionProfile | undefined>;
}
