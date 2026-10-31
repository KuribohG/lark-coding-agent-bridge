import type { LarkChannel, NormalizedMessage } from '@larksuite/channel';
import { supportsRunInput } from '../../agent/execution';
import type { AgentAdapter } from '../../agent/types';
import type { ChatModeCache } from '../../bot/chat-mode-cache';
import { CotPublisher, type CotClient } from '../../bot/cot';
import type { FollowupRouter } from '../../bot/followup';
import { MAX_PENDING_CHARS_PER_SCOPE, type PendingQueue } from '../../bot/pending-queue';
import { fetchQuotedContext } from '../../bot/quote';
import { commandSessionCatalogIdentity } from '../../bot/session-catalog-identity';
import { tryHandleCommand, type Controls } from '../../commands';
import { findCommand } from '../../commands/catalog';
import type { AgentKind } from '../../config/profile-schema';
import {
  getCotMessages,
  getMessageDebounceMs,
} from '../../config/schema';
import { log } from '../../core/logger';
import { canUseDm, canUseGroup, requireMentionForChat } from '../../policy/access';
import type { ActiveRuns } from '../../runtime/active-runs';
import type { ProcessPool } from '../../runtime/process-pool';
import type { RunExecutor } from '../../runtime/run-executor';
import type { SessionCatalog } from '../../session/catalog';
import type { SessionStore } from '../../session/store';
import type { WorkspaceStore } from '../../workspace/store';

import { buildPrompt, replyQuoteTargetForMessage } from './prompt';

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
  executor: RunExecutor;
  pool: ProcessPool;
  cotClient: CotClient;
  preparedCots: Map<string, CotPublisher>;
}

export async function intakeMessage(deps: IntakeDeps): Promise<void> {
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
    executor,
    pool,
    cotClient,
    preparedCots,
  } = deps;
  const preview = msg.content.length > 80 ? `${msg.content.slice(0, 80)}…` : msg.content;
  const { scope, threadId, mode: chatMode } = await chatModeCache.resolveScope(channel, msg);
  const emsg: NormalizedMessage = threadId === msg.threadId ? msg : { ...msg, threadId };
  if (emsg.content.length > MAX_PENDING_CHARS_PER_SCOPE) {
    log.warn('intake', 'message-too-large', {
      scope,
      msgId: emsg.messageId,
      chars: emsg.content.length,
    });
    await channel.send(emsg.chatId, {
      markdown: `这条消息正文过长（${emsg.content.length} 字符），超过单条约 200k 字符的安全上限，未提交给 Agent。请拆分后重试。`,
    }, {
      replyTo: emsg.messageId,
      ...(chatMode === 'topic' ? { replyInThread: true } : {}),
    });
    return;
  }
  log.info('intake', 'enter', {
    scope,
    chatType: msg.chatType,
    chatMode,
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
    const definition = controls.commands?.find(name ?? '') ?? findCommand(name ?? '');
    const dropped = definition?.pending === 'preserve' ? [] : pending.cancel(scope);
    if (dropped.length > 0) {
      const preparedCot = preparedCots.get(scope);
      preparedCots.delete(scope);
      void preparedCot?.finish('cancelled');
      await pending.flushPersistence();
    }
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
          [
            '这是用户在当前任务执行期间发来的补充消息。请结合原任务处理；消息未明确取消原目标时继续保留原目标。',
            ...(target && !quote
              ? ['用户引用的消息未能从飞书读取；不要猜测其内容，如上下文不足请明确说明。']
              : []),
          ]);
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
  let preparedCot = preparedCots.get(scope);
  if (!wasBusy && getCotMessages(controls.cfg) !== 'off') {
    if (!preparedCot) {
      preparedCot = new CotPublisher({
        client: cotClient,
        chatId: emsg.chatId,
        originMessageId: emsg.messageId,
      });
      preparedCots.set(scope, preparedCot);
      // The native COT bubble is the first visible acknowledgement. Start it
      // as soon as the message passes access/mention/command gates, in
      // parallel with the debounce and agent preparation rather than after
      // the run has already been submitted.
      void preparedCot.prepare();
    }
  }
  const size = pending.push(scope, emsg);
  if (size === undefined) {
    if (preparedCot) {
      preparedCots.delete(scope);
      void preparedCot.finish('cancelled');
    }
    await channel.send(emsg.chatId, {
      markdown: '当前话题的待处理队列已满，这条消息没有入队。请等待现有任务结束，或发送 /stop 清空后重试。',
    }, {
      replyTo: emsg.messageId,
      ...(chatMode === 'topic' ? { replyInThread: true } : {}),
    });
    return;
  }
  if (wasBusy) {
    await pending.flushPersistence();
    await channel.send(emsg.chatId, { markdown: '已排队，将在当前任务结束后处理；/stop 会同时取消排队消息。' }, {
      replyTo: emsg.messageId, ...(chatMode === 'topic' ? { replyInThread: true } : {}),
    });
  }
  log.info('intake', 'queued', {
    scope,
    queueSize: size,
    debounceMs: getMessageDebounceMs(controls.cfg),
    cotPrepared: Boolean(preparedCot),
  });
}
