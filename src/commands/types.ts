import type { AgentAdapter } from '../agent/types';
import type { ActiveRuns } from '../runtime/active-runs';
import type { AppConfig } from '../config/schema';
import type { AgentKind, ProfileConfig } from '../config/profile-schema';
import type { OwnerRefreshState } from '../policy/access';
import type { SessionSummary } from '../session/history';
import type { CodexThreadHistoryEntry, ListCodexThreadHistoryOptions } from '../session/codex-history';
import type { SessionCatalog, SessionCatalogIdentity } from '../session/catalog';
import type { SessionStore } from '../session/store';
import type { ProcessPool } from '../runtime/process-pool';
import type { RunExecutor } from '../runtime/run-executor';
import type { WorkspaceStore } from '../workspace/store';
import type { LarkProfileAuth } from '../lark-auth/profile-auth';
import type { CommandDefinition } from './catalog';
import type { ConfigTrigger } from '../config/config-source';
import type { ConfigApplyReport } from '../config/apply';

/** The part of a quoted message side-question filtering needs. */
export interface CommandQuotedMessage {
  messageId: string;
  senderId: string;
  senderType?: string;
  content: string;
}

export interface BtwCommandControl {
  enqueue(question: string, ctx: CommandContext): Promise<void>;
  excludes(scope: string, msg: CommandQuotedMessage): boolean;
  reset(scope: string): void;
  cancel(scope: string): void;
}

/** A group the bot belongs to, as listed in access management. */
export interface KnownChat {
  id: string;
  name: string;
}

/** One inbound message as command handlers see it, independent of the channel SDK. */
export interface CommandMessage {
  messageId: string;
  chatId: string;
  chatType: 'p2p' | 'group';
  threadId?: string;
  rootId?: string;
  senderId: string;
  senderName?: string;
  /** Native sender kind (`user`, `bot`, …) when the channel reports one. */
  senderType?: string;
  content: string;
  mentions?: ReadonlyArray<{ openId?: string; name?: string; isBot?: boolean }>;
}

/** Content a command sends outside the turn pipeline. */
export type CommandContent = { markdown: string } | { card: object };

export interface CommandSendOptions {
  replyTo?: string;
  replyInThread?: boolean;
}

/** A card a command fills in while its run produces output. */
export interface CommandCardStream {
  card: {
    initial: object;
    producer(control: { update(next: object): Promise<void> }): Promise<void>;
  };
}

/**
 * What a command handler may ask of the channel its message arrived on.
 * Lark implements every capability; another channel implements what its
 * platform has and omits the rest, which only makes the commands that need
 * those features unusable there.
 */
export interface CommandChannel {
  /** Display name of the bot in this channel, when known. */
  readonly botName?: string;
  send(
    recipientId: string,
    content: CommandContent,
    options?: CommandSendOptions,
  ): Promise<{ messageId: string }>;
  /** Sends a card that `updateCard` can later replace in place. */
  sendCard(
    recipientId: string,
    card: object,
    options?: CommandSendOptions,
  ): Promise<{ messageId: string; cardId?: string }>;
  updateCard(messageId: string, card: object): Promise<void>;
  stream?(
    recipientId: string,
    content: CommandCardStream,
    options?: CommandSendOptions,
  ): Promise<unknown>;
  recallMessage?(messageId: string): Promise<void>;
  /** Chats the bot currently belongs to. */
  knownChats?(): Promise<KnownChat[]>;
  /** Share link of an existing message, when the platform has one. */
  messageLink?(messageId: string, timeoutMs?: number): Promise<string | undefined>;
  /** Share link of a conversation scope, when the platform has one. */
  conversationLink?(scopeId: string): string | undefined;
  /** Whether the app may receive group messages without being mentioned. */
  hasGroupMessageScope?(appId: string): Promise<boolean | null>;
  /** Creates a group chat with the given user. */
  createChat?(name: string, inviteOpenId: string): Promise<{ chatId: string; name: string }>;
}

export interface CommandDispatcher {
  find(name: string): CommandDefinition | undefined;
  list(): readonly CommandDefinition[];
  helpLines(escapedAgentName: string): string[];
  tryHandle(ctx: CommandContext): Promise<boolean>;
  run(name: string, args: string, ctx: CommandContext): Promise<boolean>;
}

export interface WorkflowControl {
  command(scope: string, args: string, message: CommandMessage): Promise<string | undefined>;
  /** Whether the scope has a workflow that is still running. */
  active(scope: string): boolean;
  invalidate(scope: string): void;
}

/** Engine choice of a single scope; scopes without one follow the bot default. */
export interface ScopeAgentControl {
  defaultKind(): AgentKind;
  adapter(scope: string, kind: AgentKind): AgentAdapter;
  /** Rejects, leaving the choice unchanged, when the engine cannot run here. */
  select(scope: string, kind: AgentKind): Promise<void>;
}

/** What a connected channel lends to commands and the supervisor, bound as one unit. */
export interface ChannelControls {
  /** Present once the workflow runtime has started. */
  workflow(): WorkflowControl | undefined;
  btw: BtwCommandControl;
  scopeAgents: ScopeAgentControl;
  cancelPendingInput(scope: string): number;
  flushPendingInput(): Promise<void>;
  pausePendingInput(): void;
  resumePendingInput(): void;
  detachPendingInput(): void;
  reloadPendingInput(): Promise<void>;
  /** Notify live consumers that cached derived state (e.g. the pool cap) changed. */
  onConfigApplied(): void;
}

export interface Controls {
  /** Live services of the connected channel; absent until it starts, reduced once it starts disconnecting. */
  channel?: ChannelControls;
  /** Commands contributed by the active plugin host. */
  commands?: CommandDispatcher;
  profile: string;
  profileConfig: ProfileConfig;
  botOwnerId?: string;
  botIdentity?: { openId: string; name?: string };
  ownerRefreshState: OwnerRefreshState;
  ownerRefreshedAt?: number;
  ownerRefreshError?: string;
  refreshOwner(): Promise<void>;
  /** Restart the bridge in-process: disconnect WS, kill claude runs and
   * reconnect. `config: 'reload'` (default) applies the config file, including
   * reconnect/restart-class settings; `'running'` keeps the running config
   * (keepalive recovery must not apply unrelated edits). */
  restart(opts?: { wait?: boolean; config?: 'reload' | 'running' }): Promise<void>;
  /** Re-read the config file and reconcile this profile; see config/settings.ts
   * for what applies live. Resolves after the change has been applied. */
  applyConfig?(trigger: ConfigTrigger, options?: { force?: boolean }): Promise<ConfigApplyReport>;
  /** Last reconcile result for this profile (applied / pending / failed). */
  configStatus?: ConfigApplyReport;
  /** Apply a persisted default engine to future runs without stopping active runs. */
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
}

export interface CommandContext {
  /** The channel this command arrived on, reduced to what commands need. */
  channel: CommandChannel;
  msg: CommandMessage;
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
  /** Effective engine for this scope. */
  agentKind: AgentKind;
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
  /**
   * Prompt left over after the command consumed a prefix of the message.
   * Channels that support it submit this text as a normal run once the
   * command handler returns; other channels ignore it.
   */
  followUpPrompt?: string;
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
