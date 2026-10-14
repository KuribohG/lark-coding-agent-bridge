import { createHash } from 'node:crypto';
import type { CallbackAuth } from '../card/callback-auth';
import type { CallbackNonceStore } from '../card/callback-store';
import type { InboxLark } from './lark';
import type { InboxService } from './service';
import type { InboxJob } from './types';

export interface InboxCardContext { profile: string; operator: string; chatId: string; threadId?: string }
const text = (content: string) => ({ tag: 'div', text: { tag: 'plain_text', content } });
const button = (label: string, cmd: string, arg?: string) => ({ tag: 'button', text: { tag: 'plain_text', content: label },
  behaviors: [{ type: 'callback', value: { cmd, ...(arg ? { arg } : {}) } }] });
const card = (title: string, elements: object[]) => ({ schema: '2.0', header: { title: { tag: 'plain_text', content: title } }, body: { elements } });
const navigation = () => [button('最近私聊', 'inbox.private'), button('最近群聊', 'inbox.groups'), button('查看待办', 'inbox.pending')];

/** Built-in commands use their own signed actions, independent of an agent run. */
export class InboxCards {
  constructor(private service: InboxService, private lark: InboxLark, private auth: CallbackAuth, private nonces: CallbackNonceStore) {}

  accepts(ctx: InboxCardContext): boolean {
    const c = this.service.config;
    return ctx.profile === c.executorProfile && ctx.operator === c.ownerOpenId && ctx.chatId === c.destination.chatId && ctx.threadId === c.destination.threadId;
  }
  private expected(action: string, target: string) {
    const c = this.service.config;
    return { runId: 'inbox', scope: `${c.destination.chatId}:${c.destination.threadId}`, chatId: c.destination.chatId,
      operatorOpenId: c.ownerOpenId, action: JSON.stringify([action, target]),
      policyFingerprint: createHash('sha256').update(JSON.stringify(c)).digest('hex') };
  }
  private action(label: string, action: string, target: string, ttlMs = 30 * 60_000): object {
    const token = this.auth.sign({ ...this.expected(action, target), ttlMs });
    return button(label, 'inbox.action', `${action} ${Buffer.from(target).toString('base64url')} ${token}`);
  }
  reminder(job: InboxJob, content: string): object {
    return card('会话助理 · 待办', [text(content), ...this.decisions(job), button('处理其他会话', 'inbox.open')]);
  }
  private decisions(job: InboxJob): object[] {
    return [['立即处理', 'process'], ['我来处理', 'claim'], ['忽略', 'ignore']].map(([label, action]) =>
      this.action(label!, action!, job.id, 7 * 86400_000));
  }
  async handle(args: string, ctx: InboxCardContext): Promise<void> {
    if (!this.accepts(ctx)) return;
    if (!args || args === 'open') {
      await this.lark.replyTopic({ card: card('会话助理 · 处理会话', [text('选择私聊或群聊，点选会话后整理近期消息。分析和建议回复会发到本话题，标明来源名称与 ID。'), ...navigation()]) });
      return;
    }
    if (args === 'private' || args === 'groups') { await this.recent(args === 'private' ? 'p2p' : 'group'); return; }
    if (args === 'pending') { await this.pending(0); return; }
    const parts = args.split(' ');
    if (parts.length !== 4 || parts[0] !== 'action' || parts[2]!.length > 16_000) throw new Error('无效的助理操作，请重新发送 /inbox');
    const [, action, encoded, token] = parts;
    const target = Buffer.from(encoded!, 'base64url').toString('utf8');
    const verified = this.auth.verify(token!, this.expected(action!, target));
    if (!verified.ok) throw new Error('卡片操作已失效或已经处理，请点击「查看待办」或重新发送 /inbox');
    await this.nonces.flush();
    if (action === 'page') {
      const [type, page] = JSON.parse(target) as unknown[];
      if ((type !== 'p2p' && type !== 'group') || typeof page !== 'string') throw new Error('无效的会话分页');
      await this.recent(type, page);
    } else if (action === 'pending') {
      const offset = Number(target);
      if (!Number.isInteger(offset) || offset < 0 || offset > 500) throw new Error('无效的待办分页');
      await this.pending(offset);
    } else if (action === 'choose') {
      const job = await this.service.manual(target);
      await this.lark.replyTopic({ text: `已提交分析：${job.source.name}\n来源会话 ID：${job.source.chatId}\n待办：${job.id}\n分析结果会继续发到本话题。` });
    } else if (['process', 'claim', 'ignore'].includes(action!)) {
      await this.service.decide(target, action!, ctx.operator);
      const job = this.service.list(500).find(j => j.id === target);
      await this.lark.replyTopic({ text: `待办已更新：${job?.source.name ?? target}\n来源会话 ID：${job?.source.chatId ?? ''}\n状态：${job ? stateName(job.state) : '已处理'}` });
    } else throw new Error('无效的助理操作');
  }
  private async recent(type: 'p2p' | 'group', page = ''): Promise<void> {
    const result = await this.lark.recent(type, page);
    const elements: object[] = [text('按最近活跃排序。点「分析此会话」后读取近期上下文并生成草稿。'), ...navigation()];
    for (const c of result.chats) elements.push(text(`${c.name}\n会话 ID：${c.id}`), this.action('分析此会话', 'choose', c.id));
    if (!result.chats.length) elements.push(text(result.next ? '本页没有可展示的会话，可继续下一页。' : '没有更多会话。'));
    if (result.next) elements.push(this.action('下一页', 'page', JSON.stringify([type, result.next])));
    await this.lark.replyTopic({ card: card(`会话助理 · 最近${type === 'p2p' ? '私聊' : '群聊'}`, elements) });
  }
  private async pending(offset: number): Promise<void> {
    const jobs = this.service.list(500).filter(j => !['done', 'ignored', 'claimed'].includes(j.state));
    const elements: object[] = [...navigation()];
    for (const j of jobs.slice(offset, offset + 5)) elements.push(text(`${j.source.name}\n会话 ID：${j.source.chatId}\n状态：${stateName(j.state)}`), ...this.decisions(j));
    if (!jobs.length) elements.push(text('当前没有待办。'));
    if (jobs.length > offset + 5) elements.push(this.action('下一页待办', 'pending', String(offset + 5)));
    await this.lark.replyTopic({ card: card('会话助理 · 待办列表', elements) });
  }
}

function stateName(state: InboxJob['state']): string {
  return { notifying: '等待提醒', waiting: '等待决定', queued: '已排队', running: '分析中', ready: '结果待发送', done: '已完成', ignored: '已忽略', claimed: '你来处理', failed: '分析未完成，可重试' }[state];
}
