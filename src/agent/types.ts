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

export interface AgentQuestionOption {
  label: string;
  description?: string;
}

export interface AgentQuestion {
  question: string;
  header?: string;
  options: AgentQuestionOption[];
  multiSelect?: boolean;
}

/**
 * `async`: the run keeps going and an answer is ordinary follow-up input.
 * `blocking`: the run waits until the host calls answerUserInput for this id.
 */
export type AgentQuestionMode = 'async' | 'blocking';

/** One entry per question: the chosen labels or free text. */
export type AgentQuestionAnswer = { answers: string[][] } | { declined: string };

export type AgentEvent =
  | { type: 'system'; sessionId?: string; threadId?: string; cwd?: string; model?: string }
  | { type: 'text'; delta: string }
  | { type: 'final_text'; content: string }
  | { type: 'thinking'; delta: string }
  | {
      type: 'user_input';
      id: string;
      mode: AgentQuestionMode;
      questions: AgentQuestion[];
      threadId?: string;
      sessionId?: string;
    }
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
  /** The host can present questions to a user and answer them; enables blocking question tools. */
  userQuestions?: boolean;
  /** Deliver text written before tool calls as part of the final answer (backends without a commentary channel). */
  answerIncludesInterimText?: boolean;
  /** Run under a detached run host so a bridge restart can reattach; ignored by adapters without host support. */
  host?: import('./run-host').RunHostBinding;
}

/** The first stop request owns the cause; transport cleanup must not replace it. */
export type RunStopReason = 'cancelled' | 'deadline' | 'idle' | 'shutdown' | 'yield' | 'input' | 'cleanup';

export interface AgentRun {
  readonly runId: string;
  readonly events: AsyncIterable<AgentEvent>;
  /** Consumers must not infer capabilities from the agent name. */
  readonly capabilities: AgentExecutionCapabilities;
  /** stop('shutdown') detaches from the native process, which keeps running for the next bridge process to reattach. */
  readonly detachOnShutdown?: boolean;
  sendInput?(input: AgentInput): Promise<AgentInputReceipt>;
  /** Resolve a pending blocking user_input request; inactive when it is no longer waiting. */
  answerUserInput?(id: string, answer: AgentQuestionAnswer): Promise<'accepted' | 'inactive'>;
  stop(reason?: RunStopReason): Promise<void>;
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

/** Transport run before `withExecutionContract` attaches capabilities and failure kinds. */
export type NativeAgentRun = Omit<AgentRun, 'capabilities'>;

/**
 * The bridge bot's own IM identity, resolved by the channel after the WS
 * handshake (`/open-apis/bot/v3/info`). Injected into adapters so the agent
 * system prompt can state "this open_id is you" with the real value.
 */
export interface AgentBotIdentity {
  openId: string;
  name?: string;
}

export interface PreparedAgentRun {
  readonly modelSettings: Readonly<import('./model-settings').ModelSettings>;
  readonly provider?: Readonly<{ id: string; requestedId?: string }>;
  start(): AgentRun;
}

export interface AgentAdapter {
  modelProviderState?(): Promise<{ id: string; displayName: string; fixedUntilRestart: boolean; model?: string }>;
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: AgentExecutionCapabilities;
  isAvailable(): Promise<boolean>;
  checkAvailability?(): Promise<AgentAvailability>;
  /** Preparation resolves the effective configuration; only its result can start an attempt. */
  prepareRun(opts: AgentRunOptions): Promise<PreparedAgentRun>;
  /**
   * Late-bound identity injection: the adapter is constructed before the
   * channel connects, so the channel calls this once botIdentity is known.
   * Adapters that don't bake identity into their prompts may omit it.
   */
  setBotIdentity?(identity: AgentBotIdentity): void;
  /**
   * Why replacing this adapter with `next` right now would disrupt active
   * runs (e.g. a shared daemon would have to restart), or undefined when the
   * swap is safe. Hot reload defers the swap until the adapter is idle.
   */
  replacementBlocker?(next: AgentAdapter, context: { providersChanged: boolean }): Promise<string | undefined> | string | undefined;
}
