import { randomUUID } from 'node:crypto';
import type { NormalizedMessage } from '@larksuite/channel';
import type { AgentEvent, AgentQuestion } from '../../agent/types';
import { buildAgentPrompt } from '../../agent/prompt';
import { log } from '../../core/logger';
import { sessionCatalogKey, type SessionCatalog, type SessionCatalogIdentity } from '../../session/catalog';
import type { ActiveRuns } from '../../runtime/active-runs';
import type { FollowupRouter } from './followup';
import { bridgeInput, type PendingQueue } from './pending-queue';

export type QuestionEvent = Extract<AgentEvent, { type: 'user_input' }>;

export interface QuestionContext {
  runId: string;
  identity: SessionCatalogIdentity;
  message: NormalizedMessage;
  replyTo: string;
  mentionUser: boolean;
  allowQueue: boolean;
  isCancelled(): boolean;
}

/** One agent request; all of its questions are answered together. */
export interface QuestionRequest extends QuestionContext {
  readonly id: string;
  readonly nativeId: string;
  readonly mode: QuestionEvent['mode'];
  readonly questions: readonly AgentQuestion[];
  readonly threadId?: string;
  readonly sessionId?: string;
  readonly generation: number;
  readonly expiresAt: number;
  /** IM handle of the presented question, used to match answers to it. */
  ref?: string;
  /** Set once the request is settled; the presenter shows it in place of the inputs. */
  status?: string;
}

/** The IM side: render a request, and show its settled status. */
export interface QuestionPresenter {
  /** Returns the message ref, or undefined when only a plain-text prompt could be shown. */
  present(request: QuestionRequest): Promise<string | undefined>;
  settle(request: QuestionRequest): Promise<void>;
  forget(ref: string): void;
}

export interface QuestionAnswerInput {
  requestId: string;
  ref?: string;
  scope: string;
  chatId: string;
  operatorId: string;
  identity?: SessionCatalogIdentity;
  answers: string[][];
  /** IM-level authorization, checked after the answer is known to be well-formed. */
  verify(request: QuestionRequest): boolean;
}

export type QuestionAnswerResult =
  | { kind: 'rejected'; notice: string; request?: QuestionRequest }
  | { kind: 'settled'; request: QuestionRequest };

const TTL_MS = 24 * 60 * 60 * 1000;
/** A blocking question holds the whole turn; past this the agent continues on its own assumptions. */
const BLOCKING_ANSWER_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_ANSWER_CHARS = 16_000;

/**
 * Routes agent questions between a run and an IM presenter. Blocking answers
 * resolve the run's pending request; async answers (or blocking ones whose run
 * stopped waiting) become follow-up input or a queued message.
 */
export class QuestionBroker {
  private readonly requests = new Map<string, QuestionRequest>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private closing = false;

  constructor(private readonly deps: {
    presenter: QuestionPresenter;
    activeRuns: ActiveRuns;
    followups: FollowupRouter;
    pending: PendingQueue;
    catalog?: SessionCatalog;
    isTimed(scope: string): boolean;
    botOpenId(): string | undefined;
    blockingTimeoutMs?: number;
  }) {}

  async publish(event: QuestionEvent, context: QuestionContext): Promise<void> {
    this.prune();
    if (this.closing || context.isCancelled() || !event.questions.length) return;
    const request: QuestionRequest = { ...context, id: randomUUID(), nativeId: event.id, mode: event.mode,
      questions: event.questions, ...(event.threadId ? { threadId: event.threadId } : {}),
      ...(event.sessionId ? { sessionId: event.sessionId } : {}),
      generation: this.deps.activeRuns.generation(context.identity.scopeId), expiresAt: Date.now() + TTL_MS };
    // Registered before presenting so a text reply can answer even when only plain text was shown.
    this.requests.set(request.id, request);
    if (request.mode === 'blocking') this.armTimeout(request);
    try {
      request.ref = await this.deps.presenter.present(request);
      if (this.closing && request.ref) this.deps.presenter.forget(request.ref);
      log.info('question', 'sent', { scope: request.identity.scopeId, runId: request.runId, mode: request.mode,
        questions: request.questions.length, messageId: request.ref });
    } catch (err) {
      this.drop(request);
      throw err;
    }
  }

  get(requestId: string): QuestionRequest | undefined {
    this.prune();
    return this.requests.get(requestId);
  }

  async answer(input: QuestionAnswerInput): Promise<QuestionAnswerResult> {
    this.prune();
    const request = this.requests.get(input.requestId);
    if (!request || (input.ref !== undefined && request.ref !== input.ref) || request.identity.scopeId !== input.scope ||
        request.message.chatId !== input.chatId || request.message.senderId !== input.operatorId) {
      return { kind: 'rejected', notice: '这个提问已失效，或不属于你；请在原话题直接回复。' };
    }
    if (request.status) return { kind: 'rejected', notice: request.status, request };
    const active = this.deps.activeRuns.get(input.scope);
    if (active && active.run.runId !== request.runId) {
      return this.settle(request, '当前话题已有新的任务，请直接回复并说明这条答案对应的问题。');
    }
    if (request.isCancelled() || !input.identity || sessionCatalogKey(input.identity) !== sessionCatalogKey(request.identity) ||
        this.deps.activeRuns.generation(input.scope) !== request.generation || !this.sameSession(request, input.identity)) {
      request.status = '正在处理你的回答。';
      const released = await this.releaseStale(request);
      return this.settle(request, released
        ? '无法确认这个回答属于原会话，未送入任务；任务已按默认假设继续，请在原话题重新说明你的选择。'
        : '原任务已停止或会话已切换，请在原话题重新说明你的选择。');
    }
    const answers = normalizeAnswers(request, input.answers);
    if (!answers) return { kind: 'rejected', notice: '请先回答每个问题：点击有效选项，或填写自己的答案。' };
    if (!input.verify(request)) return { kind: 'rejected', notice: '按钮校验未通过，请在原话题直接回复答案。' };
    // Lock every input of this request before any asynchronous delivery.
    request.status = '正在提交你的回答。';
    this.clearTimeout(request.id);
    log.info('question', 'delivery-started', { scope: input.scope, runId: request.runId, mode: request.mode });
    const status = await this.deliver(request, input.identity, answers);
    return this.settle(request, status);
  }

  /**
   * A plain reply answers the scope's only waiting blocking question; otherwise
   * it stays ordinary follow-up input. Returns the settled status when consumed.
   */
  async answerWithText(input: {
    scope: string;
    senderId: string;
    text: string;
    resolveIdentity(): Promise<SessionCatalogIdentity | undefined>;
  }): Promise<string | undefined> {
    this.prune();
    const active = this.deps.activeRuns.get(input.scope);
    if (!active || !input.text.trim()) return undefined;
    const waiting = [...this.requests.values()].filter(request => !request.status && request.mode === 'blocking' &&
      request.identity.scopeId === input.scope && request.runId === active.run.runId);
    const request = waiting.length === 1 ? waiting[0]! : undefined;
    if (!request || request.questions.length !== 1 || request.message.senderId !== input.senderId) return undefined;
    const result = await this.answer({ requestId: request.id, scope: input.scope, chatId: request.message.chatId,
      operatorId: input.senderId, identity: await input.resolveIdentity(), answers: [[input.text]], verify: () => true });
    return result.kind === 'settled' ? result.request.status : undefined;
  }

  close(): void {
    this.closing = true;
    for (const request of [...this.requests.values()]) this.drop(request);
  }

  private async deliver(request: QuestionRequest, identity: SessionCatalogIdentity, answers: string[][]): Promise<string> {
    const summary = answers.map(answer => answer.join('、')).join('；');
    const scope = identity.scopeId;
    if (request.mode === 'blocking') {
      const handle = this.deps.activeRuns.get(scope);
      if (handle && handle.run.runId === request.runId && handle.run.answerUserInput && !handle.interrupted) {
        try {
          if (await handle.run.answerUserInput(request.nativeId, { answers }) === 'accepted') {
            log.info('question', 'answered', { scope, runId: request.runId, delivery: 'native' });
            return `已提交：${summary}\n已送入当前任务。`;
          }
        } catch (err) {
          log.warn('question', 'native-answer-failed', { scope, err: String(err) });
          return '未收到接收确认，无法确定答案是否送达；没有自动重发。';
        }
      }
      // The run stopped waiting for this request; continue as ordinary input.
    }
    const content = ['对之前提问的回答：', ...request.questions.flatMap((q, i) => [`问题：${q.question}`, `回答：${answers[i]!.join('、')}`])].join('\n');
    // The answer came from the question's own message; fall back to the asker's when only text was shown.
    const anchorId = request.ref ?? request.message.messageId;
    const inputId = `${anchorId}:${request.id}`;
    const result = await this.deps.followups.deliver({
      scope, messageId: inputId, activeRuns: this.deps.activeRuns,
      prepare: async () => buildAgentPrompt({
        context: { chatId: request.message.chatId, chatType: request.message.chatType,
          threadId: request.message.threadId, senderId: request.message.senderId, senderType: 'user',
          botOpenId: this.deps.botOpenId(), messageIds: [anchorId], source: 'card' },
        instructions: ['这是用户对先前提问的回答。请结合当前任务和已完成进度处理。'], userInput: content,
      }),
    });
    log.info('question', 'answered', { scope, runId: request.runId, delivery: result });
    if (result === 'accepted') return `已提交：${summary}\n已送入当前任务，等待模型处理。`;
    if (result === 'unknown') return '未收到接收确认，无法确定答案是否送达；没有自动重发。';
    if (result === 'cancelled' || this.deps.activeRuns.generation(scope) !== request.generation) {
      return '当前任务已停止，答案未另起任务执行。';
    }
    if (!request.allowQueue || this.deps.isTimed(scope)) return '限时任务已结束或无法接收回答，请在原话题手动继续。';
    if (!this.sameSession(request, identity)) return '会话已切换，答案未发送；请在原话题重新说明你的选择。';
    // The queued turn replies to this message, so it carries the anchor, not the input key.
    const size = this.deps.pending.push(scope, bridgeInput({ ...request.message, messageId: anchorId }, content));
    if (size !== undefined) await this.deps.pending.flushPersistence();
    return size === undefined
      ? `已提交：${summary}\n待处理队列已满，回答没有排入后续任务。`
      : `已提交：${summary}\n已排队，将在原会话继续处理。`;
  }

  private sameSession(request: QuestionRequest, identity: SessionCatalogIdentity): boolean {
    const active = this.deps.catalog?.activeFor(identity);
    return request.sessionId ? active?.sessionId === request.sessionId : active?.threadId === request.threadId;
  }

  private async settle(request: QuestionRequest, status: string): Promise<QuestionAnswerResult> {
    request.status = status;
    this.clearTimeout(request.id);
    await this.deps.presenter.settle(request);
    return { kind: 'settled', request };
  }

  private armTimeout(request: QuestionRequest): void {
    const timeoutMs = this.deps.blockingTimeoutMs ?? BLOCKING_ANSWER_TIMEOUT_MS;
    const timer = setTimeout(() => {
      this.timers.delete(request.id);
      void this.expire(request, timeoutMs).catch(err => log.warn('question', 'timeout-failed', { err: String(err) }));
    }, timeoutMs);
    timer.unref?.();
    this.timers.set(request.id, timer);
  }

  private async expire(request: QuestionRequest, timeoutMs: number): Promise<void> {
    if (request.status) return;
    const handle = this.deps.activeRuns.get(request.identity.scopeId);
    if (!handle || handle.run.runId !== request.runId || !handle.run.answerUserInput) return;
    const minutes = Math.round(timeoutMs / 60_000);
    const declined = `用户 ${minutes} 分钟内没有回答。请按最合理的默认假设继续，并在最终答复中说明所作的假设。`;
    if (await handle.run.answerUserInput(request.nativeId, { declined }) !== 'accepted') return;
    log.info('question', 'timed-out', { scope: request.identity.scopeId, runId: request.runId });
    await this.settle(request, `${minutes} 分钟内未收到回答，任务已按默认假设继续。`);
  }

  /**
   * Settling a blocking request also cancels its timeout, so a run still
   * waiting on it would hang; decline it natively so the agent continues.
   */
  private async releaseStale(request: QuestionRequest): Promise<boolean> {
    if (request.mode !== 'blocking') return false;
    const handle = this.deps.activeRuns.get(request.identity.scopeId);
    if (!handle || handle.run.runId !== request.runId || handle.interrupted || !handle.run.answerUserInput) return false;
    const declined = '用户的回答无法确认属于当前会话，未被采纳。请按最合理的默认假设继续，并在最终答复中说明所作的假设。';
    try {
      if (await handle.run.answerUserInput(request.nativeId, { declined }) !== 'accepted') return false;
    } catch (err) {
      log.warn('question', 'stale-decline-failed', { scope: request.identity.scopeId, err: String(err) });
      return false;
    }
    log.info('question', 'stale-declined', { scope: request.identity.scopeId, runId: request.runId });
    return true;
  }

  private clearTimeout(id: string): void {
    const timer = this.timers.get(id);
    if (timer) clearTimeout(timer);
    this.timers.delete(id);
  }

  private drop(request: QuestionRequest): void {
    this.clearTimeout(request.id);
    if (request.ref) this.deps.presenter.forget(request.ref);
    this.requests.delete(request.id);
  }

  private prune(): void {
    for (const request of [...this.requests.values()]) {
      if (request.expiresAt <= Date.now() || this.requests.size >= 256) this.drop(request);
    }
  }
}

function normalizeAnswers(request: QuestionRequest, answers: string[][]): string[][] | undefined {
  if (answers.length !== request.questions.length) return undefined;
  const normalized = answers.map(answer => answer.map(value => value.trim()).filter(Boolean));
  if (normalized.some(answer => !answer.length)) return undefined;
  if (normalized.flat().reduce((sum, value) => sum + value.length, 0) > MAX_ANSWER_CHARS) return undefined;
  return normalized;
}
