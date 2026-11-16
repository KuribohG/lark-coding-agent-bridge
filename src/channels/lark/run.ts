import type { LarkChannel, NormalizedMessage } from '@larksuite/channel';
import type { AgentCapability } from '../../agent/capability';
import type { ChatMode } from './scope-types';
import type { CotClient, CotPublisher } from './cot';
import type { PendingMessage } from './pending-queue';
import {
  fetchQuotedContext,
  fetchTopicContext,
  LARK_CONTEXT_MAX_CHARS,
  type QuotedContext,
} from './quote';
import type { UserQuestions } from './question-cards';
import type { LarkUserReads } from './user-read';
import type { CallbackAuth } from '../../card/callback-auth';
import type { Controls } from '../../commands';
import { getCotMessages, getMessageReplyMode } from '../../config/schema';
import { log } from '../../core/logger';
import { toPolicyAttachment } from '../../media/attachment';
import type { MediaCache } from '../../media/cache';
import { canUseDm, canUseGroup, type AccessDecision } from '../../policy/access';
import type { ScopeContext } from '../../policy/run-policy';
import type { RunExecution } from '../../runtime/run-executor';
import { resolveRunFlowContext } from '../../runtime/run-flow';
import type { RunState } from '../../runtime/run-state';
import type { ScopeRunMemory } from '../../runtime/scope-run-memory';
import { profileForAgentKind } from '../../runtime/execution-controller';
import { resolveRunModelSettings } from '../../runtime/model-settings';
import {
  runMessageTurn,
  type MessageTurn,
  type MessageTurnContext,
  type MessageTurnFrontend,
  type PreparedMessageTurn,
} from '../../runtime/message-turn';
import type { StartedTurn, TurnStores } from '../../runtime/turn';
import { larkDisplay } from './config';
import { createLarkRunOutput } from './run-output';

import { buildPrompt, replyQuoteTargetForMessage, senderTypeOf } from './prompt';

const TOPIC_CONTEXT_MAX_MESSAGES = 40;

/** Services shared by every turn of one channel connection. */
export interface LarkRunServices extends TurnStores {
  channel: LarkChannel;
  media: MediaCache;
  controls: Controls;
  cotClient: CotClient;
  callbackAuth?: CallbackAuth;
  userQuestions: UserQuestions;
  memory: ScopeRunMemory;
  /** User-identity fallback for read-only IM calls (see `user-read.ts`). */
  userReads?: LarkUserReads;
}

/** One turn: the batch to answer and how it was started. */
export interface LarkTurnRequest extends MessageTurn<PendingMessage> {
  mode: ChatMode;
  preparedCot?: CotPublisher;
  /** Where a non-wake turn records who the workflows it starts answer to. */
  workflowOrigins?: Map<string, NormalizedMessage>;
}

/** Resolves with the submitted execution once its output has been presented. */
export async function runAgentBatch(
  services: LarkRunServices,
  turn: LarkTurnRequest,
): Promise<RunExecution | undefined> {
  return runMessageTurn(
    {
      stores: services,
      profileFor: agentKind => profileForAgentKind(services.controls.profileConfig, agentKind),
      resolveModelSettings: (scope, agentKind) =>
        resolveRunModelSettings(services.controls, scope, undefined, agentKind),
      runPreferences: services.controls.cfg,
      profile: services.controls.profile,
      memory: services.memory,
    },
    larkMessageTurnFrontend(services),
    turn,
  );
}

/** The Lark half of a message turn: context import, prompt, notices and cards. */
function larkMessageTurnFrontend(services: LarkRunServices): MessageTurnFrontend<PendingMessage, LarkTurnRequest> {
  return {
    order: batch => batch.sort((left, right) => {
      const leftTime = Number.isFinite(left.createTime) ? left.createTime : 0;
      const rightTime = Number.isFinite(right.createTime) ? right.createTime : 0;
      return leftTime - rightTime;
    }),
    prepare: context => prepareTurn(services, context),
    reject: (context, _prepared, reason) => rejectTurn(services, context, reason),
    questions: (context, _prepared, started) => relayUserQuestions(services, context, started),
    present: (context, _prepared, started) => presentTurn(services, context, started),
  };
}

/** Imported quotes, topic history and the prompt this batch is answered with. */
async function prepareTurn(
  services: LarkRunServices,
  context: MessageTurnContext<PendingMessage, LarkTurnRequest>,
): Promise<PreparedMessageTurn> {
  const { channel, media, controls } = services;
  const { turn, input, wake, capability } = context;
  const { firstMsg, sendOpts } = larkTurnMessages(turn);
  // The workflow this turn may start answers to the message that started it.
  if (!wake) turn.workflowOrigins?.set(turn.scope, firstMsg);

  const attachments = await resolveAttachments(media, controls, input);
  const quoted = await fetchBatchQuotes(channel, input, turn.mode, services.userReads);
  const accessDecision =
    firstMsg.chatType === 'p2p'
      ? canUseDm(controls.profileConfig, controls, firstMsg.senderId)
      : canUseGroup(controls.profileConfig, controls, firstMsg.chatId, firstMsg.senderId);
  const scopeContext: ScopeContext = {
    source: 'im',
    chatId: firstMsg.chatId,
    actorId: firstMsg.senderId,
    ...(firstMsg.threadId ? { threadId: firstMsg.threadId } : {}),
  };
  const topic = !wake && turn.mode === 'topic' && firstMsg.threadId
    ? await fetchUnseenTopicContext(services, {
      scope: turn.scope, scopeContext, threadId: firstMsg.threadId, batch: turn.batch, firstMsg,
      attachments, accessDecision, capability, quoted,
    })
    : EMPTY_TOPIC_CONTEXT;

  log.info('flush', 'reply-target', {
    scope: turn.scope,
    mode: turn.mode,
    chatId: firstMsg.chatId,
    threadId: firstMsg.threadId,
    replyTo: sendOpts.replyTo,
    replyInThread: sendOpts.replyInThread === true,
  });

  return {
    scope: scopeContext,
    access: accessDecision,
    attachments: attachments.map(toPolicyAttachment),
    instructions: [
      ...(!topic.complete
        ? ['本次话题上下文未能完整导入。不要假设你已经看到该话题中所有未直接送达 bot 的消息；涉及缺失上下文时应明确说明。']
        : []),
      ...(quoted.failedIds.length > 0
        ? ['有一条或多条用户引用的消息未能从飞书读取。不要猜测这些引用消息的内容；如无法完成任务请明确说明。']
        : []),
    ],
    prompt: extraInstructions => buildPrompt(
      turn.batch,
      attachments,
      quoted.quotes,
      topic.messages,
      channel.botIdentity,
      extraInstructions,
    ),
    sessionSource: wake ? { kind: 'internal' } : {
      kind: 'message', messageId: firstMsg.messageId, summary: summarizeRunInput(turn.batch),
      ...(turn.mode === 'topic' ? { history: {
        completeThrough: topic.through,
        seenMessageIds: [...topic.seenMessageIds, ...topic.messages.map(message => message.messageId), ...quoted.batchIds, ...quoted.fetchedIds],
      } } : {}),
    },
    inputMessageIds: [...quoted.batchIds],
    details: { quotes: quoted.quotes.length, topicContext: topic.messages.length },
    observabilitySource: 'im',
    // Chat turns may wait for the user's answer, and show text written before tool calls.
    runOptions: { userQuestions: true, answerIncludesInterimText: true },
    // A failed card write must not make the next turn forget the run completed.
    presentFailure: 'log',
  };
}

/** The run never started: close prepared output and tell the topic why. */
async function rejectTurn(
  services: LarkRunServices,
  context: MessageTurnContext<PendingMessage, LarkTurnRequest>,
  reason: { userVisible: string },
): Promise<void> {
  const { firstMsg, sendOpts } = larkTurnMessages(context.turn);
  await context.turn.preparedCot?.finish('error');
  await services.channel.send(firstMsg.chatId, { markdown: reason.userVisible }, sendOpts);
}

/** Posts the run's questions to the chat until its event stream ends. */
async function relayUserQuestions(
  services: LarkRunServices,
  context: MessageTurnContext<PendingMessage, LarkTurnRequest>,
  started: StartedTurn,
): Promise<void> {
  const { execution } = started;
  const { scope } = context.turn;
  const { firstMsg, lastMsg } = larkTurnMessages(context.turn);
  for await (const event of execution.subscribe()) {
    if (event.type !== 'user_input') continue;
    try {
      await services.userQuestions.publish(event, {
        runId: execution.runId,
        identity: { scopeId: scope, agentId: context.capability.agentId, cwdRealpath: started.cwdRealpath, policyFingerprint: started.policy.policyFingerprint },
        message: firstMsg, replyTo: lastMsg.messageId,
        mentionUser: firstMsg.chatType !== 'p2p' && senderTypeOf(firstMsg) === 'user',
        allowQueue: true, isCancelled: () => execution.handle.interrupted || Boolean(context.turn.signal?.aborted),
      });
    } catch (err) { log.warn('question', 'delivery-failed', { scope, err: String(err) }); }
  }
}

/** Renders the run into the chat with the profile's reply mode and display settings. */
async function presentTurn(
  services: LarkRunServices,
  context: MessageTurnContext<PendingMessage, LarkTurnRequest>,
  started: StartedTurn,
): Promise<void> {
  const { channel, controls, cotClient, callbackAuth } = services;
  const { scope, preparedCot } = context.turn;
  const { firstMsg, lastMsg, sendOpts } = larkTurnMessages(context.turn);
  const { execution } = started;
  const chatId = firstMsg.chatId;
  if (started.idleTimeoutMs) log.info('flush', 'idle-watchdog', { idleTimeoutMs: started.idleTimeoutMs });

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
              policyFingerprint: started.policy.policyFingerprint,
              ttlMs: 24 * 60 * 60 * 1000,
            }),
        }
      : {}),
  };
  await started.present(createLarkRunOutput({
    channel, chatId, replyMode, sendOpts, cardRenderOptions,
    cotMessages, cotClient, preparedCot, originMessageId: lastMsg.messageId, inputPreview: lastMsg.content,
  }), { filterForPrefs });
}

/** First/last message of the (already ordered) batch and where replies go. */
function larkTurnMessages(turn: LarkTurnRequest) {
  const firstMsg = turn.batch[0]!;
  const lastMsg = turn.batch[turn.batch.length - 1]!;
  const sendOpts = {
    replyTo: lastMsg.messageId,
    ...(turn.mode === 'topic' && lastMsg.threadId ? { replyInThread: true } : {}),
  };
  return { firstMsg, lastMsg, sendOpts };
}

async function resolveAttachments(media: MediaCache, controls: Controls, input: PendingMessage[]) {
  const resourceItems = input.flatMap((m) =>
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
  return attachments;
}

interface BatchQuotes {
  /** Messages of the batch itself, which the prompt already contains. */
  batchIds: Set<string>;
  quotes: QuotedContext[];
  fetchedIds: Set<string>;
  failedIds: string[];
}

/** Fetches reply-quote targets once each, skipping ids that are themselves in the batch. */
async function fetchBatchQuotes(
  channel: LarkChannel,
  input: PendingMessage[],
  mode: ChatMode,
  reads?: LarkUserReads,
): Promise<BatchQuotes> {
  const batchIds = new Set(input.map((m) => m.messageId));
  const quoteTargets = [
    ...new Set(
      input
        .map((m) => replyQuoteTargetForMessage(m, mode))
        .filter((id): id is string => Boolean(id) && !batchIds.has(id!)),
    ),
  ];
  const quotes: QuotedContext[] = [];
  const fetchedIds = new Set<string>();
  for (const targetId of quoteTargets) {
    const q = await fetchQuotedContext(channel, targetId, { reads });
    if (q) {
      quotes.push(q);
      fetchedIds.add(targetId);
      log.info('quote', 'fetched', {
        messageId: targetId,
        type: q.rawContentType,
        contentChars: q.content.length,
      });
    }
  }
  const failedIds = quoteTargets.filter((targetId) => !fetchedIds.has(targetId));
  if (failedIds.length > 0) {
    log.warn('quote', 'batch-fetch-incomplete', {
      count: failedIds.length,
      messageIds: failedIds,
    });
  }
  return { batchIds, quotes, fetchedIds, failedIds };
}

interface TopicContext {
  messages: QuotedContext[];
  complete: boolean;
  /** Newest message time the import fully covers; the next turn starts after it. */
  through?: number;
  seenMessageIds: string[];
}

const EMPTY_TOPIC_CONTEXT: TopicContext = { messages: [], complete: true, seenMessageIds: [] };

/**
 * Topic upstream context. A resumed native session only contains messages
 * that actually reached the agent; unmentioned group chatter never does.
 * Import unseen messages on every topic turn, using the last complete import
 * as a cursor. Failed/truncated windows remain pending and are retried.
 */
async function fetchUnseenTopicContext(services: LarkRunServices, input: {
  scope: string;
  scopeContext: ScopeContext;
  threadId: string;
  batch: PendingMessage[];
  firstMsg: PendingMessage;
  attachments: Awaited<ReturnType<MediaCache['resolve']>>;
  accessDecision: AccessDecision;
  capability: AgentCapability;
  quoted: BatchQuotes;
}): Promise<TopicContext> {
  const { channel, controls, sessions, sessionCatalog, workspaces } = services;
  const { scope, threadId, firstMsg, capability } = input;
  let since: number | undefined;
  let seenMessageIds: string[] = [];
  const until = input.batch.reduce((latest, message) => {
    const createTime = Number.isFinite(message.createTime) ? message.createTime : undefined;
    return createTime !== undefined && createTime > latest ? createTime : latest;
  }, 0);
  const context = await resolveRunFlowContext({
    scopeId: scope,
    scope: input.scopeContext,
    prompt: '',
    attachments: input.attachments.map(toPolicyAttachment),
    access: input.accessDecision,
    capability,
    profileConfig: controls.profileConfig,
    sessions,
    sessionCatalog,
    workspaces,
    now: Date.now(),
  });
  if (context.ok && context.resumeFrom && sessionCatalog) {
    const entry = sessionCatalog.activeFor({
      scopeId: scope,
      agentId: capability.agentId,
      cwdRealpath: context.workspace.cwdRealpath,
      policyFingerprint: context.policy.policyFingerprint,
    });
    since = entry?.topicContextThrough;
    seenMessageIds = entry?.topicContextSeenMessageIds ?? [];
  }

  const exclude = new Set([...input.quoted.batchIds, ...input.quoted.fetchedIds, ...seenMessageIds]);
  const fetched = await fetchTopicContext(channel, threadId, {
    maxMessages: TOPIC_CONTEXT_MAX_MESSAGES,
    maxChars: LARK_CONTEXT_MAX_CHARS,
    ...(since !== undefined ? { sinceMs: since } : {}),
    ...(until > 0 ? { untilMs: until } : {}),
    ...(firstMsg.rootId ? { anchorMessageId: firstMsg.rootId } : {}),
    excludeIds: exclude,
    ...(channel.botIdentity?.openId ? { selfOpenId: channel.botIdentity.openId } : {}),
    ...(controls.profileConfig.accounts.app.id
      ? { selfAppId: controls.profileConfig.accounts.app.id }
      : {}),
    reads: services.userReads,
  });
  const messages = fetched.messages.filter(message => !controls.channel?.btw.excludes(scope, message));
  if (messages.length > 0) {
    log.info('topic', 'context-fetched', {
      scope,
      threadId,
      count: messages.length,
      incremental: since !== undefined,
      ...(since !== undefined ? { sinceMs: since } : {}),
    });
  }
  if (!fetched.complete) {
    log.warn('topic', 'context-incomplete', {
      scope,
      threadId,
      reason: fetched.reason,
      count: messages.length,
    });
  }
  return {
    messages,
    complete: fetched.complete,
    ...(fetched.complete && until > 0 ? { through: until } : {}),
    seenMessageIds,
  };
}

function summarizeRunInput(batch: NormalizedMessage[]): string {
  return batch
    .map((message) => message.content.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(' / ')
    .slice(0, 180);
}
