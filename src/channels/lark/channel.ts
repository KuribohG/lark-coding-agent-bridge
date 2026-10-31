import type { LarkChannel, NormalizedMessage } from '@larksuite/channel';
import { dirname, join } from 'node:path';
import { capabilityForProfile } from '../../agent/backends';
import { modelRunArguments } from '../../agent/model-settings';
import { BtwManager } from '../../bot/btw';
import { ChatModeCache } from '../../bot/chat-mode-cache';
import { handleCommentMention } from '../../bot/comments';
import { CotClient, CotPublisher } from '../../bot/cot';
import { FollowupRouter } from '../../bot/followup';
import { startKeepalive } from '../../bot/keepalive';
import { fetchKnownChats } from '../../bot/lark-info';
import { PendingQueue, type PendingMessage } from '../../bot/pending-queue';
import { UserQuestions } from '../../bot/user-questions';
import { CallbackAuth } from '../../card/callback-auth';
import { CallbackNonceStore } from '../../card/callback-store';
import { handleCardAction } from '../../card/dispatcher';
import { sendManagedCard } from '../../card/managed';
import { timedRunCard } from '../../card/timed-run-card';
import type { Controls } from '../../commands';
import type { AppPaths } from '../../config/app-paths';
import type { AgentKind } from '../../config/profile-schema';
import type { AppConfig } from '../../config/schema';
import {
  getMaxConcurrentRuns,
  getMessageDebounceMs,
  getWorkflowTimeoutMinutes,
} from '../../config/schema';
import { log, reportMetric, withTrace } from '../../core/logger';
import { LarkProfileAuth } from '../../lark-auth/profile-auth';
import { MediaCache } from '../../media/cache';
import type { VcRequestClient } from '../../meeting/api';
import { MeetingManager } from '../../meeting/manager';
import { attachMeetingAgent, summarizeEndedMeeting } from '../../meeting/orchestrator';
import { canUseDm, canUseGroup } from '../../policy/access';
import { createOwnerRefreshController } from '../../policy/owner';
import { ActiveRuns } from '../../runtime/active-runs';
import type { ExecutionController } from '../../runtime/execution-controller';
import { profileForAgentKind } from '../../runtime/execution-controller';
import { resolveRunModelSettings } from '../../runtime/model-settings';
import { ProcessPool } from '../../runtime/process-pool';
import { RunExecutor } from '../../runtime/run-executor';
import { resolveRunFlowContext } from '../../runtime/run-flow';
import { timedRuns } from '../../runtime/timed-runs';
import { BtwStore } from '../../session/btw-store';
import type { SessionCatalog } from '../../session/catalog';
import type { SessionStore } from '../../session/store';
import { handleWorkflowCommand } from '../../workflows/commands';
import { workflowDigest } from '../../workflows/digest';
import { resolveWorkerExecution } from '../../workflows/execution';
import { WorkflowRuntime } from '../../workflows/runtime';
import type { WorkspaceStore } from '../../workspace/store';

import { intakeMessage } from './intake';
import { runAgentBatch, type RunBatchDeps } from './run';
import { createProfileChannel } from './sdk';
import { LarkTurns } from './turns';

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
  larkAuth?: LarkProfileAuth;
  /** Connect-before-disconnect restarts suppress restore until the old channel stops. */
  restorePending?: boolean;
}

export async function startLarkChannel(deps: StartChannelDeps): Promise<BridgeChannel> {
  const { cfg, execution, sessions, sessionCatalog, workspaces, controls } = deps;
  const resolveAgent = (scope: string, agentKind?: AgentKind) => execution.get(scope, agentKind);
  const resolveAgentKind = (scope: string) => execution.kindFor(scope);
  const setAgentKind = (scope: string, kind: AgentKind) => execution.setScopeKind(scope, kind);
  const activeRuns = new ActiveRuns();
  const followups = new FollowupRouter();
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
  const larkAuth = deps.larkAuth ?? new LarkProfileAuth(cfg, deps.appPaths);
  controls.larkAuth = larkAuth;
  const { appSecret } = await larkAuth.credentials();
  const callbackNonceStore = deps.appPaths?.mediaDir
    ? new CallbackNonceStore(join(dirname(deps.appPaths.mediaDir), 'callback-nonces.json'))
    : undefined;
  await callbackNonceStore?.load();
  const callbackAuth = callbackNonceStore
    ? new CallbackAuth({
        keys: await larkAuth.callbackKeys(),
        nonceStore: callbackNonceStore,
      })
    : undefined;
  const activePolicyFingerprints = new Map<string, string>();
  // Per-scope record of the model used on the last run, so a `/config` model
  // switch can inject a one-time "model changed" note into the next (resumed)
  // prompt. In-memory only: on restart the first run re-seeds silently.
  const lastRunModelByScope = new Map<string, string>();
  const tenantTokens = await larkAuth.tenantTokens();
  const cotClient = new CotClient({
    tenant: cfg.accounts.app.tenant,
    appId: cfg.accounts.app.id,
    appSecret,
    tenantTokens,
    request: larkAuth.request,
  });
  const preparedCots = new Map<string, CotPublisher>();
  const channel = createProfileChannel(cfg, larkAuth, appSecret);
  const media = new MediaCache(channel, deps.appPaths?.mediaDir);
  const conversation = { channel, controls, executor, activeRuns, sessions, sessionCatalog, workspaces };

  const workflowOrigins = new Map<string, NormalizedMessage>();
  let workflows: WorkflowRuntime | undefined;
  const createWorkflows = () => sessionCatalog && deps.appPaths?.mediaDir ? new WorkflowRuntime({
    path: join(dirname(deps.appPaths.mediaDir), 'workflows.sqlite'), executor,
    getTimeoutMinutes: root => getWorkflowTimeoutMinutes(profileForAgentKind(controls.profileConfig, root.agentKind)),
    showPlan: async (state, text) => {
      const message = workflowOrigins.get(state.root.scopeId);
      if (!message) throw new Error('Workflow reply destination unavailable');
      const receipt = await channel.send(message.chatId, { markdown: text }, { replyTo: message.messageId, replyInThread: Boolean(message.threadId) });
      if (!receipt.messageId?.trim()) throw new Error('Workflow plan delivery returned no message receipt');
    },
    resolveWorker: async (root, selection, policy) => {
      const { agentKind, ...overrides } = selection;
      const profile = profileForAgentKind(controls.profileConfig, agentKind);
      const settings = agentKind === root.agentKind ? { ...root.modelSettings, ...overrides }
        : await resolveRunModelSettings(controls, root.scopeId, overrides, agentKind);
      return resolveWorkerExecution(root, profile, policy,
        { model: settings.model, reasoningEffort: settings.reasoningEffort });
    },
    resolve: async scope => {
      const message = workflowOrigins.get(scope);
      if (!message) return undefined;
      const agentKind = resolveAgentKind(scope);
      const profileConfig = profileForAgentKind(controls.profileConfig, agentKind);
      const capability = capabilityForProfile(profileConfig);
      const context = await resolveRunFlowContext({ scopeId: scope,
        scope: { source: 'im', chatId: message.chatId, actorId: message.senderId, ...(message.threadId ? { threadId: message.threadId } : {}) },
        prompt: '', attachments: [],
        access: message.chatType === 'p2p' ? canUseDm(profileConfig, controls, message.senderId)
          : canUseGroup(profileConfig, controls, message.chatId, message.senderId),
        capability, profileConfig, sessions, sessionCatalog, workspaces, now: Date.now(),
      });
      if (!context.ok || !context.resumeFrom) return undefined;
      const modelSettings = modelRunArguments(await resolveRunModelSettings(controls, scope, undefined, agentKind));
      return { policy: context.policy, root: { scopeId: scope, profile: controls.profile, agentKind,
        cwdRealpath: context.workspace.cwdRealpath, policyFingerprint: context.policy.policyFingerprint,
        catalogBinding: workflowDigest({ nativeId: context.resumeFrom, agentKind }), modelSettings } };
    },
    wakeMain: async scope => {
      const message = workflowOrigins.get(scope);
      if (!message || !turns.isIdle(scope)) return;
      const turn = turns.claim(scope);
      const eventIds = workflows?.kernel.state(scope)?.events.filter(event => !event.acknowledged).map(event => event.id) ?? [];
      try {
        await turn.run(signal => dispatch(scope, [message], { signal, entry: { kind: 'workflow', trigger: 'event' } }));
      } catch (error) {
        // Failed automatic wakes remain visible through /workflow status, without a retry loop.
        workflows?.kernel.markNotified(scope, eventIds);
        throw error;
      }
    },
  }) : undefined;

  const btwStore = new BtwStore(deps.appPaths?.mediaDir
    ? join(dirname(deps.appPaths.mediaDir), 'btw.json') : undefined);
  await btwStore.load();
  const btw = new BtwManager(btwStore);
  controls.btw = btw;

  // Pending → run handoff: while a run is active on a chat, block its pending
  // queue so messages keep accumulating without flushing. When the run ends,
  // unblock arms a fresh quiet-window timer. Net effect: at most one run per
  // chat in flight, and everything sent during a run merges into the next
  // batch (only flushed once the configured quiet window has passed *after the run*).
  const pending = new PendingQueue(
    () => getMessageDebounceMs(controls.cfg),
    (scope, batch) => {
      const firstMsg = batch[0];
      if (!firstMsg) return;
      const preparedCot = preparedCots.get(scope);
      preparedCots.delete(scope);
      const turn = turns.claim(scope);
      void turn.run(signal => withTrace({ chatId: firstMsg.chatId }, async () => {
        log.info('flush', 'start', {
          scope,
          batchSize: batch.length,
          chatId: firstMsg.chatId,
          threadId: firstMsg.threadId,
          msgId: firstMsg.messageId,
        });
        try {
          await dispatch(scope, batch, { signal, entry: firstMsg.agentEntry ?? { kind: 'direct' }, preparedCot });
        } catch (err) {
          await preparedCot?.finish('error');
          log.fail('flush', err);
        } finally {
          log.info('flush', 'end');
        }
      })).catch(err => log.fail('flush', err));
    },
    deps.appPaths?.mediaDir
      ? join(dirname(deps.appPaths.mediaDir), 'pending-queue.json')
      : undefined,
  );
  const turns = new LarkTurns(pending, activeRuns);
  if (deps.restorePending === false) {
    pending.suspend();
    pending.holdPersistence();
  }
  await pending.load();

  const userQuestions = new UserQuestions({ channel, auth: callbackAuth, activeRuns, followups,
    pending, catalog: sessionCatalog, isTimed: scope => Boolean(controls.activeTimedRun?.(scope)) });

  const dispatch = async (scope: string, batch: PendingMessage[],
    options: Pick<RunBatchDeps, 'signal' | 'entry' | 'timedJob' | 'preparedCot'>) => {
    const first = batch[0];
    if (!first) return;
    const mode = first.threadId ? 'topic' : await chatModeCache.resolve(channel, first.chatId);
    await runAgentBatch({ ...conversation, media, cotClient, callbackAuth, userQuestions, activePolicyFingerprints, lastRunModelByScope,
      ...(options.timedJob ? {} : { workflows, workflowOrigins }), scope, batch, mode, agentKind: options.timedJob?.agentKind ?? resolveAgentKind(scope), ...options });
  };

  const startWorkflows = async () => {
    if (workflows) return;
    workflows = createWorkflows();
    if (!workflows) return;
    const runtime = workflows;
    await runtime.start();
    controls.workflow = {
      cancel: scope => runtime.kernel.cancel(scope),
      invalidate: scope => runtime.kernel.invalidate(scope),
      command: (scope, args, message) => handleWorkflowCommand(runtime.kernel, scope, args, content => {
        if (controls.activeTimedRun?.(scope)) return '请先结束当前限时任务。';
        const queued = pending.push(scope, { ...message, content, agentEntry: { kind: 'workflow', trigger: 'command' } });
        if (queued === undefined) return '消息队列已满，请稍后重试。';
        workflowOrigins.set(scope, message);
        return undefined;
      }),
    };
  };

  controls.cancelPendingInput = (scope) => {
    turns.cancel(scope);
    const preparedCot = preparedCots.get(scope);
    preparedCots.delete(scope);
    void preparedCot?.finish('cancelled');
    return pending.cancel(scope).length;
  };
  controls.flushPendingInput = () => pending.flushPersistence();
  controls.pausePendingInput = () => pending.suspend();
  controls.resumePendingInput = () => pending.resume();
  controls.detachPendingInput = () => pending.detach();
  controls.reloadPendingInput = async () => { await pending.reload(); await startWorkflows(); };

  const timedStore = await timedRuns(controls);
  controls.activeTimedRun = scope => turns.timedRunId(scope);
  controls.cancelTimedRun = (scope, id) => { if (turns.timedRunId(scope)) turns.cancel(scope, id); };
  controls.launchTimedRun = async (job, message) => {
    if (!turns.isIdle(job.scope)) {
      throw new Error('当前话题/聊天仍有任务或待处理消息，请完成或 /stop 后再启动限时任务。');
    }
    const turn = turns.claim(job.scope, job.id);
    try {
      await timedStore.transition(job.id, ['draft'], 'queued');
    } catch (err) {
      turn.release();
      throw err;
    }
    const sendOpts = { replyTo: message.messageId, ...(message.threadId ? { replyInThread: true } : {}) };
    void turn.run(signal => withTrace({ chatId: message.chatId }, async () => {
      try {
        await sendManagedCard(channel, message.chatId, timedRunCard(timedStore.get(job.id)!), sendOpts);
        await dispatch(job.scope, [{ ...message, content: job.task, resources: [], rawContentType: 'text' }], { timedJob: job, signal });
      } catch (err) {
        log.fail('timed-run', err, { jobId: job.id });
      } finally {
        // A failure before executor submission must also close the one-shot job.
        await timedStore.finish(job.id, signal.aborted ? 'stopped' : Date.now() >= job.stopAt ? 'expired' : 'failed');
      }
    })).then(() => sendManagedCard(channel, message.chatId, timedRunCard(timedStore.get(job.id)!), sendOpts)
      .catch(err => log.warn('timed-run', 'status-send-failed', { err: String(err) })))
      .catch(err => log.fail('timed-run', err, { jobId: job.id }));
  };

  // Counter for stdout reconnect escalation; reset on `reconnected`.
  let consecutiveReconnects = 0;

  channel.on({
    message: async (msg) => {
      await withTrace({ chatId: msg.chatId, msgId: msg.messageId }, () =>
        intakeMessage({
          followups,
          ...conversation,
          resolveAgent,
          resolveAgentKind,
          setAgentKind,
          pending,
          msg,
          chatModeCache,
          pool,
          cotClient,
          preparedCots,
        }),
      ).catch((err) => log.fail('intake', err));
    },
    reject: (evt) => {
      log.info('intake', 'reject', { chatId: evt.chatId, reason: evt.reason });
    },
    cardAction: async (evt) => {
      return withTrace({ chatId: evt.chatId, msgId: evt.messageId }, async () => {
        return handleCardAction({
          ...conversation,
          evt,
          resolveAgent,
          resolveAgentKind,
          setAgentKind,
          processPool: pool,
          runExecutor: executor,
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
          ...conversation,
          evt,
          resolveAgent,
          resolveAgentKind,
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
          ...conversation,
          resolveAgentKind,
        }).catch((err) => log.warn('meeting', 'summary-failed', { err: String(err) })),
      onSession: (session) =>
        attachMeetingAgent({
          session,
          ...conversation,
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
  if (deps.restorePending !== false) { await startWorkflows(); pending.resume(); }
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
    request: larkAuth.request,
    forceReconnect: () => controls.restart(),
  });

  return {
    channel,
    disconnect: async () => {
      activeRuns.pauseNewRuns('bridge-disconnect');
      controls.workflow = undefined;
      const workflowsClosed = workflows?.close();
      turns.close();
      controls.btw = undefined;
      const btwClosed = btw.close();
      controls.launchTimedRun = undefined;
      ownerRefresh.stop();
      knownChatsRefresh.stop();
      keepalive.stop();
      // Stop meeting timers but stay in the meetings: /reconnect tears the
      // channel down and rebuilds it, and auto-leaving every meeting on a
      // reconnect would be surprising.
      meetingManager?.dispose();
      controls.meeting = undefined;
      for (const preparedCot of preparedCots.values()) {
        void preparedCot.finish('cancelled');
      }
      preparedCots.clear();
      userQuestions.close();
      const [disconnectResult, stopAllResult, ...flushResults] = await Promise.allSettled([
        channel.disconnect(),
        activeRuns.stopAll('shutdown'),
        pending.flushPersistence(),
        sessions.flush(),
        sessionCatalog?.flush(),
        callbackNonceStore?.flush(),
        workspaces.flush(),
        btwClosed,
        workflowsClosed,
      ]);
      if (stopAllResult.status === 'rejected') {
        log.fail('disconnect', stopAllResult.reason, { step: 'stopAll' });
      }
      for (const [idx, result] of flushResults.entries()) {
        if (result.status === 'rejected') {
          log.fail('disconnect', result.reason, { step: `flush-${idx}` });
        }
      }
      if (!deps.larkAuth) await larkAuth.close();
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
