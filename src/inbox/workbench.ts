import type { InboxService } from './service';
import type { WorkItemService } from '../work-items/service';
import type { InboxLark } from './lark';
import { inboxMode, intakeScope, type InboxMode, type IntakeScope } from './config';
import { guiContent, guiSummary } from './presentation';
import { obj } from './values';

/** Shared by the bundled console and optional hosted GUI; neither can send replies. */
export async function executeInboxCommand(service: WorkItemService & { manual?: InboxService['manual'] }, lark: InboxLark | undefined, input: unknown,
  changeMode?: (mode: InboxMode) => Promise<void>, changeScope?: (scope: IntakeScope) => Promise<void>): Promise<unknown> {
  const command = obj(input);
  if (typeof command.id !== 'string' || !/^[\da-f-]{36}$/i.test(command.id) ||
    typeof command.action !== 'string' || typeof command.target !== 'string' || command.target.length > 64000) throw new Error('无效工作台操作');
  const owner = service.config.ownerOpenId;
  if (command.action === 'mode') {
    if (!changeMode || !['off', 'on'].includes(command.target)) throw new Error('无效运行模式');
    await changeMode(command.target as InboxMode); return { mode: inboxMode(service.config) };
  }
  if (command.action === 'scope') {
    if (!changeScope || !['private', 'private_mentions', 'all'].includes(command.target)) throw new Error('无效接收范围');
    await changeScope(command.target as IntakeScope);
    return { intakeScope: intakeScope({ watchPrivate: false, watchMentions: false, ...service.config }) };
  }
  if (command.action === 'batch') {
    await service.batchReview(JSON.parse(command.target), owner, command.id); return { ok: true };
  }
  if (command.action === 'review') {
    const job = await service.review(JSON.parse(command.target), owner, command.id);
    return { ...guiSummary(job), ...guiContent(job) };
  }
  if (!service.config.enabled && command.action !== 'detail') throw new Error('助理已关闭，请先开启助理');
  if (command.action === 'browse') {
    if (!lark) throw new Error('此来源不读取飞书会话');
    const target = obj(JSON.parse(command.target));
    if ((target.type !== 'p2p' && target.type !== 'group') || typeof target.page !== 'string') throw new Error('无效会话分页');
    await lark.checkOwner(owner); return lark.recent(target.type, target.page);
  }
  if (command.action === 'manual') {
    if (!service.manual) throw new Error('此来源不支持手动选择会话');
    return { id: (await service.manual(command.target, command.id)).id };
  }
  const job = service.get(command.target);
  if (!job || job.ownerOpenId !== owner) throw new Error('待办不存在或已归档');
  if (command.action === 'detail') return { ...guiSummary(job), ...guiContent(job) };
  await service.decide(job.id, command.action, owner); return { id: job.id };
}
