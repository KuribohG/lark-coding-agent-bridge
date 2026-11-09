import type { CardActionEvent, CardActionResponse, LarkChannel } from '@larksuite/channel';
import type { AgentQuestion } from '../../agent/types';
import type { CallbackAuth } from '../../card/callback-auth';
import { forgetManagedCard, sendManagedCard, updateManagedCard } from '../../card/managed';
import { log } from '../../core/logger';
import type { SessionCatalog, SessionCatalogIdentity } from '../../session/catalog';
import type { ActiveRuns } from '../../runtime/active-runs';
import type { FollowupRouter } from './followup';
import type { PendingQueue } from './pending-queue';
import {
  QuestionBroker,
  type QuestionContext,
  type QuestionEvent,
  type QuestionPresenter,
  type QuestionRequest,
} from './question-broker';

/** `choice`: an option index of a single question, `text` for its free answer, `form` for a multi-question form. */
type Choice = number | 'text' | 'form';
const MAX_BUTTONS = 10;

/** Lark rendering of agent questions: choice cards in, card callbacks and topic replies out. */
export class UserQuestions {
  private readonly broker: QuestionBroker;

  constructor(private readonly deps: {
    channel: LarkChannel;
    auth?: CallbackAuth;
    activeRuns: ActiveRuns;
    followups: FollowupRouter;
    pending: PendingQueue;
    catalog?: SessionCatalog;
    isTimed(scope: string): boolean;
    blockingTimeoutMs?: number;
  }) {
    const presenter: QuestionPresenter = {
      present: request => this.present(request),
      settle: request => this.settle(request),
      forget: ref => forgetManagedCard(ref),
    };
    this.broker = new QuestionBroker({ presenter, activeRuns: deps.activeRuns, followups: deps.followups,
      pending: deps.pending, catalog: deps.catalog, isTimed: deps.isTimed,
      botOpenId: () => deps.channel.botIdentity?.openId, blockingTimeoutMs: deps.blockingTimeoutMs });
  }

  publish(event: QuestionEvent, context: QuestionContext): Promise<void> {
    return this.broker.publish(event, context);
  }

  /** A topic reply that answers the only waiting blocking question; undefined leaves it as normal input. */
  answerWithText(input: Parameters<QuestionBroker['answerWithText']>[0]): Promise<string | undefined> {
    return this.broker.answerWithText(input);
  }

  async answer(input: {
    evt: CardActionEvent;
    scope: string;
    identity?: SessionCatalogIdentity;
    formValue?: Record<string, unknown>;
  }): Promise<CardActionResponse | void> {
    const payload = input.evt.action.value as Record<string, unknown>;
    const requestId = String(payload.question_id);
    const choice = parseChoice(payload.choice);
    const request = this.broker.get(requestId);
    const answers = request && choice !== undefined ? readAnswers(request.questions, choice, input.formValue) : undefined;
    const result = await this.broker.answer({
      requestId, ref: input.evt.messageId, scope: input.scope, chatId: input.evt.chatId,
      operatorId: input.evt.operator.openId, identity: input.identity, answers: answers ?? [],
      verify: target => choice !== undefined && Boolean(this.deps.auth?.verify(String(payload.bridge_token ?? ''), {
        runId: target.runId, scope: input.scope, chatId: input.evt.chatId, operatorOpenId: input.evt.operator.openId,
        action: action(target, choice), policyFingerprint: input.identity!.policyFingerprint,
      })?.ok),
    });
    if (result.kind === 'settled') return this.response(result.request);
    await this.deps.channel.send(input.evt.chatId, { markdown: result.notice }, {
      replyTo: input.evt.messageId, ...(input.scope !== input.evt.chatId ? { replyInThread: true } : {}),
    });
    return result.request ? this.response(result.request) : undefined;
  }

  close(): void {
    this.broker.close();
  }

  private async present(request: QuestionRequest): Promise<string | undefined> {
    try {
      const sent = await sendManagedCard(this.deps.channel, request.message.chatId, this.card(request), replyOptions(request));
      return sent.messageId;
    } catch (err) {
      log.warn('question', 'card-failed', { scope: request.identity.scopeId, err: String(err) });
      // Keep the question visible when CardKit is unavailable; a topic reply can still answer it.
      await this.deps.channel.send(request.message.chatId, { markdown:
        `${mention(request)}**需要你回复**\n\n${questionsMarkdown(request.questions)}\n\n请直接在本话题回复答案。` }, replyOptions(request));
      return undefined;
    }
  }

  private async settle(request: QuestionRequest): Promise<void> {
    if (!request.ref) return;
    log.info('question', 'update-started', { messageId: request.ref });
    try { await updateManagedCard(this.deps.channel, request.ref, this.card(request)); }
    catch (err) {
      log.warn('question', 'update-failed', { messageId: request.ref, err: String(err) });
      await this.deps.channel.send(request.message.chatId, { markdown: request.status ?? '' }, {
        replyTo: request.ref, ...(request.message.threadId ? { replyInThread: true } : {}),
      });
    }
    log.info('question', 'update-completed', { messageId: request.ref });
  }

  private response(request: QuestionRequest): CardActionResponse {
    // Match the persisted card in the click response so the client keeps the settled form.
    return { card: { type: 'raw', data: this.card(request) } };
  }

  private card(request: QuestionRequest): object {
    const settled = Boolean(request.status);
    const first = request.questions[0]!;
    const title = first.header ?? first.question;
    return {
      schema: '2.0', config: { summary: { content: settled ? '提问回答状态' : `需要你回复：${title.slice(0, 100)}` } },
      header: { title: { tag: 'plain_text', content: settled ? '提问回答状态' : '需要你回复' }, template: settled ? 'blue' : 'orange' },
      body: { elements: settled
        ? [{ tag: 'markdown', content: questionsMarkdown(request.questions) }, { tag: 'markdown', content: request.status }]
        : [
            ...(mention(request) ? [{ tag: 'markdown', content: mention(request) }] : []),
            ...(!this.deps.auth ? [{ tag: 'markdown', content: `${questionsMarkdown(request.questions)}\n\n请在本话题直接回复答案。` }]
              : isSimple(request.questions) ? this.choiceElements(request, first) : this.formElements(request)),
            { tag: 'markdown', content: request.mode === 'blocking'
              ? '任务在等待你的回答。只有一个问题时，也可以直接在本话题回复。'
              : '点击选项即可提交，也可以在本话题直接回复。任务会继续处理不依赖答案的部分。' },
          ] },
    };
  }

  /** One single-select question: each option submits on click. */
  private choiceElements(request: QuestionRequest, question: AgentQuestion): object[] {
    const options = question.options;
    const described = options.some(option => option.description);
    return [
      { tag: 'markdown', content: questionMarkdown(question, described) },
      ...options.slice(0, MAX_BUTTONS).flatMap((option, i) => option.label.length > 100 && !described
        ? [{ tag: 'markdown', content: `${i + 1}. ${option.label}` }, this.button(request, i, `选择第 ${i + 1} 项`)]
        : [this.button(request, i, option.label)]),
      ...(options.length > MAX_BUTTONS
        ? [{ tag: 'markdown', content: `更多选项可在下方填写：\n${options.slice(MAX_BUTTONS).map(o => o.label).join('\n')}` }] : []),
      { tag: 'form', name: 'question_answer', elements: [
        { tag: 'input', name: 'answer', placeholder: { tag: 'plain_text', content: '也可以填写自己的答案' } },
        this.button(request, 'text', '提交填写的答案'),
      ] },
    ];
  }

  /** Several questions or a multi-select: one form submitted together. */
  private formElements(request: QuestionRequest): object[] {
    return [{ tag: 'form', name: 'question_answer', elements: [
      ...request.questions.flatMap((question, i) => [
        { tag: 'markdown', content: `${request.questions.length > 1 ? `**${i + 1}.** ` : ''}${questionMarkdown(question, true)}` },
        ...(question.options.length ? [{
          tag: question.multiSelect ? 'multi_select_static' : 'select_static', name: `q${i}`, width: 'fill',
          placeholder: { tag: 'plain_text', content: question.multiSelect ? '可多选' : '请选择' },
          options: question.options.map((option, j) => ({ text: { tag: 'plain_text', content: option.label.slice(0, 100) }, value: String(j) })),
        }] : []),
        { tag: 'input', name: `t${i}`, placeholder: { tag: 'plain_text', content: question.options.length ? '或填写自己的答案' : '填写答案' } },
      ]),
      this.button(request, 'form', '提交回答'),
    ] }];
  }

  private button(request: QuestionRequest, choice: Choice, label: string): object {
    return {
      tag: 'button', text: { tag: 'plain_text', content: label.slice(0, 100) }, type: choice === 'form' ? 'primary' : 'default',
      ...(choice === 'text' || choice === 'form' ? { name: choice === 'form' ? 'submit_answers' : 'submit_answer', form_action_type: 'submit' } : {}),
      behaviors: [{ type: 'callback', value: { cmd: 'question.answer', question_id: request.id, choice,
        bridge_token: this.deps.auth!.sign({ runId: request.runId, scope: request.identity.scopeId,
          chatId: request.message.chatId, operatorOpenId: request.message.senderId, action: action(request, choice),
          policyFingerprint: request.identity.policyFingerprint, ttlMs: Math.max(1, request.expiresAt - Date.now()) }) } }],
    };
  }
}

function isSimple(questions: readonly AgentQuestion[]): boolean {
  return questions.length === 1 && !questions[0]!.multiSelect;
}

function action(request: QuestionRequest, choice: Choice): string {
  return `question.answer:${request.id}:${choice}`;
}

function parseChoice(value: unknown): Choice | undefined {
  if (value === 'text' || value === 'form') return value;
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/** Map a click or form submission onto one answer list per question; undefined when it does not fit. */
function readAnswers(questions: readonly AgentQuestion[], choice: Choice, form: Record<string, unknown> = {}): string[][] | undefined {
  if (typeof choice === 'number') {
    const label = isSimple(questions) ? questions[0]!.options[choice]?.label : undefined;
    return label ? [[label]] : undefined;
  }
  if (choice === 'text') return isSimple(questions) && typeof form.answer === 'string' ? [[form.answer]] : undefined;
  return questions.map((question, i) => {
    const typed = form[`t${i}`];
    if (typeof typed === 'string' && typed.trim()) return [typed];
    const raw = form[`q${i}`];
    const picked = Array.isArray(raw) ? raw : raw === undefined || raw === '' ? [] : [raw];
    return picked.map(value => question.options[Number(value)]?.label).filter((label): label is string => Boolean(label));
  });
}

function questionMarkdown(question: AgentQuestion, withDescriptions = false): string {
  const head = question.header && question.header !== question.question ? `**${question.header}**\n` : '';
  const options = withDescriptions && question.options.some(option => option.description)
    ? `\n${question.options.map((o, i) => `${i + 1}. ${o.label}${o.description ? `：${o.description}` : ''}`).join('\n')}` : '';
  return `${head}${question.question}${question.multiSelect ? '（可多选）' : ''}${options}`;
}

function questionsMarkdown(questions: readonly AgentQuestion[]): string {
  return questions.map((question, i) => {
    const prefix = questions.length > 1 ? `**${i + 1}.** ` : '';
    const options = question.options.map((o, j) => `${j + 1}. ${o.label}${o.description ? `：${o.description}` : ''}`).join('\n');
    return `${prefix}${questionMarkdown(question)}${options ? `\n${options}` : ''}`;
  }).join('\n\n');
}

function replyOptions(request: QuestionRequest) {
  return { replyTo: request.replyTo, ...(request.message.threadId ? { replyInThread: true } : {}) };
}

function mention(request: QuestionRequest): string {
  return request.mentionUser && /^ou_[a-zA-Z0-9]+$/.test(request.message.senderId) ? `<at id="${request.message.senderId}"></at>` : '';
}
