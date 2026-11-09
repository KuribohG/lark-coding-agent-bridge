import type { LarkChannel, NormalizedMessage } from '@larksuite/channel';
import { capabilityForProfile } from '../../agent/backends';
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
import {
  getAgentStopGraceMs,
  getCotMessages,
  getMessageReplyMode,
  getRunIdleTimeoutMs,
} from '../../config/schema';
import { log } from '../../core/logger';
import { toPolicyAttachment } from '../../media/attachment';
import type { MediaCache } from '../../media/cache';
import { canUseDm, canUseGroup } from '../../policy/access';
import type { ScopeContext } from '../../policy/run-policy';
import type { ActiveRuns } from '../../runtime/active-runs';
import type { AgentEntry } from '../../runtime/agent-entry';
import { profileForAgentKind } from '../../runtime/execution-controller';
import { resolveRunModelSettings } from '../../runtime/model-settings';
import { deadlineInstructions } from '../../runtime/run-deadline';
import { abortStopReason } from '../../runtime/errors';
import type { RunExecution, RunExecutor } from '../../runtime/run-executor';
import {
  resolveRunFlowContext,
  startRunFlow,
} from '../../runtime/run-flow';
import { presentRunOutput } from '../../runtime/run-output';
import type { RunState } from '../../runtime/run-state';
import { trackRunSession } from '../../runtime/session-progress';
import { timedRuns, type TimedRun } from '../../runtime/timed-runs';
import type { SessionCatalog } from '../../session/catalog';
import type { SessionStore } from '../../session/store';
import type { WorkflowRuntime } from '@kuribohg/agent-workflows';
import type { WorkspaceStore } from '../../workspace/store';
import { bindAgentEntry } from './agent-entry';
import { larkDisplay } from './config';
import { createLarkRunOutput } from './run-output';

import { buildPrompt, replyQuoteTargetForMessage, senderTypeOf } from './prompt';
import type { ScopeRunMemory } from './scope-run-memory';

const TOPIC_CONTEXT_MAX_MESSAGES = 40;

/** Services shared by every turn of one channel connection. */
export interface LarkRunServices {
  channel: LarkChannel;
  executor: RunExecutor;
  sessions: SessionStore;
  sessionCatalog?: SessionCatalog;
  workspaces: WorkspaceStore;
  media: MediaCache;
  activeRuns: ActiveRuns;
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
  const {
    channel,
    executor,
    sessions,
    sessionCatalog,
    workspaces,
    media,
    activeRuns,
    controls,
    cotClient,
    callbackAuth,
    memory,
  } = services;
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

  const resourceItems = (workflowWake ? [] : batch).flatMap((m) =>
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
  const batchIds = new Set(workflowWake ? [] : batch.map((m) => m.messageId));
  const quoteTargets = [
    ...new Set(
      (workflowWake ? [] : batch)
        .map((m) => replyQuoteTargetForMessage(m, mode))
        .filter((id): id is string => Boolean(id) && !batchIds.has(id!)),
    ),
  ];
  const quotes: QuotedContext[] = [];
  const fetchedQuoteIds = new Set<string>();
  for (const targetId of quoteTargets) {
    const q = await fetchQuotedContext(channel, targetId);
    if (q) {
      quotes.push(q);
      fetchedQuoteIds.add(targetId);
      log.info('quote', 'fetched', {
        messageId: targetId,
        type: q.rawContentType,
        contentChars: q.content.length,
      });
    }
  }
  const failedQuoteIds = quoteTargets.filter((targetId) => !fetchedQuoteIds.has(targetId));
  if (failedQuoteIds.length > 0) {
    log.warn('quote', 'batch-fetch-incomplete', {
      count: failedQuoteIds.length,
      messageIds: failedQuoteIds,
    });
  }

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

  // Topic upstream context. A resumed native session only contains messages
  // that actually reached the agent; unmentioned group chatter never does.
  // Import unseen messages on every topic turn, using the last complete import
  // as a cursor. Failed/truncated windows remain pending and are retried.
  let topicContext: QuotedContext[] = [];
  let topicContextSince: number | undefined;
  let topicContextThrough: number | undefined;
  let topicContextComplete = true;
  let topicContextIncompleteReason: string | undefined;
  let topicContextSeenMessageIds: string[] = [];
  const topicContextUntil = batch.reduce((latest, message) => {
    const createTime = Number.isFinite(message.createTime) ? message.createTime : undefined;
    return createTime !== undefined && createTime > latest ? createTime : latest;
  }, 0);
  if (!workflowWake && mode === 'topic' && threadId) {
    const context = await resolveRunFlowContext({
      scopeId: scope,
      scope: scopeContext,
      prompt: '',
      attachments: attachments.map(toPolicyAttachment),
      access: accessDecision,
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
      topicContextSince = entry?.topicContextThrough;
      topicContextSeenMessageIds = entry?.topicContextSeenMessageIds ?? [];
    }

    const exclude = new Set([...batchIds, ...fetchedQuoteIds, ...topicContextSeenMessageIds]);
    const fetched = await fetchTopicContext(channel, threadId, {
      maxMessages: TOPIC_CONTEXT_MAX_MESSAGES,
      maxChars: LARK_CONTEXT_MAX_CHARS,
      ...(topicContextSince !== undefined ? { sinceMs: topicContextSince } : {}),
      ...(topicContextUntil > 0 ? { untilMs: topicContextUntil } : {}),
      ...(firstMsg.rootId ? { anchorMessageId: firstMsg.rootId } : {}),
      excludeIds: exclude,
      ...(channel.botIdentity?.openId ? { selfOpenId: channel.botIdentity.openId } : {}),
      ...(controls.profileConfig.accounts.app.id
        ? { selfAppId: controls.profileConfig.accounts.app.id }
        : {}),
    });
    topicContext = fetched.messages;
    topicContextComplete = fetched.complete;
    topicContextIncompleteReason = fetched.reason;
    if (topicContextComplete && topicContextUntil > 0) {
      topicContextThrough = topicContextUntil;
    }
    topicContext = topicContext.filter(message => !controls.channel?.btw.excludes(scope, message));
    if (topicContext.length > 0) {
      log.info('topic', 'context-fetched', {
        scope,
        threadId,
        count: topicContext.length,
        incremental: topicContextSince !== undefined,
        ...(topicContextSince !== undefined ? { sinceMs: topicContextSince } : {}),
      });
    }
    if (!topicContextComplete) {
      log.warn('topic', 'context-incomplete', {
        scope,
        threadId,
        reason: topicContextIncompleteReason,
        count: topicContext.length,
      });
    }
  }

  // Detect a model switch since this scope's last run. When resuming an
  // existing conversation the transcript still claims the old model, so tell
  // the (now-switched) agent its model changed — otherwise it keeps echoing
  // the previously-announced model. Only fires when a prior model was seen
  // for this scope (never on the first run) and the selection actually
  // changed. Observed native models are recorded by session-progress.
  const runModelSettings = await resolveRunModelSettings(controls, scope, undefined, agentKind);
  const runArguments = turn.timedJob?.modelSettings ?? modelRunArguments(runModelSettings);
  const modelPref = runArguments.model;
  const modelSelection = normalizeModelSelection(agentKind, modelPref);
  const modelSwitched = memory.modelSwitched(agentKind, scope, modelSelection);
  const extraInstructions = [
    ...(!topicContextComplete
      ? ['本次话题上下文未能完整导入。不要假设你已经看到该话题中所有未直接送达 bot 的消息；涉及缺失上下文时应明确说明。']
      : []),
    ...(failedQuoteIds.length > 0
      ? ['有一条或多条用户引用的消息未能从飞书读取。不要猜测这些引用消息的内容；如无法完成任务请明确说明。']
      : []),
    ...(modelSwitched
      ? [
        `用户刚把本会话使用的模型切换为「${modelLabel(agentKind, modelPref)}」。` +
          '之前的对话里可能提到别的模型,请以当前模型为准;若被问到你用的是什么模型,据此回答。',
        ]
      : []),
  ];
  if (turn.timedJob) extraInstructions.push(deadlineInstructions(turn.timedJob.stopAt, turn.timedJob.windDownAt));
  if (turn.resumeAttempt) {
    extraInstructions.push(
      `bridge 进程在你处理这批消息期间被终止，现已重启并自动续跑（第 ${turn.resumeAttempt} 次）。` +
      '如果当前会话里已有这批消息及部分进展，先核对已完成的工作（文件、命令结果、已发出的消息），从中断处继续，' +
      '不要重复已经生效的操作；如果会话里没有，就按正常流程处理。',
    );
  }

  const entryBinding = bindAgentEntry(entry, scope, turn.workflows);
  if (entryBinding) extraInstructions.push(entryBinding.instructions);
  const prompt = workflowWake
    ? `<workflow_events source="bridge">子任务通知，请读取产物并确认事件，继续原工作流。这不是用户输入。\n${entryBinding?.instructions ?? ''}</workflow_events>`
    : buildPrompt(
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

  const flow = await startRunFlow({
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
    agent,
    sessions,
    sessionCatalog,
    workspaces,
    executor,
    now: Date.now(),
    stopGraceMs: getAgentStopGraceMs(controls.cfg),
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

  const { execution, cwdRealpath: cwd } = flow;
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
  memory.runStarted(scope, flow.policy.policyFingerprint);
  const handle = execution.handle;
  activeRuns.seedInputMessages(scope, handle.run, batchIds);
  if (flow.resumeFrom) {
    log.info('session', 'resume', { sessionId: flow.resumeFrom, cwd });
  } else {
    log.info('session', 'fresh', { cwd });
  }
  const sessionDone = trackRunSession({
    scopeId: scope, sessions, sessionCatalog, capability, policy: flow.policy,
    execution, activeRuns, resumeFrom: flow.resumeFrom,
    source: workflowWake ? { kind: 'internal' } : {
      kind: 'message', messageId: firstMsg.messageId, summary: summarizeRunInput(batch),
      ...(mode === 'topic' ? { history: {
        completeThrough: topicContextThrough,
        seenMessageIds: [...topicContextSeenMessageIds, ...topicContext.map(message => message.messageId), ...batchIds, ...fetchedQuoteIds],
      } } : {}),
    },
  });
  // The observer starts with execution, even if rendering cannot start.
  void sessionDone.catch(err => log.warn('session', 'tracking-failed', { scope, err: String(err) }));

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
        await services.userQuestions.publish(event, {
          runId: execution.runId,
          identity: { scopeId: scope, agentId: capability.agentId, cwdRealpath: cwd, policyFingerprint: flow.policy.policyFingerprint },
          message: firstMsg, replyTo: lastMsg.messageId,
          mentionUser: firstMsg.chatType !== 'p2p' && senderTypeOf(firstMsg) === 'user',
          allowQueue: !turn.timedJob, isCancelled: () => handle.interrupted || Boolean(turn.signal?.aborted),
        });
      } catch (err) { log.warn('question', 'delivery-failed', { scope, err: String(err) }); }
    }
  })();

  try {
    try {
      await presentRunOutput(execution, createLarkRunOutput({
        channel, chatId, replyMode, sendOpts, cardRenderOptions,
        cotMessages, cotClient, preparedCot, originMessageId: lastMsg.messageId, inputPreview: lastMsg.content,
      }), { idleTimeoutMs, filterForPrefs });
    } catch (err) {
      // Rendering is not part of the model transaction. A failed Feishu write
      // must not make the next turn forget that this run actually completed.
      log.fail('stream', err);
    }
    await sessionDone;
  } finally {
    memory.runEnded(scope);
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

function summarizeRunInput(batch: NormalizedMessage[]): string {
  return batch
    .map((message) => message.content.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(' / ')
    .slice(0, 180);
}
