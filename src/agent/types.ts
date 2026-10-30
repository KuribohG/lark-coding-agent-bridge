import type { AgentAvailability } from './preflight';
import type { ClaudePermissionMode, CodexSandboxMode } from '../config/permissions';
import type { ResolvedModelProvider } from '../model-provider/types';

export type { ClaudePermissionMode } from '../config/permissions';

/** Execution semantics, independent of native session identity and permission policy. */
export interface AgentExecutionCapabilities {
  readonly finalAnswer: 'separate-event' | 'stream';
  readonly input: 'active-turn' | 'active-session' | 'unsupported';
}

export type AgentFailureKind = 'rate_limit' | 'transient' | 'quota' | 'authentication' | 'delivery_unknown' | 'runtime';

export interface AgentInput {
  text: string;
  messageId: string;
}

/** Accepted means acknowledged by the transport, not yet processed by the model. */
export type AgentInputReceipt =
  | { status: 'accepted'; messageId: string; scope: 'active-turn' | 'active-session' }
  | { status: 'inactive' | 'unsupported'; messageId: string }
  | { status: 'unknown'; messageId: string; message: string };

export type AgentEvent =
  | { type: 'system'; sessionId?: string; threadId?: string; cwd?: string; model?: string }
  | { type: 'text'; delta: string }
  | { type: 'final_text'; content: string }
  | { type: 'thinking'; delta: string }
  | { type: 'user_input'; id: string; threadId: string; questions: Array<{ title: string; options?: string[] }> }
  | { type: 'retry'; attempt: number; maxAttempts: number; delayMs: number; failureKind?: 'rate_limit' | 'transient' }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; id: string; output: string; isError: boolean }
  | {
      type: 'usage';
      inputTokens?: number;
      outputTokens?: number;
      cachedInputTokens?: number;
      reasoningOutputTokens?: number;
      contextWindowTokens?: number;
      costUsd?: number;
    }
  | { type: 'status'; content: string; code?: string }
  | {
      type: 'done';
      sessionId?: string;
      threadId?: string;
      terminationReason: 'normal' | 'interrupted' | 'timeout';
    }
  | { type: 'error'; message: string; terminationReason: 'failed' | 'interrupted' | 'timeout'; failureKind?: AgentFailureKind };

export const CLAUDE_DEFAULT_PERMISSION_MODE: ClaudePermissionMode = 'bypassPermissions';

export interface AgentRunOptions {
  /** Trusted per-run host bindings, never model-supplied environment overrides. */
  env?: Readonly<Record<string, string>>;
  /** Optional provisional answer deltas, separate from the authoritative final_text event. */
  onMessageDelta?: (itemId: string, delta: string) => void;
  /** Absolute hard deadline, enforced by the adapter's independent watchdog. */
  deadlineAt?: number;
  runId: string;
  prompt: string;
  /** Trusted host instructions; overrides the adapter default for this run. */
  systemPrompt?: string;
  cwd?: string;
  sessionId?: string;
  threadId?: string;
  /** Run a side question from a snapshot; never append to the parent session. */
  forkSession?: boolean;
  model?: string;
  /** Backend-specific routing for a provider-qualified model selection. */
  modelProvider?: ResolvedModelProvider;
  reasoningEffort?: import('./model-settings').ReasoningEffort;
  images?: readonly string[];
  sandbox?: CodexSandboxMode;
  permissionMode?: ClaudePermissionMode;
  /**
   * Grace period (ms) between SIGTERM and SIGKILL when stop() is called on
   * the returned run. Lets the agent (and any subprocess it spawned, e.g.
   * lark-cli mid-OAuth) clean up before the kernel reaps the tree.
   * Adapters that don't kill via signals are free to ignore this. Defaults
   * are adapter-specific.
  */
  stopGraceMs?: number;
}

export interface AgentRun {
  readonly runId: string;
  readonly events: AsyncIterable<AgentEvent>;
  /** Omitted by legacy adapters; consumers must not infer capabilities from the agent name. */
  readonly capabilities?: AgentExecutionCapabilities;
  sendInput?(input: AgentInput): Promise<AgentInputReceipt>;
  stop(): Promise<void>;
  /** @deprecated Native input hook. Business code uses the execution contract's sendRunInput. */
  steer?(prompt: string, messageId: string): Promise<'accepted' | 'inactive'>;
  /**
   * Wait up to `timeoutMs` for the agent process to exit on its own.
   * Resolves true if it exited within the window, false if the timer
   * fired first (caller usually wants to fall back to stop()).
   *
   * Use this after a terminal stream event (`done` / `error`): the
   * stream-json `result` line arrives before claude has actually closed
   * stdout — there's a brief telemetry/cleanup tail in between. Calling
   * stop() in that window forces a SIGTERM and the run exits with code
   * 143 instead of 0; waiting it out lets it exit cleanly.
   */
  waitForExit(timeoutMs: number): Promise<boolean>;
}

/**
 * The bridge bot's own IM identity, resolved by the channel after the WS
 * handshake (`/open-apis/bot/v3/info`). Injected into adapters so the agent
 * system prompt can state "this open_id is you" with the real value.
 */
export interface AgentBotIdentity {
  openId: string;
  name?: string;
}

export interface AgentAdapter {
  modelProviderState?(): Promise<{ id: string; displayName: string; fixedUntilRestart: boolean; model?: string }>;
  readonly id: string;
  readonly displayName: string;
  readonly capabilities?: AgentExecutionCapabilities;
  isAvailable(): Promise<boolean>;
  checkAvailability?(): Promise<AgentAvailability>;
  prepareRun?(opts: AgentRunOptions): Promise<void>;
  run(opts: AgentRunOptions): AgentRun;
  /**
   * Late-bound identity injection: the adapter is constructed before the
   * channel connects, so the channel calls this once botIdentity is known.
   * Adapters that don't bake identity into their prompts may omit it.
   */
  setBotIdentity?(identity: AgentBotIdentity): void;
}
