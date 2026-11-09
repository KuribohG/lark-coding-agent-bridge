import type { LarkChannel } from '@larksuite/channel';
import { dirname, join } from 'node:path';
import { CallbackAuth } from '../../card/callback-auth';
import { CallbackNonceStore } from '../../card/callback-store';
import type { ChannelControls, Controls } from '../../commands';
import type { AppPaths } from '../../config/app-paths';
import type { AgentKind } from '../../config/profile-schema';
import type { AppConfig } from '../../config/schema';
import { getMaxConcurrentRuns, getMessageDebounceMs } from '../../config/schema';
import { log, withTrace } from '../../core/logger';
import { LarkProfileAuth } from '../../lark-auth/profile-auth';
import { MediaCache } from '../../media/cache';
import { createOwnerRefreshController } from '../../policy/owner';
import { ActiveRuns } from '../../runtime/active-runs';
import type { RuntimeActivity } from '../../runtime/activity';
import type { ExecutionController } from '../../runtime/execution-controller';
import { ProcessPool } from '../../runtime/process-pool';
import { RunExecutor, type RunExecution } from '../../runtime/run-executor';
import { timedRuns } from '../../runtime/timed-runs';
import { BtwStore } from '../../session/btw-store';
import type { SessionCatalog } from '../../session/catalog';
import type { SessionStore } from '../../session/store';
import type { WorkspaceStore } from '../../workspace/store';
import { BtwManager } from './btw';
import { handleCardAction } from './card-actions';
import { ChatModeCache } from './chat-mode-cache';
import { handleCommentMention } from './comments';
import { connectionLogHandlers } from './connection-log';
import { CotClient, type CotPublisher } from './cot';
import { FollowupRouter } from './followup';
import { intakeMessage } from './intake';
import { startKeepalive } from './keepalive';
import { startKnownChatsRefresh } from './lark-info';
import { LarkMeetingHost } from './meeting-host';
import { PendingQueue, type PendingMessage } from './pending-queue';
import { UserQuestions } from './question-cards';
import { runAgentBatch, type LarkRunServices } from './run';
import { ScopeRunMemory } from './scope-run-memory';
import { createProfileChannel } from './sdk';
import { LarkTurnRunner, type TurnDispatchOptions } from './turn-runner';
import { LarkTurns } from './turns';
import { LarkWorkflowHost } from './workflow-host';

export interface BridgeChannel {
  channel: LarkChannel;
  disconnect(): Promise<void>;
  /** Optional so test doubles and older channel shims need not report it. */
  activity?(): RuntimeActivity;
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
  const stateDir = deps.appPaths?.mediaDir ? dirname(deps.appPaths.mediaDir) : undefined;
  const statePath = (name: string) => stateDir ? join(stateDir, name) : undefined;
  const resolveAgent = (scope: string, agentKind?: AgentKind) => execution.get(scope, agentKind);
  const resolveAgentKind = (scope: string) => execution.kindFor(scope);
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
  const callbackNonceStore = stateDir ? new CallbackNonceStore(statePath('callback-nonces.json')!) : undefined;
  await callbackNonceStore?.load();
  const callbackAuth = callbackNonceStore
    ? new CallbackAuth({
        keys: await larkAuth.callbackKeys(),
        nonceStore: callbackNonceStore,
      })
    : undefined;
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

  const btwStore = new BtwStore(statePath('btw.json'));
  await btwStore.load();
  const btw = new BtwManager(btwStore);

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
      void turn.run(signal => runner.runConversationTurn(scope, batch, signal, { preparedCot }))
        .catch(err => log.fail('flush', err));
    },
    statePath('pending-queue.json'),
  );
  const turns = new LarkTurns(pending, activeRuns);
  if (deps.restorePending === false) {
    pending.suspend();
    pending.holdPersistence();
  }
  await pending.load();

  const userQuestions = new UserQuestions({ channel, auth: callbackAuth, activeRuns, followups,
    pending, catalog: sessionCatalog, isTimed: scope => Boolean(controls.channel?.activeTimedRun(scope)) });

  const runServices: LarkRunServices = { ...conversation, media, cotClient, callbackAuth, userQuestions,
    memory: new ScopeRunMemory() };
  const dispatch = async (scope: string, batch: PendingMessage[], options: TurnDispatchOptions): Promise<RunExecution | undefined> => {
    const first = batch[0];
    if (!first) return undefined;
    const mode = first.threadId ? 'topic' : await chatModeCache.resolve(channel, first.chatId);
    const agentKind = options.timedJob?.agentKind ?? resolveAgentKind(scope);
    const agent = resolveAgent(scope, agentKind);
    return runAgentBatch(runServices, {
      ...(options.timedJob ? {} : { workflows: workflows.current, workflowOrigins: workflows.origins }),
      scope, batch, mode, agentKind, agent, ...options });
  };
  const workflows: LarkWorkflowHost = new LarkWorkflowHost({ channel, executor, controls, sessions, sessionCatalog, workspaces,
    stateDir, turns, pending, resolveAgentKind, dispatch });
  const runner = new LarkTurnRunner({ channel, turns, timedStore: await timedRuns(controls), stateDir,
    resolveAgentKind, dispatch });
  // Created before connect() so the `vc.bot.*` handlers are installed on the
  // event dispatcher before any push can arrive.
  const meetings = new LarkMeetingHost({ channel, controls, resolveAgentKind,
    conversation: { executor, activeRuns, sessions, sessionCatalog, workspaces } });

  const channelControls: ChannelControls = {
    workflow: () => workflows.control(),
    btw,
    cancelPendingInput: (scope) => {
      turns.cancel(scope);
      const preparedCot = preparedCots.get(scope);
      preparedCots.delete(scope);
      void preparedCot?.finish('cancelled');
      return pending.cancel(scope).length;
    },
    flushPendingInput: () => pending.flushPersistence(),
    pausePendingInput: () => pending.suspend(),
    resumePendingInput: () => pending.resume(),
    detachPendingInput: () => pending.detach(),
    reloadPendingInput: async () => { await pending.reload(); await workflows.start(); await runner.resumeInterrupted(); },
    launchTimedRun: (job, message) => runner.launchTimedRun(job, message),
    cancelTimedRun: (scope, id) => runner.cancelTimedRun(scope, id),
    activeTimedRun: scope => runner.activeTimedRun(scope),
    meeting: () => meetings.current(),
    reconcileMeeting: () => meetings.reconcile(),
    onConfigApplied: () => pool.refresh(),
  };
  controls.channel = channelControls;

  channel.on({
    message: async (msg) => {
      await withTrace({ chatId: msg.chatId, msgId: msg.messageId }, () =>
        intakeMessage({
          followups,
          recordFollowup: (scope, message) => runner.recordFollowup(scope, message),
          userQuestions,
          ...conversation,
          resolveAgent,
          resolveAgentKind,
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
          processPool: pool,
          runExecutor: executor,
          pending,
          chatModeCache,
          callbackAuth,
          userQuestions,
          callbackPolicyFingerprintForScope: (scope) => runServices.memory.policyFingerprint(scope),
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
    ...connectionLogHandlers(),
  });

  await meetings.reconcile();
  await channel.connect();
  const ownerRefresh = createOwnerRefreshController({
    controls,
    source: channel,
    appId: cfg.accounts.app.id,
  });
  await ownerRefresh.start();
  const knownChatsRefresh = startKnownChatsRefresh(channel, chats => { controls.knownChats = chats; });

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
  if (deps.restorePending !== false) { await workflows.start(); await runner.resumeInterrupted(); pending.resume(); }
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
    // Recovery reconnects with the running config; file edits apply via reload.
    forceReconnect: () => controls.restart({ config: 'running' }),
  });

  return {
    channel,
    activity: () => {
      const workflow = workflows.activity();
      return {
        runs: activeRuns.snapshot().length,
        turns: turns.activeCount(),
        queuedMessages: pending.queuedMessageCount(),
        sideQuestions: btw.activeCount(),
        workflowScripts: workflow.scripts,
        workflowTasks: workflow.tasks,
        newRunsPaused: activeRuns.newRunsPaused(),
      };
    },
    disconnect: async () => {
      activeRuns.pauseNewRuns('bridge-disconnect');
      if (controls.channel === channelControls) controls.channel = undefined;
      const workflowsClosed = workflows.close();
      turns.close();
      const btwClosed = btw.close();
      ownerRefresh.stop();
      knownChatsRefresh.stop();
      keepalive.stop();
      // Stop meeting timers but stay in the meetings: /reconnect tears the
      // channel down and rebuilds it, and auto-leaving every meeting on a
      // reconnect would be surprising.
      meetings.dispose();
      for (const preparedCot of preparedCots.values()) {
        void preparedCot.finish('cancelled');
      }
      preparedCots.clear();
      userQuestions.close();
      const turnsSettled = settleWithin(turns.settled(), TURN_SETTLE_TIMEOUT_MS).then(() => runner.closeJournal());
      const flushes: Array<[string, Promise<unknown> | undefined]> = [
        ['pending', pending.flushPersistence()],
        ['sessions', sessions.flush()],
        ['session-catalog', sessionCatalog?.flush()],
        ['callback-nonces', callbackNonceStore?.flush()],
        ['workspaces', workspaces.flush()],
        ['btw', btwClosed],
        ['workflow-progress-cards', workflowsClosed.progressCards],
        ['workflows', workflowsClosed.runtime],
        ['turns', turnsSettled],
      ];
      const [disconnectResult, stopAllResult, ...flushResults] = await Promise.allSettled([
        channel.disconnect(),
        activeRuns.stopAll('shutdown'),
        ...flushes.map(([, work]) => work),
      ]);
      if (stopAllResult.status === 'rejected') {
        log.fail('disconnect', stopAllResult.reason, { step: 'stopAll' });
      }
      for (const [idx, result] of flushResults.entries()) {
        if (result.status === 'rejected') {
          log.fail('disconnect', result.reason, { step: `flush-${flushes[idx]![0]}` });
        }
      }
      if (!deps.larkAuth) await larkAuth.close();
      if (disconnectResult.status === 'rejected') {
        throw disconnectResult.reason;
      }
    },
  };
}

/** Shutdown waits this long for stopped turns to record whether they must be replayed. */
const TURN_SETTLE_TIMEOUT_MS = 10_000;

function settleWithin(work: Promise<void>, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}
