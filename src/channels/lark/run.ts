import type { LarkChannel, NormalizedMessage } from '@larksuite/channel';
import { capabilityForProfile } from '../../agent/backends';
import type { AgentCapability } from '../../agent/capability';
import { modelRunArguments } from '../../agent/model-settings';
import type { AgentAdapter } from '../../agent/types';
import type { RunHostBinding } from '../../agent/run-host';
import { modelLabel, normalizeModelSelection } from '../../agent/models';
import type { ChatMode } from './chat-mode-cache';
import type { CotClient, CotPublisher } from './cot';
import type { PendingMessage } from './pending-queue';
import {
  fetchQuotedContext,
  fetchTopicContext,
  LARK_CONTEXT_MAX_CHARS,
  type QuotedContext,
} from './quote';
import type { UserQuestions } from './question-cards';
import type { CallbackAuth } from '../../card/callback-auth';
import type { Controls } from '../../commands';
import type { AgentKind } from '../../config/profile-schema';
import { getCotMessages, getMessageReplyMode } from '../../config/schema';
import { log } from '../../core/logger';
import { toPolicyAttachment } from '../../media/attachment';
import type { MediaCache } from '../../media/cache';
import { canUseDm, canUseGroup, type AccessDecision } from '../../policy/access';
import type { ScopeContext } from '../../policy/run-policy';
import type { AgentEntry } from '../../runtime/agent-entry';
import { profileForAgentKind } from '../../runtime/execution-controller';
import { resolveRunModelSettings } from '../../runtime/model-settings';
import { deadlineInstructions } from '../../runtime/run-deadline';
import { abortStopReason } from '../../runtime/errors';
import type { RunExecution } from '../../runtime/run-executor';
import { resolveRunFlowContext } from '../../runtime/run-flow';
import type { RunState } from '../../runtime/run-state';
import { startTurn, type StartedTurn, type TurnStores } from '../../runtime/turn';
import { timedRuns, type TimedRun } from '../../runtime/timed-runs';
import type { WorkflowRuntime } from '@kuribohg/agent-workflows';
import { bindAgentEntry } from './agent-entry';
import { larkDisplay } from './config';
import { createLarkRunOutput } from './run-output';

import { buildPrompt, replyQuoteTargetForMessage, senderTypeOf } from './prompt';
import type { ScopeRunMemory } from './scope-run-memory';

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
}

/** One turn: the batch to answer and how it was started. */
export interface LarkTurnRequest {
  scope: string;
  batch: PendingMessage[];
  agentKind: AgentKind;
  agent: AgentAdapter;
  mode: ChatMode;
  entry?: AgentEntry;
  workflows?: WorkflowRuntime;
  workflowOrigins?: Map<string, NormalizedMessage>;
  timedJob?: TimedRun;
  signal?: AbortSignal;
  preparedCot?: CotPublisher;
  /** Replay number of input whose earlier run was cut off by a bridge shutdown. */
  resumeAttempt?: number;
  /** Run host that keeps the agent alive across bridge restarts, or the one to reattach to. */
  host?: RunHostBinding;
}

/** Resolves with the submitted execution once its output has been presented. */
export async function runAgentBatch(
  services: LarkRunServices,
  turn: LarkTurnRequest,
): Promise<RunExecution | undefined> {
  const entry = turn.entry ?? { kind: 'direct' };
  const workflowWake = entry.kind === 'workflow' && entry.trigger === 'event';
  const { channel, media, controls } = services;
  const { batch, scope, agentKind, agent, mode, preparedCot } = turn;
  if (batch.length === 0) return undefined;
  batch.sort((left, right) => {
    const leftTime = Number.isFinite(left.createTime) ? left.createTime : 0;
    const rightTime = Number.isFinite(right.createTime) ? right.createTime : 0;
    return leftTime - rightTime;
  });
  const firstMsg = batch[0];
  const lastMsg = batch[batch.length - 1];
  if (!firstMsg || !lastMsg) return undefined;
  if (!workflowWake) turn.workflowOrigins?.set(scope, firstMsg);

  const chatId = firstMsg.chatId;
  const threadId = firstMsg.threadId;
  const scopedProfile = profileForAgentKind(controls.profileConfig, agentKind);
  const capability = capabilityForProfile(scopedProfile);
  // A workflow wake carries no user input: nothing to attach, quote or import.
  const input = workflowWake ? [] : batch;
  const attachments = await resolveAttachments(media, controls, input);
  const quoted = await fetchBatchQuotes(channel, input, mode);

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
  const topic = !workflowWake && mode === 'topic' && threadId
    ? await fetchUnseenTopicContext(services, {
      scope, scopeContext, threadId, batch, firstMsg, attachments, accessDecision, capability, quoted,
    })
    : EMPTY_TOPIC_CONTEXT;

  const { runArguments, modelPref, modelSelection, modelSwitched } = await resolveTurnModel(services, turn);
  const extraInstructions = turnInstructions({
    topicContextComplete: topic.complete,
    quotesMissing: quoted.failedIds.length > 0,
    modelSwitchedTo: modelSwitched ? modelLabel(agentKind, modelPref) : undefined,
    timedJob: turn.timedJob,
    resumeAttempt: turn.resumeAttempt,
  });
  const entryBinding = bindAgentEntry(entry, scope, turn.workflows);
  if (entryBinding) extraInstructions.push(entryBinding.instructions);
  const prompt = workflowWake
    ? `<workflow_events source="bridge">子任务通知，请读取产物并确认事件，继续原工作流。这不是用户输入。\n${entryBinding?.instructions ?? ''}</workflow_events>`
    : buildPrompt(
    batch,
    attachments,
    quoted.quotes,
    topic.messages,
    channel.botIdentity,
    extraInstructions,
  );
  log.info('prompt', 'built', {
    promptChars: prompt.length,
    quotes: quoted.quotes.length,
    topicContext: topic.messages.length,
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

  const flow = await startTurn(services, {
    env: entryBinding?.env,
    modelSettings: runArguments,
    deadlineAt: turn.timedJob?.stopAt,
    signal: turn.signal,
    scopeId: scope,
    scope: scopeContext,
    prompt,
    attachments: attachments.map(toPolicyAttachment),
    access: accessDecision,
    capability,
    profileConfig: scopedProfile,
    runPreferences: controls.cfg,
    agent,
    // A timed run has no one waiting to answer before its deadline.
    userQuestions: !turn.timedJob,
    // Chat replies show the whole answer, including text written before tool calls.
    answerIncludesInterimText: true,
    host: turn.host,
    observability: {
      profile: controls.profile,
      agent: capability.agentId,
      source: 'im',
      stage: 'submit',
    },
  }).catch(error => { entryBinding?.release(); throw error; });
  if (!flow.ok) {
    entryBinding?.release();
    if (workflowWake) throw new Error(flow.rejectReason.userVisible);
    log.info('run-flow', 'rejected', { scope, code: flow.rejectReason.code });
    log.warn('policy', 'denied', {
      scope,
      source: 'im',
      code: flow.rejectReason.code,
    });
    await preparedCot?.finish('error');
    await channel.send(chatId, { markdown: flow.rejectReason.userVisible }, sendOpts);
    if (turn.timedJob) await (await timedRuns(controls)).finish(turn.timedJob.id,
      flow.rejectReason.code === 'deadline-expired' ? 'expired'
        : flow.rejectReason.code !== 'run-cancelled' ? 'failed'
        : turn.signal?.aborted && abortStopReason(turn.signal) === 'shutdown' ? 'interrupted' : 'stopped');
    return undefined;
  }

  const { execution } = flow;
  if (entryBinding) {
    void execution.result.finally(entryBinding.release);
    entryBinding.onStarted();
  }
  let timedResult: Promise<void> | undefined;
  if (turn.timedJob) {
    const store = await timedRuns(controls);
    const job = turn.timedJob;
    // A shutdown leaves the job resumable by the next bridge process.
    timedResult = execution.result.then((state) => store.finish(job.id,
      state === 'stopped' && execution.handle.stopReason === 'shutdown' ? 'interrupted' : state))
      .catch((err) => log.fail('timed-run', err, { jobId: job.id }));
    try {
      await store.transition(job.id, ['queued'], 'running');
    } catch {
      await execution.stop('cleanup');
      await timedResult;
      return execution;
    }
  }
  services.memory.runStarted(scope, flow.policy.policyFingerprint);
  services.activeRuns.seedInputMessages(scope, execution.handle.run, quoted.batchIds);
  if (flow.resumeFrom) {
    log.info('session', 'resume', { sessionId: flow.resumeFrom, cwd: flow.cwdRealpath });
  } else {
    log.info('session', 'fresh', { cwd: flow.cwdRealpath });
  }
  const sessionDone = flow.track(workflowWake ? { kind: 'internal' } : {
      kind: 'message', messageId: firstMsg.messageId, summary: summarizeRunInput(batch),
      ...(mode === 'topic' ? { history: {
        completeThrough: topic.through,
        seenMessageIds: [...topic.seenMessageIds, ...topic.messages.map(message => message.messageId), ...quoted.batchIds, ...quoted.fetchedIds],
      } } : {}),
  });
  // The observer starts with execution, even if rendering cannot start.
  void sessionDone.catch(err => log.warn('session', 'tracking-failed', { scope, err: String(err) }));

  const started = { flow, capability, firstMsg, lastMsg, sendOpts };
  const questionsDone = relayUserQuestions(services, turn, started);
  try {
    try {
      await presentTurn(services, turn, started);
    } catch (err) {
      // Rendering is not part of the model transaction. A failed Feishu write
      // must not make the next turn forget that this run actually completed.
      log.fail('stream', err);
    }
    await sessionDone;
  } finally {
    services.memory.runEnded(scope);
    if (turn.timedJob) {
      // End the supervised process even when card delivery failed before the
      // renderer drained the stream. Never let a rendering error detach work.
      await execution.stop('cleanup');
      await timedResult;
    }
    await questionsDone;
  }
  return execution;
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
async function fetchBatchQuotes(channel: LarkChannel, input: PendingMessage[], mode: ChatMode): Promise<BatchQuotes> {
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
    const q = await fetchQuotedContext(channel, targetId);
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

/**
 * Detects a model switch since this scope's last run. When resuming an
 * existing conversation the transcript still claims the old model, so the
 * (now-switched) agent is told its model changed. Only fires when a prior
 * model was seen for this scope and the selection actually changed.
 * Observed native models are recorded by session-progress.
 */
async function resolveTurnModel(services: LarkRunServices, turn: LarkTurnRequest) {
  const { agentKind, scope } = turn;
  const runModelSettings = await resolveRunModelSettings(services.controls, scope, undefined, agentKind);
  const runArguments = turn.timedJob?.modelSettings ?? modelRunArguments(runModelSettings);
  const modelPref = runArguments.model;
  const modelSelection = normalizeModelSelection(agentKind, modelPref);
  const modelSwitched = services.memory.modelSwitched(agentKind, scope, modelSelection);
  return { runArguments, modelPref, modelSelection, modelSwitched };
}

function turnInstructions(input: {
  topicContextComplete: boolean;
  quotesMissing: boolean;
  modelSwitchedTo?: string;
  timedJob?: TimedRun;
  resumeAttempt?: number;
}): string[] {
  const instructions = [
    ...(!input.topicContextComplete
      ? ['本次话题上下文未能完整导入。不要假设你已经看到该话题中所有未直接送达 bot 的消息；涉及缺失上下文时应明确说明。']
      : []),
    ...(input.quotesMissing
      ? ['有一条或多条用户引用的消息未能从飞书读取。不要猜测这些引用消息的内容；如无法完成任务请明确说明。']
      : []),
    ...(input.modelSwitchedTo !== undefined
      ? [
        `用户刚把本会话使用的模型切换为「${input.modelSwitchedTo}」。` +
          '之前的对话里可能提到别的模型,请以当前模型为准;若被问到你用的是什么模型,据此回答。',
        ]
      : []),
  ];
  if (input.timedJob) instructions.push(deadlineInstructions(input.timedJob.stopAt, input.timedJob.windDownAt));
  if (input.resumeAttempt) {
    instructions.push(
      `bridge 进程在你处理这批消息期间被终止，现已重启并自动续跑（第 ${input.resumeAttempt} 次）。` +
      '如果当前会话里已有这批消息及部分进展，先核对已完成的工作（文件、命令结果、已发出的消息），从中断处继续，' +
      '不要重复已经生效的操作；如果会话里没有，就按正常流程处理。',
    );
  }
  return instructions;
}

interface LarkStartedTurn {
  flow: StartedTurn;
  capability: AgentCapability;
  firstMsg: PendingMessage;
  lastMsg: PendingMessage;
  sendOpts: { replyTo: string; replyInThread?: boolean };
}

/** Posts the run's questions to the chat until its event stream ends. */
async function relayUserQuestions(services: LarkRunServices, turn: LarkTurnRequest, started: LarkStartedTurn): Promise<void> {
  const { flow, capability, firstMsg, lastMsg } = started;
  const { execution } = flow;
  const { scope } = turn;
  for await (const event of execution.subscribe()) {
    if (event.type !== 'user_input') continue;
    try {
      await services.userQuestions.publish(event, {
        runId: execution.runId,
        identity: { scopeId: scope, agentId: capability.agentId, cwdRealpath: flow.cwdRealpath, policyFingerprint: flow.policy.policyFingerprint },
        message: firstMsg, replyTo: lastMsg.messageId,
        mentionUser: firstMsg.chatType !== 'p2p' && senderTypeOf(firstMsg) === 'user',
        allowQueue: !turn.timedJob, isCancelled: () => execution.handle.interrupted || Boolean(turn.signal?.aborted),
      });
    } catch (err) { log.warn('question', 'delivery-failed', { scope, err: String(err) }); }
  }
}

/** Renders the run into the chat with the profile's reply mode and display settings. */
async function presentTurn(services: LarkRunServices, turn: LarkTurnRequest, started: LarkStartedTurn): Promise<void> {
  const { channel, controls, cotClient, callbackAuth } = services;
  const { scope, preparedCot } = turn;
  const { flow, firstMsg, lastMsg, sendOpts } = started;
  const { execution } = flow;
  const chatId = firstMsg.chatId;
  if (flow.idleTimeoutMs) log.info('flush', 'idle-watchdog', { idleTimeoutMs: flow.idleTimeoutMs });

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
  await flow.present(createLarkRunOutput({
    channel, chatId, replyMode, sendOpts, cardRenderOptions,
    cotMessages, cotClient, preparedCot, originMessageId: lastMsg.messageId, inputPreview: lastMsg.content,
  }), { filterForPrefs });
}

function summarizeRunInput(batch: NormalizedMessage[]): string {
  return batch
    .map((message) => message.content.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(' / ')
    .slice(0, 180);
}
