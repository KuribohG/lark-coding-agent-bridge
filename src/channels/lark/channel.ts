import { larkDisplay } from './config';
import { createLarkRunOutput } from './run-output';
import { presentRunOutput } from '../../runtime/run-output';
import { findCommand } from '../../commands/catalog';
import { supportsRunInput } from '../../agent/execution';
import { modelRunArguments } from '../../agent/model-settings';
import { deadlineInstructions } from '../../runtime/run-deadline';
import { timedRuns, type TimedRun } from '../../runtime/timed-runs';
import { timedRunCard } from '../../card/timed-run-card';
import { BtwManager } from '../../bot/btw';
import { BtwStore } from '../../session/btw-store';
import { sendManagedCard } from '../../card/managed';
import { resolveRunModelSettings } from '../../runtime/model-settings';
import type { LarkChannel, LarkChannelOptions, NormalizedMessage } from '@larksuite/channel';
import { createLarkChannel } from '@larksuite/channel';
import { dirname, join } from 'node:path';
import { capabilityForProfile } from '../../agent/backends';
import { profileForAgentKind } from '../../runtime/execution-controller';
import { modelLabel, normalizeModelSelection, resolveModelArg } from '../../agent/models';
import {
  buildAgentPrompt,
  type BridgePromptInteractiveCard,
  type BridgePromptMention,
  type BridgePromptQuotedMessage,
  type BridgePromptTopicMessage,
} from '../../agent/prompt';
import type { AgentAdapter, AgentEvent } from '../../agent/types';
import type { ExecutionController } from '../../runtime/execution-controller';
import { handleCardAction } from '../../card/dispatcher';
import { CallbackAuth } from '../../card/callback-auth';
import { CallbackNonceStore } from '../../card/callback-store';
import type { RunState } from '../../runtime/run-state';
import { tryHandleCommand, type Controls } from '../../commands';
import type { AppConfig } from '../../config/schema';
import type { AgentKind } from '../../config/profile-schema';
import {
  getAgentStopGraceMs,
  getCotMessages,
  getMaxConcurrentRuns,
  getMessageReplyMode,
  getRunIdleTimeoutMs,
} from '../../config/schema';
import { resolveAppSecret } from '../../config/secret-resolver';
import { log, reportMetric, withTrace } from '../../core/logger';
import { MediaCache, type LocalAttachment } from '../../media/cache';
import { toPolicyAttachment, toPromptAttachment } from '../../media/attachment';
import { canUseDm, canUseGroup, requireMentionForChat } from '../../policy/access';
import { MeetingManager } from '../../meeting/manager';
import type { VcRequestClient } from '../../meeting/api';
import { attachMeetingAgent, summarizeEndedMeeting } from '../../meeting/orchestrator';
import type { ScopeContext } from '../../policy/run-policy';
import { createOwnerRefreshController } from '../../policy/owner';
import { RunExecutor } from '../../runtime/run-executor';
import type { SessionCatalog } from '../../session/catalog';
import type { SessionStore } from '../../session/store';
import type { WorkspaceStore } from '../../workspace/store';
import { ActiveRuns } from '../../runtime/active-runs';
import { ChatModeCache, type ChatMode } from '../../bot/chat-mode-cache';
import { handleCommentMention } from '../../bot/comments';
import { recordRunSessionEvent, startRunFlow } from '../../runtime/run-flow';
import { commandSessionCatalogIdentity } from '../../bot/session-catalog-identity';
import { startKeepalive } from '../../bot/keepalive';
import { PendingQueue } from '../../bot/pending-queue';
import { FollowupRouter } from '../../bot/followup';
import { UserQuestions } from '../../bot/user-questions';
import { ProcessPool } from '../../runtime/process-pool';
import { fetchQuotedContext, fetchTopicContext, type QuotedContext } from '../../bot/quote';
import { lookupMessageThreadId } from '../../bot/thread-id';
import { fetchKnownChats } from '../../bot/lark-info';
import type { AppPaths } from '../../config/app-paths';
import { CotClient } from '../../bot/cot';

const DEBOUNCE_MS = 600;

const BRIDGE_AGENT_INSTRUCTIONS = [
  '你在 bridge 进程中运行，普通 lark-cli 会继承 LARK_CHANNEL=1 并进入 bridge-bound 模式。',
  '不要 unset LARK_CHANNEL / LARK_CHANNEL_HOME / LARK_CHANNEL_PROFILE / LARKSUITE_CLI_CONFIG_DIR，也不要用 env -u LARK_CHANNEL 绕回本机普通配置。',
  'Codex bridge 默认使用 danger-full-access 对齐 Claude bridge 的 bypassPermissions 行为，因此 lark-cli 应能像用户本机终端一样访问 keychain。',
  '如果提示 lark-channel context detected but not bound，停止当前操作并请用户重启 bridge 或运行 bridge doctor/preflight；不要改用普通 profile，不要自行 bind，也不要直接读取 config.json 里的账号或密钥。',
];

// Lark SDK logs API errors at error level even when the caller catches them.
// These specific codes are EXPECTED in our flow (wiki-node lookup that
// usually misses, fileComment.get that we deliberately let fall back to
// .list) and the surrounding noise is already covered by our own logs.
const SUPPRESSED_API_ERROR_CODES = new Set([
  131005, // wiki.space.getNode "not found" — the doc isn't a wiki node
  1069307, // drive.fileComment.get "not exist" — fall back to .list
  1069302, // drive.fileCommentReply.create — whole-doc comments don't accept replies; fall back to fileComment.create
]);

const SUPPRESSED_ENDPOINT_API_ERRORS = [
  {
    code: 99991672,
    urlPart: '/open-apis/wiki/v2/spaces/get_node',
  },
];

function codeFromObj(m: unknown): number | undefined {
  if (!m || typeof m !== 'object') return undefined;
  const top = (m as { code?: unknown }).code;
  if (typeof top === 'number') return top;
  const nested = (m as { response?: { data?: { code?: unknown } } })?.response?.data?.code;
  return typeof nested === 'number' ? nested : undefined;
}

function urlFromObj(m: unknown): string | undefined {
  if (!m || typeof m !== 'object') return undefined;
  const configUrl = (m as { config?: { url?: unknown } })?.config?.url;
  if (typeof configUrl === 'string') return configUrl;
  const requestPath = (m as { request?: { path?: unknown } })?.request?.path;
  return typeof requestPath === 'string' ? requestPath : undefined;
}

function isSuppressedSdkMessage(msg: unknown): boolean {
  if (Array.isArray(msg)) return msg.some(isSuppressedSdkMessage);
  const code = codeFromObj(msg);
  if (code === undefined) return false;
  if (SUPPRESSED_API_ERROR_CODES.has(code)) return true;
  const url = urlFromObj(msg);
  return SUPPRESSED_ENDPOINT_API_ERRORS.some(
    (rule) => code === rule.code && url?.includes(rule.urlPart),
  );
}

export function shouldSuppressSdkErrorLog(args: unknown[]): boolean {
  return args.some(isSuppressedSdkMessage);
}

function buildQuietLogger(): {
  error: (...m: unknown[]) => void;
  warn: (...m: unknown[]) => void;
  info: (...m: unknown[]) => void;
  debug: (...m: unknown[]) => void;
  trace: (...m: unknown[]) => void;
} {
  return {
    error: (...args: unknown[]) => {
      if (shouldSuppressSdkErrorLog(args)) return;
      log.warn('sdk', 'error', { args: stringifyArgs(args) });
    },
    warn: (...args: unknown[]) => log.warn('sdk', 'warn', { args: stringifyArgs(args) }),
    info: (...args: unknown[]) => log.info('sdk', 'info', { args: stringifyArgs(args) }),
    debug: () => {},
    trace: () => {},
  };
}

function stringifyArgs(args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === 'string') return a;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(' ');
}

export interface BridgeChannel {
  channel: LarkChannel;
  disconnect(): Promise<void>;
}

export interface StartChannelDeps {
  cfg: AppConfig;
  execution: ExecutionController;
  sessions: SessionStore;
  sessionCatalog?: SessionCatalog;
  workspaces: WorkspaceStore;
  controls: Controls;
  appPaths?: Pick<AppPaths, 'secretsFile' | 'keystoreSaltFile' | 'mediaDir'>;
}

export async function startLarkChannel(deps: StartChannelDeps): Promise<BridgeChannel> {
  const { cfg, execution, sessions, sessionCatalog, workspaces, controls } = deps;
  const resolveAgent = (scope: string) => execution.get(scope);
  const resolveAgentKind = (scope: string) => execution.kindFor(scope);
  const setAgentKind = (scope: string, kind: AgentKind) => execution.setScopeKind(scope, kind);
  const activeRuns = new ActiveRuns();
  const followups = new FollowupRouter();
  const batchControllers = new Map<string, AbortController>();
  // ChatModeCache stays per-bridge-instance — invalidated on restart along
  // with everything else. Topic-mode chats only need one chat.get() call ever.
  const chatModeCache = new ChatModeCache();
  // Concurrency cap — reads `preferences.maxConcurrentRuns` on each acquire,
  // so /config bumps take effect for the next run.
  const pool = new ProcessPool(() => getMaxConcurrentRuns(controls.cfg));
  const executor = new RunExecutor({
    resolveAgent,
    resolveModelProvider: (agentKind, model) => execution.resolveModelProvider(agentKind, model),
    pool,
    activeRuns,
  });

  // Resolve the App Secret to plaintext. The config field can be a literal
  // string, a "${VAR}" template, or a {source, id} SecretRef referencing
  // the encrypted keystore / env / file / exec provider. Re-resolved on
  // every startChannel so /account change picks up new secrets.
  const appSecret = await resolveAppSecret(cfg, deps.appPaths);
  const callbackNonceStore = deps.appPaths?.mediaDir
    ? new CallbackNonceStore(join(dirname(deps.appPaths.mediaDir), 'callback-nonces.json'))
    : undefined;
  await callbackNonceStore?.load();
  const callbackAuth = callbackNonceStore
    ? new CallbackAuth({
        keys: [{ version: 1, secret: appSecret }],
        nonceStore: callbackNonceStore,
      })
    : undefined;
  const activePolicyFingerprints = new Map<string, string>();
  // Per-scope record of the model used on the last run, so a `/config` model
  // switch can inject a one-time "model changed" note into the next (resumed)
  // prompt. In-memory only: on restart the first run re-seeds silently.
  const lastRunModelByScope = new Map<string, string>();
  const cotClient = new CotClient({
    tenant: cfg.accounts.app.tenant,
    appId: cfg.accounts.app.id,
    appSecret,
  });
  const threadModeOverrideWarnedChats = new Set<string>();
  const logThreadModeOverride: LogThreadModeOverride = ({ chatId, resolvedMode, threadId }) => {
    const fields = { chatId, cachedMode: resolvedMode, threadId };
    if (threadModeOverrideWarnedChats.has(chatId)) {
      log.info('chat', 'mode-overridden-by-thread', fields);
      return;
    }
    threadModeOverrideWarnedChats.add(chatId);
    log.warn('chat', 'mode-overridden-by-thread', fields);
  };

  const opts: LarkChannelOptions = {
    appId: cfg.accounts.app.id,
    appSecret,
    domain:
      cfg.accounts.app.tenant === 'lark'
        ? 'https://open.larksuite.com'
        : 'https://open.feishu.cn',
    source: 'lark-channel-bridge',
    logger: buildQuietLogger(),
    policy: {
      dmMode: 'open',
      requireMention: false,
      respondToMentionAll: false,
    },
    // Disable per-chat serialization so we can implement our own
    // debounce + run-chain policy (see pending-queue + runChain below).
    safety: {
      chatQueue: { enabled: false },
    },
    // Attach raw Feishu event body to normalized events so we can read fields
    // the normalizer drops (e.g. action.form_value on CardKit 2.0 form submits).
    includeRawEvent: true,
    outbound: {
      streamThrottleMs: 400,
    },
    // SDK 1.65.0-alpha.3+ knobs.
    wsConfig: {
      // 3s liveness watchdog: if no inbound message arrives within 3s after
      // the last ping, SDK presumes connection dead and forces a reconnect.
      pingTimeout: 3,
    },
    // 8s handshake timeout (replaces hardcoded 15s). Fast-fail + fast-retry
    // beats slow-fail in unstable networks.
    handshakeTimeoutMs: 8_000,
    // Per-request REST timeout — without a cap a slow API can hang the
    // event-handling thread.
    httpTimeoutMs: 30_000,
    // Route WS + REST through HTTPS_PROXY / HTTP_PROXY when set (no-op otherwise).
    respectProxyEnv: true,
  };

  const channel = createLarkChannel(opts);
  const media = new MediaCache(channel, deps.appPaths?.mediaDir);
  const btwStore = new BtwStore(deps.appPaths?.mediaDir
    ? join(dirname(deps.appPaths.mediaDir), 'btw.json') : undefined);
  await btwStore.load();
  const btw = new BtwManager(btwStore);
  controls.btw = btw;

  // Pending → run handoff: while a run is active on a chat, block its pending
  // queue so messages keep accumulating without flushing. When the run ends,
  // unblock arms a fresh quiet-window timer. Net effect: at most one run per
  // chat in flight, and everything sent during a run merges into the next
  // batch (only flushed once 600ms of silence has passed *after* the run).
  const pending = new PendingQueue(DEBOUNCE_MS, (scope, batch) => {
    const firstMsg = batch[0];
    if (!firstMsg) return;
    pending.block(scope);
    const controller = new AbortController();
    batchControllers.set(scope, controller);
    void withTrace({ chatId: firstMsg.chatId }, async () => {
      log.info('flush', 'start', {
        scope,
        batchSize: batch.length,
        chatId: firstMsg.chatId,
        threadId: firstMsg.threadId,
        msgId: firstMsg.messageId,
      });
      try {
        const resolvedMode = await chatModeCache.resolve(channel, firstMsg.chatId);
        // Feishu/Lark converted topic groups may still resolve as `group` from
        // the chat info API/cache, while message events already carry threadId.
        // Treat threadId as authoritative for IM messages so scope and replies
        // stay isolated per topic.
        const mode = firstMsg.threadId ? 'topic' : resolvedMode;
        if (firstMsg.threadId && resolvedMode !== 'topic') {
          chatModeCache.invalidate(firstMsg.chatId);
          logThreadModeOverride({
            chatId: firstMsg.chatId,
            resolvedMode,
            threadId: firstMsg.threadId,
          });
        }
        await runAgentBatch({
          signal: controller.signal,
          channel,
          executor,
          sessions,
          sessionCatalog,
          workspaces,
          media,
          batch,
          controls,
          cotClient,
          callbackAuth,
          userQuestions,
          activePolicyFingerprints,
          lastRunModelByScope,
          scope,
          agentKind: resolveAgentKind(scope),
          mode,
        });
      } catch (err) {
        log.fail('flush', err);
      } finally {
        if (batchControllers.get(scope) === controller) batchControllers.delete(scope);
        pending.unblock(scope);
        log.info('flush', 'end');
      }
    });
  });

  const userQuestions = new UserQuestions({ channel, auth: callbackAuth, activeRuns, followups,
    pending, catalog: sessionCatalog, isTimed: scope => Boolean(controls.activeTimedRun?.(scope)) });

  controls.cancelPendingInput = (scope) => {
    batchControllers.get(scope)?.abort();
    return pending.cancel(scope).length;
  };

  const timedStore = await timedRuns(controls);
  const timedControllers = new Map<string, { id: string; controller: AbortController }>();
  controls.activeTimedRun = (scope) => timedControllers.get(scope)?.id;
  controls.cancelTimedRun = (scope, id) => {
    const active = timedControllers.get(scope);
    if (active && (!id || active.id === id)) active.controller.abort();
  };
  controls.launchTimedRun = async (job, message) => {
    if (timedControllers.has(job.scope) || activeRuns.get(job.scope) || pending.hasWork(job.scope)) {
      throw new Error('当前话题/聊天仍有任务或待处理消息，请完成或 /stop 后再启动限时任务。');
    }
    const controller = new AbortController();
    timedControllers.set(job.scope, { id: job.id, controller });
    pending.block(job.scope);
    try {
      await timedStore.transition(job.id, ['draft'], 'queued');
    } catch (err) {
      timedControllers.delete(job.scope);
      pending.unblock(job.scope);
      throw err;
    }
    const sendOpts = { replyTo: message.messageId, ...(message.threadId ? { replyInThread: true } : {}) };
    void withTrace({ chatId: message.chatId }, async () => {
      try {
        const mode = message.threadId ? 'topic' : await chatModeCache.resolve(channel, message.chatId);
        await sendManagedCard(channel, message.chatId, timedRunCard(timedStore.get(job.id)!), sendOpts);
        await runAgentBatch({
          channel, executor, sessions, sessionCatalog, workspaces, media,
          batch: [{ ...message, content: job.task, resources: [], rawContentType: 'text' }],
          controls, cotClient, callbackAuth, userQuestions, activePolicyFingerprints, lastRunModelByScope,
          scope: job.scope, agentKind: job.agentKind ?? resolveAgentKind(job.scope), mode,
          timedJob: job, signal: controller.signal,
        });
      } catch (err) {
        log.fail('timed-run', err, { jobId: job.id });
      } finally {
        // A failure before executor submission must also close the one-shot job.
        try {
          await timedStore.finish(job.id, controller.signal.aborted ? 'stopped' : Date.now() >= job.stopAt ? 'expired' : 'failed');
        } finally {
          timedControllers.delete(job.scope);
          pending.unblock(job.scope);
        }
        await sendManagedCard(channel, message.chatId, timedRunCard(timedStore.get(job.id)!), sendOpts)
          .catch((err) => log.warn('timed-run', 'status-send-failed', { err: String(err) }));
      }
    }).catch((err) => log.fail('timed-run', err, { jobId: job.id }));
  };

  // Counter for stdout reconnect escalation; reset on `reconnected`.
  let consecutiveReconnects = 0;

  channel.on({
    message: async (msg) => {
      await withTrace({ chatId: msg.chatId, msgId: msg.messageId }, () =>
        intakeMessage({
          followups,
          channel,
          resolveAgent,
          resolveAgentKind,
          setAgentKind,
          sessions,
          sessionCatalog,
          workspaces,
          activeRuns,
          pending,
          msg,
          controls,
          chatModeCache,
          logThreadModeOverride,
          executor,
          pool,
        }),
      ).catch((err) => log.fail('intake', err));
    },
    reject: (evt) => {
      log.info('intake', 'reject', { chatId: evt.chatId, reason: evt.reason });
    },
    cardAction: async (evt) => {
      return withTrace({ chatId: evt.chatId, msgId: evt.messageId }, async () => {
        return handleCardAction({
          channel,
          evt,
          sessions,
          sessionCatalog,
          workspaces,
          activeRuns,
          resolveAgent,
          resolveAgentKind,
          setAgentKind,
          processPool: pool,
          runExecutor: executor,
          controls,
          pending,
          chatModeCache,
          callbackAuth,
          userQuestions,
          callbackPolicyFingerprintForScope: (scope) => activePolicyFingerprints.get(scope),
        });
      }).catch((err) => log.fail('cardAction', err));
    },
    comment: async (evt) => {
      await withTrace({ chatId: 'comment' }, async () => {
        await handleCommentMention({
          channel,
          evt,
          resolveAgent,
          resolveAgentKind,
          sessions,
          sessionCatalog,
          workspaces,
          activeRuns,
          executor,
          controls,
        }).catch((err) => log.fail('comment', err));
      }).catch((err) => log.fail('comment', err));
    },
    reconnecting: () => {
      consecutiveReconnects++;
      log.warn('ws', 'reconnecting', { consecutive: consecutiveReconnects });
      reportMetric('ws_reconnect', 1, { kind: 'ws' });
      // Stdout escalation — surface jitter that's hidden in the file log.
      if (consecutiveReconnects === 3) {
        console.error('⚠️ 已连续重连 3 次,网络可能不稳。');
      } else if (consecutiveReconnects === 10) {
        console.error('❌ 已连续重连 10 次,建议在飞书发 /reconnect 或重启 bot。');
      }
    },
    reconnected: () => {
      if (consecutiveReconnects > 1) {
        log.info('ws', 'recovered', { afterAttempts: consecutiveReconnects });
      } else {
        log.info('ws', 'reconnected');
      }
      consecutiveReconnects = 0;
    },
    // Classify common WS errors into the `network` phase so /doctor and grep
    // can find them without scanning generic `ws.fail` entries.
    error: (err) => {
      const msg = err?.message ?? String(err);
      if (/ENOTFOUND|getaddrinfo/.test(msg)) {
        log.fail('network', err, { kind: 'dns', code: err.code });
      } else if (/handshake|did not complete/.test(msg)) {
        log.fail('network', err, { kind: 'handshake-timeout', code: err.code });
      } else if (/timeout/i.test(msg)) {
        log.fail('network', err, { kind: 'timeout', code: err.code });
      } else {
        log.fail('ws', err, { code: err.code });
      }
    },
  });

  // In-meeting agent. Created before connect() so the `vc.bot.*` handlers are
  // installed on the event dispatcher before any push can arrive; sessions are
  // only created later (on /meeting join or an invite), so the late-bound
  // botOpenId getter is resolved by then.
  const meetingConfig = () => controls.profileConfig.meeting;
  let meetingManager: MeetingManager | undefined;
  if (meetingConfig().enabled) {
    meetingManager = new MeetingManager({
      client: channel.rawClient as unknown as VcRequestClient,
      config: meetingConfig,
      botOpenId: () => channel.botIdentity?.openId,
      channel,
      // Meeting over: optionally summarize to IM (config-gated inside).
      onEnded: (session) =>
        void summarizeEndedMeeting({
          session,
          channel,
          controls,
          executor,
          activeRuns,
          sessions,
          ...(sessionCatalog ? { sessionCatalog } : {}),
          workspaces,
          resolveAgentKind,
        }).catch((err) => log.warn('meeting', 'summary-failed', { err: String(err) })),
      onSession: (session) =>
        attachMeetingAgent({
          session,
          channel,
          controls,
          executor,
          activeRuns,
          sessions,
          ...(sessionCatalog ? { sessionCatalog } : {}),
          workspaces,
          resolveAgentKind,
        }),
    });
    meetingManager.attachPush();
    controls.meeting = meetingManager;
  }

  await channel.connect();
  const ownerRefresh = createOwnerRefreshController({
    controls,
    source: channel,
    appId: cfg.accounts.app.id,
  });
  await ownerRefresh.start();
  const knownChatsRefresh = startKnownChatsRefreshTimer(channel, controls);

  const identity = channel.botIdentity;
  controls.botIdentity = identity;
  // Late-bind the bot's own IM identity into the agent adapter so the system
  // prompt can state "this open_id is you" with the real value. Covers both
  // initial start and credential-swap reconnects (both go through here).
  if (identity?.openId) {
    execution.setBotIdentity({
      openId: identity.openId,
      ...(identity.name ? { name: identity.name } : {}),
    });
  }
  const defaultAgent = execution.defaultAgent();
  log.info('ws', 'connected', {
    bot: identity?.name ?? 'unknown',
    openId: identity?.openId ?? '-',
    agent: `${defaultAgent.displayName} (${defaultAgent.id})`,
    appId: cfg.accounts.app.id,
    procId: controls.processId,
  });
  console.log('正在监听消息。按 Ctrl+C 退出。\n');

  // App-level keepalive: 15s probe + wake-up detection + HTTP reachability.
  // Defense-in-depth — the SDK's pingTimeout watchdog handles half-dead WS,
  // this catches anything that the SDK misses (silent state stuck, etc.).
  const probeDomain =
    cfg.accounts.app.tenant === 'lark'
      ? 'https://open.larksuite.com'
      : 'https://open.feishu.cn';
  const keepalive = startKeepalive({
    channel,
    domain: probeDomain,
    forceReconnect: () => controls.restart(),
  });

  return {
    channel,
    disconnect: async () => {
      activeRuns.pauseNewRuns('bridge-disconnect');
      controls.btw = undefined;
      const btwClosed = btw.close();
      controls.launchTimedRun = undefined;
      for (const { controller } of timedControllers.values()) controller.abort();
      ownerRefresh.stop();
      knownChatsRefresh.stop();
      keepalive.stop();
      // Stop meeting timers but stay in the meetings: /reconnect tears the
      // channel down and rebuilds it, and auto-leaving every meeting on a
      // reconnect would be surprising.
      meetingManager?.dispose();
      controls.meeting = undefined;
      pending.cancelAll();
      userQuestions.close();
      const [disconnectResult, stopAllResult, ...flushResults] = await Promise.allSettled([
        channel.disconnect(),
        activeRuns.stopAll(),
        sessions.flush(),
        sessionCatalog?.flush(),
        callbackNonceStore?.flush(),
        workspaces.flush(),
        btwClosed,
      ]);
      if (stopAllResult.status === 'rejected') {
        log.fail('disconnect', stopAllResult.reason, { step: 'stopAll' });
      }
      for (const [idx, result] of flushResults.entries()) {
        if (result.status === 'rejected') {
          log.fail('disconnect', result.reason, { step: `flush-${idx}` });
        }
      }
      if (disconnectResult.status === 'rejected') {
        throw disconnectResult.reason;
      }
    },
  };
}

function startKnownChatsRefreshTimer(
  channel: LarkChannel,
  controls: Controls,
): { stop(): void } {
  const intervalMs = 30 * 60 * 1000;
  const refresh = async (): Promise<void> => {
    const chats = await fetchKnownChats(channel);
    if (chats.length > 0) {
      controls.knownChats = chats;
    }
  };
  void refresh();
  const timer = setInterval(() => void refresh(), intervalMs);
  return {
    stop() {
      clearInterval(timer);
    },
  };
}

async function sendNonAllowedGroupHint(
  channel: LarkChannel,
  chatId: string,
  replyToMessageId: string,
): Promise<void> {
  const text =
    '当前群尚未加入响应列表，所以 bot 不会处理消息。\n' +
    'Bot owner/管理员可在本群发 /invite group 加入白名单。';
  try {
    await channel.send(chatId, { text }, { replyTo: replyToMessageId });
  } catch {
    await channel.send(chatId, { text });
  }
}

/**
 * The SDK (@larksuite/channel >= 0.4.1) normalizes a merge_forward whose
 * sub-messages it could not fetch — after its own retries — to this exact
 * sentinel, rather than the empty `<forwarded_messages/>` it emits for a
 * genuinely empty forward. Distinguishing the two is the whole point of that
 * fix: pre-0.4.1 a transient Feishu 5xx/timeout on `im.v1.message.get` was
 * silently indistinguishable from empty, so the agent saw an empty forward and
 * replied "转发内容是空的，请重新转发一次".
 */
const FORWARD_FETCH_FAILED_CONTENT = '<forwarded_messages status="fetch_failed"/>';

/** True when a message is a merge_forward the SDK failed to fetch (see above). */
function isForwardFetchFailed(msg: NormalizedMessage): boolean {
  return (
    msg.rawContentType === 'merge_forward' &&
    msg.content.trim() === FORWARD_FETCH_FAILED_CONTENT
  );
}

async function sendForwardFetchFailedHint(
  channel: LarkChannel,
  chatId: string,
  replyToMessageId: string,
): Promise<void> {
  const text =
    '这条合并转发的内容没能从飞书拉取到（上游超时/网络抖动，已自动重试仍失败），' +
    '所以我没收到里面的消息。麻烦稍后重新转发一次。';
  try {
    await channel.send(chatId, { text }, { replyTo: replyToMessageId });
  } catch {
    await channel.send(chatId, { text });
  }
}

interface IntakeDeps {
  followups: FollowupRouter;
  channel: LarkChannel;
  resolveAgent(scope: string): AgentAdapter;
  resolveAgentKind(scope: string): AgentKind;
  setAgentKind?(scope: string, kind: AgentKind): Promise<void>;
  sessions: SessionStore;
  sessionCatalog?: SessionCatalog;
  workspaces: WorkspaceStore;
  activeRuns: ActiveRuns;
  pending: PendingQueue;
  msg: NormalizedMessage;
  controls: Controls;
  chatModeCache: ChatModeCache;
  logThreadModeOverride: LogThreadModeOverride;
  executor: RunExecutor;
  pool: ProcessPool;
}

type LogThreadModeOverride = (input: {
  chatId: string;
  resolvedMode: ChatMode;
  threadId: string;
}) => void;

async function intakeMessage(deps: IntakeDeps): Promise<void> {
  const {
    channel,
    resolveAgent,
    resolveAgentKind,
    setAgentKind,
    sessions,
    sessionCatalog,
    workspaces,
    activeRuns,
    pending,
    msg,
    controls,
    chatModeCache,
    logThreadModeOverride,
    executor,
    pool,
  } = deps;
  const preview = msg.content.length > 80 ? `${msg.content.slice(0, 80)}…` : msg.content;
  // Resolve scope (and underlying chat mode) once at intake — every
  // downstream consumer keys off these.
  const resolvedMode = await chatModeCache.resolve(channel, msg.chatId);
  // Feishu delivers a sizable fraction of topic-group message events without a
  // `thread_id` (notably the message that opens a new topic). We route topic
  // replies (`replyInThread`) and isolate per-topic session scope off it, so a
  // missing one makes the reply escape into a brand-new topic AND collapses the
  // scope to the chat level. When getChatMode says this is a topic group but
  // the event dropped `thread_id`, backfill it from the raw message — the same
  // recovery the card-click path uses.
  let threadId = msg.threadId;
  if (!threadId && resolvedMode === 'topic') {
    threadId = await lookupMessageThreadId(channel, msg.messageId);
    if (threadId) {
      log.info('intake', 'thread-id-backfilled', {
        chatId: msg.chatId,
        msgId: msg.messageId,
        threadId,
      });
    }
  }
  // Carry the (possibly backfilled) threadId on the message so the batched
  // flush — which reads `firstMsg.threadId` for reply routing and topic scope —
  // sees it.
  const emsg: NormalizedMessage = threadId === msg.threadId ? msg : { ...msg, threadId };
  // Some groups are converted into topic groups after creation. In that state
  // getChatMode can lag behind the message event shape, so threadId is the
  // stronger signal for topic-scoped sessions and reply routing.
  const chatMode = threadId ? 'topic' : resolvedMode;
  if (threadId && resolvedMode !== 'topic') {
    chatModeCache.invalidate(msg.chatId);
    logThreadModeOverride({
      chatId: msg.chatId,
      resolvedMode,
      threadId,
    });
  }
  const scope = chatMode === 'topic' && threadId
    ? `${msg.chatId}:${threadId}`
    : msg.chatId;
  log.info('intake', 'enter', {
    scope,
    chatType: msg.chatType,
    chatMode,
    resolvedMode,
    threadId,
    msgId: msg.messageId,
    sender: msg.senderId,
    preview,
    resources: msg.resources.length,
  });

  const accessDecision =
    msg.chatType === 'p2p'
      ? canUseDm(controls.profileConfig, controls, msg.senderId)
      : canUseGroup(controls.profileConfig, controls, msg.chatId, msg.senderId);
  if (!accessDecision.ok) {
    log.info('intake', 'skip-not-allowed-user', {
      scope,
      sender: msg.senderId.slice(-6),
      reason: accessDecision.reason,
    });
    if (msg.chatType !== 'p2p' && accessDecision.reason === 'denied-chat' && msg.mentionedBot) {
      void sendNonAllowedGroupHint(channel, msg.chatId, msg.messageId).catch((err) =>
        log.warn('intake', 'non-allowed-hint-failed', { err: String(err) }),
      );
    }
    return;
  }

  // Group-mention policy. p2p is always unrestricted; in groups (regular and
  // topic) we drop messages that don't @bot when the user has opted into the
  // quiet-by-default behavior. A per-chat override (set from /config's group
  // picker) takes priority over the global setting, so one group can respond
  // to everything while others stay @-only (or vice versa). Slash commands are
  // NOT exempt — the user chose strict mode so the group stays uniformly quiet
  // unless mentioned. @全员 is already filtered by SDK
  // (`respondToMentionAll: false`), so any event reaching here is either
  // targeted or undirected chatter.
  if (
    msg.chatType !== 'p2p' &&
    requireMentionForChat(controls.profileConfig, controls.cfg, msg.chatId) &&
    !msg.mentionedBot
  ) {
    log.info('intake', 'skip-no-mention', { scope, chatType: msg.chatType });
    return;
  }

  // A merge_forward whose sub-messages the SDK could not fetch (transient
  // upstream failure, already retried inside @larksuite/channel) arrives as the
  // fetch_failed sentinel. Feeding it to the agent would read as an empty
  // forward, so surface a recoverable hint and skip the run — the user can
  // resend once the upstream recovers.
  if (isForwardFetchFailed(emsg)) {
    log.warn('intake', 'forward-fetch-failed', {
      scope,
      msgId: emsg.messageId,
      chatType: emsg.chatType,
    });
    await sendForwardFetchFailedHint(channel, emsg.chatId, emsg.messageId).catch((err) =>
      log.warn('intake', 'forward-fetch-failed-hint-failed', { err: String(err) }),
    );
    return;
  }

  const scopeAgentKind = resolveAgentKind(scope);
  const scopeAgent = resolveAgent(scope);
  const handled = await tryHandleCommand({
    channel,
    msg: emsg,
    scope,
    chatMode,
    sessions,
    workspaces,
    agent: scopeAgent,
    agentKind: scopeAgentKind,
    defaultAgentKind: controls.profileConfig.agentKind,
    setAgentKind,
    activeRuns,
    sessionCatalog,
    sessionCatalogIdentity: await commandSessionCatalogIdentity({
      msg: emsg,
      scope,
      mode: chatMode,
      workspaces,
      controls,
      access: accessDecision,
      agentKind: scopeAgentKind,
    }),
    runExecutor: executor,
    processPool: pool,
    controls,
  });
  if (handled) {
    const name = emsg.content.trim().split(/\s+/)[0];
    const dropped = findCommand(name ?? '')?.pending === 'preserve' ? [] : pending.cancel(scope);
    log.info('intake', 'command', { scope, droppedPending: dropped.length });
    return;
  }

  const wasBusy = pending.isBlocked(scope) || Boolean(activeRuns.get(scope));
  const wasTimed = Boolean(controls.activeTimedRun?.(scope));
  if (emsg.resources.length === 0 && supportsRunInput(activeRuns.get(scope)?.run)) {
    const result = await deps.followups.deliver({
      scope, messageId: emsg.messageId, activeRuns,
      prepare: async () => {
        const target = replyQuoteTargetForMessage(emsg, chatMode);
        const quote = target ? await fetchQuotedContext(channel, target) : undefined;
        return buildPrompt([emsg], [], quote ? [quote] : [], [], channel.botIdentity,
          ['这是用户在当前任务执行期间发来的补充消息。请结合原任务处理；消息未明确取消原目标时继续保留原目标。']);
      },
    });
    if (result !== 'queued') {
      const markdown = result === 'accepted' ? '已送入当前任务，等待模型处理。'
        : result === 'cancelled' ? '当前任务已收到停止请求，这条补充不会另起任务执行。'
        : '未收到当前任务的接收确认，暂时无法确定这条补充是否送达。为避免重复执行，没有自动重发。';
      await channel.send(emsg.chatId, { markdown }, { replyTo: emsg.messageId,
        ...(chatMode === 'topic' ? { replyInThread: true } : {}) });
      return;
    }
  }
  if (wasTimed || controls.activeTimedRun?.(scope)) {
    await channel.send(emsg.chatId, { markdown: '当前话题/聊天正在执行限时任务。这条消息未排队执行，避免到期后自动续跑；修改任务请先 /stop，再重新提交。' }, {
      replyTo: emsg.messageId, ...(chatMode === 'topic' ? { replyInThread: true } : {}),
    });
    return;
  }
  const size = pending.push(scope, emsg);
  if (wasBusy) {
    await channel.send(emsg.chatId, { markdown: '已排队，将在当前任务结束后处理；/stop 会同时取消排队消息。' }, {
      replyTo: emsg.messageId, ...(chatMode === 'topic' ? { replyInThread: true } : {}),
    });
  }
  log.info('intake', 'queued', { scope, queueSize: size, debounceMs: DEBOUNCE_MS });
}

interface RunBatchDeps {
  timedJob?: TimedRun;
  signal?: AbortSignal;
  channel: LarkChannel;
  executor: RunExecutor;
  sessions: SessionStore;
  sessionCatalog?: SessionCatalog;
  workspaces: WorkspaceStore;
  media: MediaCache;
  batch: NormalizedMessage[];
  controls: Controls;
  cotClient: CotClient;
  callbackAuth?: CallbackAuth;
  userQuestions: UserQuestions;
  activePolicyFingerprints: Map<string, string>;
  lastRunModelByScope: Map<string, string>;
  scope: string;
  agentKind: AgentKind;
  mode: ChatMode;
}

async function runAgentBatch(deps: RunBatchDeps): Promise<void> {
  const {
    channel,
    executor,
    sessions,
    sessionCatalog,
    workspaces,
    media,
    batch,
    controls,
    cotClient,
    callbackAuth,
    activePolicyFingerprints,
    lastRunModelByScope,
    scope,
    agentKind,
    mode,
  } = deps;
  if (batch.length === 0) return;
  const firstMsg = batch[0];
  const lastMsg = batch[batch.length - 1];
  if (!firstMsg || !lastMsg) return;

  const chatId = firstMsg.chatId;
  const threadId = firstMsg.threadId;

  const resourceItems = batch.flatMap((m) =>
    m.resources.map((r) => ({ messageId: m.messageId, resource: r })),
  );
  const attachments = await media.resolve(resourceItems, controls.profileConfig.attachments);
  if (attachments.length > 0) {
    log.info('media', 'resolved', { count: attachments.length });
    for (const attachment of attachments) {
      log.info('attachment', 'decision', {
        decision: attachment.decision,
        kind: attachment.kind,
        hash: attachment.hash,
        size: attachment.size,
        sourceMessageId: attachment.sourceMessageId,
        reason: attachment.rejectionReason,
      });
    }
  }

  // Collect any reply-quote targets in the batch. Dedup so the same target
  // quoted by multiple messages in one batch only fetches once. Filter out
  // ids that are themselves in the batch — those are already in the prompt.
  const batchIds = new Set(batch.map((m) => m.messageId));
  const quoteTargets = [
    ...new Set(
      batch
        .map((m) => replyQuoteTargetForMessage(m, mode))
        .filter((id): id is string => Boolean(id) && !batchIds.has(id!)),
    ),
  ];
  const quotes: QuotedContext[] = [];
  for (const targetId of quoteTargets) {
    const q = await fetchQuotedContext(channel, targetId);
    if (q) {
      quotes.push(q);
      log.info('quote', 'fetched', {
        messageId: targetId,
        type: q.rawContentType,
        contentChars: q.content.length,
      });
    }
  }

  // Topic upstream context. When the bot is pulled into a topic for the FIRST
  // time (no session yet for this scope), the topic's earlier messages — the
  // root question that may never have @-mentioned the bot, plus prior replies —
  // live nowhere the agent can see them. Fetch them so it isn't blind to what
  // the user is pointing at. An already-engaged topic keeps that history in its
  // resumed session, so we skip the fetch there.
  let topicContext: QuotedContext[] = [];
  if (mode === 'topic' && threadId && !sessions.getRaw(scope)) {
    const exclude = new Set([...batchIds, ...quoteTargets]);
    topicContext = await fetchTopicContext(channel, threadId, {
      maxMessages: 40,
      excludeIds: exclude,
    });
    topicContext = topicContext.filter(message => !controls.btw?.excludes(scope, message));
    if (topicContext.length > 0) {
      log.info('topic', 'context-fetched', {
        scope,
        threadId,
        count: topicContext.length,
      });
    }
  }

  // Detect a model switch since this scope's last run. When resuming an
  // existing conversation the transcript still claims the old model, so tell
  // the (now-switched) agent its model changed — otherwise it keeps echoing
  // the previously-announced model. Only fires when a prior model was seen
  // for this scope (never on the first run) and the selection actually
  // changed. `requestedModel` (the `--model` value, or undefined for default)
  // is reused below to log requested-vs-actual against the init event.
  const runModelSettings = await resolveRunModelSettings(controls, scope, undefined, agentKind);
  const runArguments = deps.timedJob?.modelSettings ?? modelRunArguments(runModelSettings);
  const modelPref = runArguments.model;
  const modelSelection = normalizeModelSelection(agentKind, modelPref);
  const requestedModel = resolveModelArg(agentKind, modelPref);
  const modelStateKey = `${agentKind}\x1f${scope}`;
  const prevModel = lastRunModelByScope.get(modelStateKey);
  const modelSwitched = prevModel !== undefined && prevModel !== modelSelection;
  lastRunModelByScope.set(modelStateKey, modelSelection);
  const extraInstructions = modelSwitched
    ? [
        `用户刚把本会话使用的模型切换为「${modelLabel(agentKind, modelPref)}」。` +
          '之前的对话里可能提到别的模型,请以当前模型为准;若被问到你用的是什么模型,据此回答。',
      ]
    : [];
  if (deps.timedJob) extraInstructions.push(deadlineInstructions(deps.timedJob.stopAt, deps.timedJob.windDownAt));

  const prompt = buildPrompt(
    batch,
    attachments,
    quotes,
    topicContext,
    channel.botIdentity,
    extraInstructions,
  );
  log.info('prompt', 'built', {
    promptChars: prompt.length,
    quotes: quotes.length,
    topicContext: topicContext.length,
    ...(modelSwitched ? { modelSwitchedTo: modelSelection } : {}),
  });

  // For topic groups: thread the reply so it lands in the same topic as the
  // user's message. Otherwise the SDK posts at top level and the user's
  // topic discussion breaks visually.
  const sendOpts = {
    replyTo: lastMsg.messageId,
    ...(mode === 'topic' && threadId ? { replyInThread: true } : {}),
  };
  log.info('flush', 'reply-target', {
    scope,
    mode,
    chatId,
    threadId,
    replyTo: sendOpts.replyTo,
    replyInThread: sendOpts.replyInThread === true,
  });

  const accessDecision =
    firstMsg.chatType === 'p2p'
      ? canUseDm(controls.profileConfig, controls, firstMsg.senderId)
      : canUseGroup(controls.profileConfig, controls, firstMsg.chatId, firstMsg.senderId);
  const scopeContext: ScopeContext = {
    source: 'im',
    chatId,
    actorId: firstMsg.senderId,
    ...(threadId ? { threadId } : {}),
  };
  const scopedProfile = profileForAgentKind(controls.profileConfig, agentKind);
  const capability = capabilityForProfile(scopedProfile);
  const flow = await startRunFlow({
    modelSettings: runArguments,
    deadlineAt: deps.timedJob?.stopAt,
    signal: deps.signal,
    scopeId: scope,
    scope: scopeContext,
    prompt,
    attachments: attachments.map(toPolicyAttachment),
    access: accessDecision,
    capability,
    profileConfig: controls.profileConfig,
    sessions,
    sessionCatalog,
    workspaces,
    executor,
    now: Date.now(),
    stopGraceMs: getAgentStopGraceMs(controls.cfg),
    observability: {
      profile: controls.profile,
      agent: capability.agentId,
      source: 'im',
      stage: 'submit',
    },
  });
  if (!flow.ok) {
    log.info('run-flow', 'rejected', { scope, code: flow.rejectReason.code });
    log.warn('policy', 'denied', {
      scope,
      source: 'im',
      code: flow.rejectReason.code,
    });
    await channel.send(chatId, { markdown: flow.rejectReason.userVisible }, sendOpts);
    if (deps.timedJob) await (await timedRuns(controls)).finish(deps.timedJob.id,
      flow.rejectReason.code === 'deadline-expired' ? 'expired' : flow.rejectReason.code === 'run-cancelled' ? 'stopped' : 'failed');
    return;
  }

  const { execution, cwdRealpath: cwd } = flow;
  let timedResult: Promise<void> | undefined;
  if (deps.timedJob) {
    const store = await timedRuns(controls);
    const job = deps.timedJob;
    timedResult = execution.result.then((state) => store.finish(job.id, state))
      .catch((err) => log.fail('timed-run', err, { jobId: job.id }));
    try {
      await store.transition(job.id, ['queued'], 'running');
    } catch {
      await execution.stop();
      await timedResult;
      return;
    }
  }
  activePolicyFingerprints.set(scope, flow.policy.policyFingerprint);
  const handle = execution.handle;
  if (flow.resumeFrom) {
    log.info('session', 'resume', { sessionId: flow.resumeFrom, cwd });
  } else {
    log.info('session', 'fresh', { cwd });
  }
  const recordSession = (evt: AgentEvent): void => {
    recordRunSessionEvent({
      scopeId: scope,
      sessions,
      sessionCatalog,
      capability,
      policy: flow.policy,
      event: evt,
    });
    if (evt.type === 'system' && evt.sessionId) {
      log.info('session', 'set', { sessionId: evt.sessionId });
    }
    // Ground truth for "which model is actually running": claude reports the
    // model it loaded in its init event. Logging requested-vs-actual reveals
    // whether the --model pin took effect or claude silently fell back (e.g.
    // an id this claude build/account doesn't recognize).
    if (evt.type === 'system' && evt.model) {
      log.info('session', 'model', {
        requested: requestedModel ?? 'default',
        actual: evt.model,
      });
    }
    if (evt.type === 'system' && evt.threadId) {
      log.info('session', 'set-thread', { threadId: evt.threadId });
    }
  };

  // Resolve idle-timeout for this run: scope override (on SessionEntry) wins
  // over global default (preferences). 0 / undefined = no watchdog.
  const scopeOverride = sessions.getIdleTimeoutMinutes(scope);
  const idleTimeoutMs =
    scopeOverride !== undefined
      ? scopeOverride > 0
        ? scopeOverride * 60_000
        : undefined
      : getRunIdleTimeoutMs(controls.cfg);
  if (idleTimeoutMs) {
    log.info('flush', 'idle-watchdog', { idleTimeoutMs });
  }

  const replyMode = getMessageReplyMode(controls.cfg);
  log.info('flush', 'reply-mode', { mode: replyMode });
  const cotMessages = getCotMessages(controls.cfg);

  const display = larkDisplay(controls.cfg);
  const filterForPrefs = (state: RunState): RunState => {
    if (display.show_tools) return state;
    return { ...state, blocks: state.blocks.filter((b) => b.kind !== 'tool') };
  };
  const cardRenderOptions = {
    fileLinks: display.file_links,
    ...(callbackAuth
      ? {
          signCallback: (action: string) =>
            callbackAuth.sign({
              runId: execution.runId,
              scope,
              chatId,
              operatorOpenId: firstMsg.senderId,
              action,
              policyFingerprint: flow.policy.policyFingerprint,
              ttlMs: 24 * 60 * 60 * 1000,
            }),
        }
      : {}),
  };

  const questionsDone = (async () => {
    for await (const event of execution.subscribe()) {
      if (event.type !== 'user_input') continue;
      try {
        await deps.userQuestions.publish(event, {
          runId: execution.runId,
          identity: { scopeId: scope, agentId: capability.agentId, cwdRealpath: cwd, policyFingerprint: flow.policy.policyFingerprint },
          message: firstMsg, replyTo: lastMsg.messageId,
          mentionUser: firstMsg.chatType !== 'p2p' && senderTypeOf(firstMsg) === 'user',
          allowQueue: !deps.timedJob, isCancelled: () => handle.interrupted || Boolean(deps.signal?.aborted),
        });
      } catch (err) { log.warn('question', 'delivery-failed', { scope, err: String(err) }); }
    }
  })();

  try {
    await presentRunOutput(execution, createLarkRunOutput({
      channel, chatId, replyMode, sendOpts, cardRenderOptions,
      cotMessages, cotClient, originMessageId: lastMsg.messageId, inputPreview: lastMsg.content,
    }), { idleTimeoutMs, recordSession, filterForPrefs });
  } catch (err) {
    log.fail('stream', err);
  } finally {
    activePolicyFingerprints.delete(scope);
    if (deps.timedJob) {
      // End the supervised process even when card delivery failed before the
      // renderer drained the stream. Never let a rendering error detach work.
      await execution.stop();
      await timedResult;
    }
    await questionsDone;
  }
}

function buildPrompt(
  batch: NormalizedMessage[],
  attachments: LocalAttachment[],
  quotes: QuotedContext[] = [],
  topicContext: QuotedContext[] = [],
  botIdentity?: { openId: string; name?: string },
  extraInstructions?: string[],
): string {
  const first = batch[0];
  if (!first) return '';

  const fileKeys = batch.flatMap((m) => m.resources.map((r) => r.fileKey));
  // When the debounce window merged messages (possibly from several senders —
  // common in bot-at-bot group chats), annotate each segment with its sender
  // so the agent can tell who said what. Single-message batches stay verbatim.
  const annotate = batch.length > 1;
  const texts = batch
    .map((m) => {
      const text = stripAttachmentRefs(m.content, fileKeys).trim();
      if (!text) return '';
      return annotate ? `${senderAnnotation(m)} ${text}` : text;
    })
    .filter(Boolean);
  const userPart =
    texts.length > 0
      ? texts.join('\n\n')
      : attachments.length > 0
        ? '请看下面的附件。'
        : '（对方发来一条没有正文的消息——通常是只 @ 了你的唤醒（ping）。请简短回应。）';

  const senderType = senderTypeOf(first);
  const mentions = mergeMentions(batch);

  return buildAgentPrompt({
    context: {
      chatId: first.chatId,
      chatType: first.chatType,
      senderId: first.senderId,
      ...(first.senderName ? { senderName: first.senderName } : {}),
      ...(senderType ? { senderType } : {}),
      ...(botIdentity?.openId ? { botOpenId: botIdentity.openId } : {}),
      ...(mentions.length > 0 ? { mentions } : {}),
      ...(first.threadId ? { threadId: first.threadId } : {}),
      messageIds: batch.map((m) => m.messageId),
      source: 'im',
    },
    instructions:
      extraInstructions && extraInstructions.length > 0
        ? [...BRIDGE_AGENT_INSTRUCTIONS, ...extraInstructions]
        : BRIDGE_AGENT_INSTRUCTIONS,
    userInput: userPart,
    ...(topicContext.length > 0 ? { topicContext: topicContext.map(toPromptTopicMessage) } : {}),
    quotedMessages: quotes.map(toPromptQuote),
    interactiveCards: batch.map(toPromptInteractiveCard).filter(isDefined),
    attachments: attachments.map(toPromptAttachment),
  });
}

/**
 * Classify the sender as human or bot from the raw Feishu event
 * (`sender.sender_type`: 'user' = human, 'app' = bot). The normalizer drops
 * this field, so read it off `msg.raw` (`includeRawEvent: true` above).
 * Unknown / missing values return undefined — omit rather than guess.
 */
function senderTypeOf(msg: NormalizedMessage): 'user' | 'bot' | undefined {
  const raw = msg.raw as { sender?: { sender_type?: unknown } } | undefined;
  const senderType = raw?.sender?.sender_type;
  if (senderType === 'user') return 'user';
  if (senderType === 'app' || senderType === 'bot') return 'bot';
  return undefined;
}

function senderAnnotation(msg: NormalizedMessage): string {
  const name = msg.senderName ?? msg.senderId;
  const type = senderTypeOf(msg);
  return type ? `[${name} (${type})]:` : `[${name}]:`;
}

function mergeMentions(batch: NormalizedMessage[]): BridgePromptMention[] {
  const seen = new Set<string>();
  const out: BridgePromptMention[] = [];
  for (const msg of batch) {
    for (const mention of msg.mentions ?? []) {
      const dedupeKey = mention.openId ?? `${mention.name ?? ''}:${mention.key}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      out.push({
        ...(mention.openId ? { openId: mention.openId } : {}),
        ...(mention.name ? { name: mention.name } : {}),
        ...(mention.isBot !== undefined ? { isBot: mention.isBot } : {}),
      });
    }
  }
  return out;
}

function replyQuoteTargetForMessage(
  msg: NormalizedMessage,
  mode: ChatMode,
): string | undefined {
  const replyTo = msg.replyToMessageId;
  if (!replyTo) return undefined;

  // Feishu topic messages use root_id/parent_id as the topic root anchor even
  // for ordinary in-topic messages. Treat that as structure, not a quote.
  if (mode === 'topic' && msg.threadId && msg.rootId && replyTo === msg.rootId) {
    return undefined;
  }
  return replyTo;
}

function stripAttachmentRefs(text: string, fileKeys: string[]): string {
  if (!text || fileKeys.length === 0) return text;
  let out = text;
  for (const key of fileKeys) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`!?\\[[^\\]]*\\]\\(${escaped}\\)`, 'g'), '');
    out = out.replace(
      new RegExp(
        `<\\s*(?:file|image|img|audio|video|media|folder)\\b[^>]*\\bkey\\s*=\\s*["']${escaped}["'][^>]*>`,
        'gi',
      ),
      '',
    );
  }
  return out.replace(/\n{3,}/g, '\n\n');
}

function toPromptQuote(q: QuotedContext): BridgePromptQuotedMessage {
  return {
    messageId: q.messageId,
    senderId: q.senderId,
    ...(q.senderName ? { senderName: q.senderName } : {}),
    ...(q.createdAt ? { createdAt: q.createdAt } : {}),
    rawContentType: q.rawContentType,
    content: q.content,
  };
}

function toPromptTopicMessage(q: QuotedContext): BridgePromptTopicMessage {
  return {
    messageId: q.messageId,
    senderId: q.senderId,
    ...(q.senderName ? { senderName: q.senderName } : {}),
    ...(q.senderType ? { senderType: q.senderType } : {}),
    ...(q.createdAt ? { createdAt: q.createdAt } : {}),
    rawContentType: q.rawContentType,
    content: q.content,
  };
}

function toPromptInteractiveCard(m: NormalizedMessage): BridgePromptInteractiveCard | undefined {
  if (m.rawContentType !== 'interactive') return undefined;
  const rawContent = (m.raw as { message?: { content?: unknown } } | undefined)
    ?.message?.content;
  if (typeof rawContent !== 'string' || rawContent.length === 0) return undefined;
  return {
    messageId: m.messageId,
    content: parseJsonOrRaw(rawContent),
  };
}

function parseJsonOrRaw(input: string): unknown {
  try {
    return JSON.parse(input) as unknown;
  } catch {
    return input;
  }
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}
