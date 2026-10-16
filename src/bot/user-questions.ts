import { randomUUID } from 'node:crypto';
import type { CardActionEvent, LarkChannel, NormalizedMessage } from '@larksuite/channel';
import type { AgentEvent } from '../agent/types';
import { buildAgentPrompt } from '../agent/prompt';
import type { CallbackAuth } from '../card/callback-auth';
import { forgetManagedCard, sendManagedCard, updateManagedCard } from '../card/managed';
import { log } from '../core/logger';
import { sessionCatalogKey, type SessionCatalog, type SessionCatalogIdentity } from '../session/catalog';
import type { ActiveRuns } from './active-runs';
import type { FollowupRouter } from './followup';
import type { PendingQueue } from './pending-queue';

type QuestionEvent = Extract<AgentEvent, { type: 'user_input' }>;
interface QuestionContext {
  runId: string;
  identity: SessionCatalogIdentity;
  message: NormalizedMessage;
  replyTo: string;
  mentionUser: boolean;
  allowQueue: boolean;
  isCancelled(): boolean;
}
interface Entry extends QuestionContext {
  id: string;
  threadId: string;
  title: string;
  options: string[];
  generation: number;
  expiresAt: number;
  messageId?: string;
  status?: string;
}
const TTL_MS = 24 * 60 * 60 * 1000;

/** Native async questions have their own delivery, independent of progress/COT rendering. */
export class UserQuestions {
  private readonly entries = new Map<string, Entry>();
  private closing = false;
  constructor(private readonly deps: {
    channel: LarkChannel;
    auth?: CallbackAuth;
    activeRuns: ActiveRuns;
    followups: FollowupRouter;
    pending: PendingQueue;
    catalog?: SessionCatalog;
    isTimed(scope: string): boolean;
  }) {}

  async publish(event: QuestionEvent, context: QuestionContext): Promise<void> {
    this.prune();
    for (const question of event.questions) {
      if (this.closing || context.isCancelled()) return;
      const entry: Entry = { ...context, id: randomUUID(), threadId: event.threadId,
        title: question.title, options: question.options ?? [],
        generation: this.deps.activeRuns.generation(context.identity.scopeId), expiresAt: Date.now() + TTL_MS };
      this.entries.set(entry.id, entry);
      try {
        const sent = await sendManagedCard(this.deps.channel, entry.message.chatId, this.card(entry), this.replyOptions(entry));
        entry.messageId = sent.messageId;
        if (this.closing) forgetManagedCard(sent.messageId);
        log.info('question', 'sent', { scope: entry.identity.scopeId, runId: entry.runId, messageId: sent.messageId });
      } catch (err) {
        this.entries.delete(entry.id);
        log.warn('question', 'card-failed', { scope: entry.identity.scopeId, err: String(err) });
        // Keep the question visible when CardKit is unavailable.
        await this.deps.channel.send(entry.message.chatId, { markdown:
          `${this.mention(entry)}**需要你回复**\n\n${entry.title}\n\n${entry.options.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n\n请直接在本话题回复答案。` }, this.replyOptions(entry));
      }
    }
  }

  async answer(input: {
    evt: CardActionEvent;
    scope: string;
    identity?: SessionCatalogIdentity;
    formValue?: Record<string, unknown>;
  }): Promise<void> {
    this.prune();
    const payload = input.evt.action.value as Record<string, unknown>;
    const entry = this.entries.get(String(payload.question_id));
    const notice = async (markdown: string) => {
      await this.deps.channel.send(input.evt.chatId, { markdown }, {
        replyTo: input.evt.messageId, ...(input.scope !== input.evt.chatId ? { replyInThread: true } : {}),
      });
    };
    if (!entry || entry.messageId !== input.evt.messageId || entry.identity.scopeId !== input.scope ||
        entry.message.chatId !== input.evt.chatId || entry.message.senderId !== input.evt.operator.openId) {
      await notice('这张提问卡片已失效，或不属于你；请在原话题直接回复。');
      return;
    }
    if (entry.status) { await notice(entry.status); return; }
    const active = this.deps.activeRuns.get(input.scope);
    if (active && active.run.runId !== entry.runId) {
      await this.finish(entry, '当前话题已有新的任务，请直接回复并说明这条答案对应的问题。');
      return;
    }
    if (entry.isCancelled() || !input.identity || sessionCatalogKey(input.identity) !== sessionCatalogKey(entry.identity) ||
        this.deps.activeRuns.generation(input.scope) !== entry.generation ||
        this.deps.catalog?.activeFor(input.identity)?.threadId !== entry.threadId) {
      await this.finish(entry, '原任务已停止或会话已切换，请在原话题重新说明你的选择。');
      return;
    }
    const choice = payload.choice;
    const answer = choice === 'text' ? input.formValue?.answer :
      Number.isInteger(choice) && typeof choice === 'number' ? entry.options[choice] : undefined;
    if (typeof answer !== 'string' || !answer.trim() || answer.length > 16_000) {
      await notice('请先填写答案，或点击一个有效选项。');
      return;
    }
    const verified = this.deps.auth?.verify(String(payload.bridge_token ?? ''), {
      runId: entry.runId, scope: input.scope, chatId: input.evt.chatId, operatorOpenId: input.evt.operator.openId,
      action: this.action(entry, choice as number | 'text'), policyFingerprint: input.identity.policyFingerprint,
    });
    if (!verified?.ok) { await notice('按钮校验未通过，请在原话题直接回复答案。'); return; }
    // Lock all choices for this question before any asynchronous delivery.
    entry.status = '正在提交你的回答。';
    const content = `对之前提问的回答：\n问题：${entry.title}\n回答：${answer.trim()}`;
    const messageId = `${entry.messageId}:${entry.id}`;
    const result = await this.deps.followups.deliver({
      scope: input.scope, messageId, activeRuns: this.deps.activeRuns,
      prepare: async () => buildAgentPrompt({
        context: { chatId: entry.message.chatId, chatType: entry.message.chatType,
          threadId: entry.message.threadId, senderId: input.evt.operator.openId, senderType: 'user',
          botOpenId: this.deps.channel.botIdentity?.openId, messageIds: [entry.messageId!], source: 'card' },
        instructions: ['这是用户对先前提问的回答。请结合当前任务和已完成进度处理。'], userInput: content,
      }),
    });
    let status: string;
    if (result === 'accepted') status = `已提交：${answer.trim()}\n已送入当前任务，等待模型处理。`;
    else if (result === 'unknown') status = '未收到接收确认，无法确定答案是否送达；没有自动重发。';
    else if (result === 'cancelled' || this.deps.activeRuns.generation(input.scope) !== entry.generation) {
      status = '当前任务已停止，答案未另起任务执行。';
    } else if (!entry.allowQueue || this.deps.isTimed(input.scope)) {
      status = '限时任务已结束或无法接收回答，请在原话题手动继续。';
    } else if (this.deps.catalog?.activeFor(input.identity)?.threadId !== entry.threadId) {
      status = '会话已切换，答案未发送；请在原话题重新说明你的选择。';
    } else {
      this.deps.pending.push(input.scope, { ...entry.message, messageId, content,
        resources: [], mentions: [], mentionedBot: false, mentionAll: false,
        rawContentType: 'card_action', createTime: Date.now() });
      status = `已提交：${answer.trim()}\n已排队，将在原会话继续处理。`;
    }
    log.info('question', 'answered', { scope: input.scope, runId: entry.runId, delivery: result });
    await this.finish(entry, status);
  }

  private async finish(entry: Entry, status: string): Promise<void> {
    entry.status = status;
    if (!entry.messageId) return;
    try { await updateManagedCard(this.deps.channel, entry.messageId, this.card(entry)); }
    catch (err) {
      log.warn('question', 'update-failed', { messageId: entry.messageId, err: String(err) });
      await this.deps.channel.send(entry.message.chatId, { markdown: status }, {
        replyTo: entry.messageId, ...(entry.message.threadId ? { replyInThread: true } : {}),
      });
    }
  }

  private action(entry: Entry, choice: number | 'text'): string { return `question.answer:${entry.id}:${choice}`; }
  private replyOptions(entry: Entry) {
    return { replyTo: entry.replyTo, ...(entry.message.threadId ? { replyInThread: true } : {}) };
  }
  private mention(entry: Entry): string {
    return entry.mentionUser && /^ou_[a-zA-Z0-9]+$/.test(entry.message.senderId) ? `<at id="${entry.message.senderId}"></at> ` : '';
  }
  private card(entry: Entry): object {
    const button = (choice: number | 'text', label: string): object => ({
      tag: 'button', text: { tag: 'plain_text', content: label.slice(0, 100) }, type: 'default',
      ...(choice === 'text' ? { name: 'submit_answer', form_action_type: 'submit' } : {}),
      behaviors: [{ type: 'callback', value: { cmd: 'question.answer', question_id: entry.id, choice,
        bridge_token: this.deps.auth!.sign({ runId: entry.runId, scope: entry.identity.scopeId,
          chatId: entry.message.chatId, operatorOpenId: entry.message.senderId, action: this.action(entry, choice),
          policyFingerprint: entry.identity.policyFingerprint, ttlMs: Math.max(1, entry.expiresAt - Date.now()) }) } }],
    });
    return {
      schema: '2.0', config: { summary: { content: entry.status ? '提问回答状态' : `需要你回复：${entry.title.slice(0, 100)}` } },
      header: { title: { tag: 'plain_text', content: entry.status ? '提问回答状态' : '需要你回复' }, template: entry.status ? 'blue' : 'orange' },
      body: { elements: [
        { tag: 'markdown', content: `${entry.status ? '' : this.mention(entry)}${entry.title}` },
        ...(entry.status ? [{ tag: 'markdown', content: entry.status }] : this.deps.auth ? [
          ...entry.options.slice(0, 10).flatMap((option, i) => option.length > 100
            ? [{ tag: 'markdown', content: `${i + 1}. ${option}` }, button(i, `选择第 ${i + 1} 项`)] : [button(i, option)]),
          ...(entry.options.length > 10 ? [{ tag: 'markdown', content: `更多选项可在下方填写：\n${entry.options.slice(10).join('\n')}` }] : []),
          { tag: 'form', name: 'question_answer', elements: [
            { tag: 'input', name: 'answer', placeholder: { tag: 'plain_text', content: '也可以填写自己的答案' } },
            button('text', '提交填写的答案'),
          ] },
          { tag: 'markdown', content: '点击选项即可提交，也可以在本话题直接回复。任务会继续处理不依赖答案的部分。' },
        ] : [{ tag: 'markdown', content: `${entry.options.join('\n')}\n\n请在本话题直接回复答案。` }]),
      ] },
    };
  }

  close(): void {
    this.closing = true;
    for (const entry of this.entries.values()) if (entry.messageId) forgetManagedCard(entry.messageId);
    this.entries.clear();
  }
  private prune(): void {
    for (const [id, entry] of this.entries) {
      if (entry.expiresAt <= Date.now() || this.entries.size >= 256) {
        if (entry.messageId) forgetManagedCard(entry.messageId);
        this.entries.delete(id);
      }
    }
  }
}
