import type { TimedRun } from '../runtime/timed-runs';
import type { LarkChannel, NormalizedMessage } from '@larksuite/channel';
import type { AgentAdapter } from '../agent/types';
import type { ActiveRuns } from '../bot/active-runs';
import type { AppConfig } from '../config/schema';
import type { AgentKind, ProfileConfig } from '../config/profile-schema';
import type { OwnerRefreshState } from '../policy/access';
import type { SessionSummary } from '../session/history';
import type { CodexThreadHistoryEntry, ListCodexThreadHistoryOptions } from '../session/codex-history';
import type { SessionCatalog, SessionCatalogIdentity } from '../session/catalog';
import type { SessionStore } from '../session/store';
import type { ProcessPool } from '../bot/process-pool';
import type { RunExecutor } from '../runtime/run-executor';
import type { WorkspaceStore } from '../workspace/store';
import type { KnownChat } from '../bot/lark-info';
import type { MeetingManager } from '../meeting/manager';
import type { LarkProfileAuth } from '../lark-auth/profile-auth';
import type { QuotedContext } from '../bot/quote';
import type { CommandDefinition } from './catalog';

export interface BtwCommandControl {
  enqueue(question: string, ctx: CommandContext): Promise<void>;
  excludes(scope: string, msg: QuotedContext): boolean;
  reset(scope: string): void;
  cancel(scope: string): void;
}

export interface CommandDispatcher {
  find(name: string): CommandDefinition | undefined;
  list(): readonly CommandDefinition[];
  helpLines(escapedAgentName: string): string[];
  tryHandle(ctx: CommandContext): Promise<boolean>;
  run(name: string, args: string, ctx: CommandContext): Promise<boolean>;
}

export interface Controls {
  /** Commands contributed by the active plugin host. */
  commands?: CommandDispatcher;
  cancelPendingInput?(scope: string): number;
  flushPendingInput?(): Promise<void>;
  pausePendingInput?(): void;
  resumePendingInput?(): void;
  detachPendingInput?(): void;
  reloadPendingInput?(): Promise<void>;
  btw?: BtwCommandControl;
  launchTimedRun?(job: TimedRun, message: NormalizedMessage): Promise<void>;
  cancelTimedRun?(scope: string, id?: string): void;
  activeTimedRun?(scope: string): string | undefined;
  profile: string;
  profileConfig: ProfileConfig;
  botOwnerId?: string;
  botIdentity?: { openId: string; name?: string };
  ownerRefreshState: OwnerRefreshState;
  ownerRefreshedAt?: number;
  ownerRefreshError?: string;
  refreshOwner(channel?: LarkChannel): Promise<void>;
  /** Restart the bridge in-process: disconnect WS, kill claude runs, reload
   * config, reconnect with the new credentials. */
  restart(opts?: { wait?: boolean }): Promise<void>;
  /** Apply a persisted agentKind change by briefly taking this profile offline. */
  switchAgent?(): Promise<void>;
  /** Stop this whole process gracefully (disconnect + exit). Used by /exit
   * when the user targets the receiving process itself. */
  exit(): Promise<void>;
  /** Path to the config file the bridge was started with. */
  configPath: string;
  /** The current app config (snapshot at startChannel time). */
  cfg: AppConfig;
  /** Profile-scoped Lark credentials and short-lived token cache. */
  larkAuth?: LarkProfileAuth;
  /** This process's short id in the registry. Used by /ps to highlight the
   * receiving process and by /exit to detect self-target. */
  processId: string;
  /** Groups the bot currently belongs to, used to render and bulk-manage access. */
  knownChats?: KnownChat[];
  /** In-meeting agent manager; present only while the channel is connected and
   * `meeting.enabled` is on. Late-bound by startChannel. */
  meeting?: MeetingManager;
}

export interface CommandContext {
  channel: LarkChannel;
  msg: NormalizedMessage;
  /**
   * Session scope string. For p2p / regular group it equals `msg.chatId`;
   * for topic groups it's `${chatId}:${threadId}` (so each topic gets its
   * own session / cwd / active-run). All handlers should read/write
   * session / workspace / activeRuns through this — never through
   * `msg.chatId` directly.
   */
  scope: string;
  /** Resolved chat mode for `msg.chatId`. Used by /status to surface the
   * scope semantic to the user (`topic` shows "话题独立 session"). */
  chatMode: 'p2p' | 'group' | 'topic';
  sessions: SessionStore;
  sessionCatalog?: SessionCatalog;
  sessionCatalogIdentity?: SessionCatalogIdentity;
  workspaces: WorkspaceStore;
  agent: AgentAdapter;
  /** Effective engine for this scope; legacy tests may omit it. */
  agentKind?: AgentKind;
  defaultAgentKind?: AgentKind;
  setAgentKind?(scope: string, kind: AgentKind): Promise<void>;
  activeRuns: ActiveRuns;
  processPool?: ProcessPool;
  runExecutor?: RunExecutor;
  controls: Controls;
  codexHistoryProvider?: (
    options: ListCodexThreadHistoryOptions,
  ) => Promise<CodexThreadHistoryEntry[]>;
  claudeHistoryProvider?: (cwd: string, limit: number, configDir?: string) => Promise<SessionSummary[]>;
  /** Set when invoked from a CardKit 2.0 form submit. Keys are input `name`s. */
  formValue?: Record<string, unknown>;
  /** True when this invocation came from a card button click rather than a
   * text command. Determines whether to update the existing card vs send a
   * new one. */
  fromCardAction?: boolean;
}

export type Handler = (args: string, ctx: CommandContext) => Promise<void>;

export interface FeatureCommandContribution {
  pluginId: string;
  definition: CommandDefinition;
  handler: Handler;
}
