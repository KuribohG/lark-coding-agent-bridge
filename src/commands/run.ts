import type { CommandContext } from './index';
import { modelEnvironment, resolveRunModelSettings } from '../runtime/model-settings';
import { modelRunArguments, parseEffort, type ModelSettings } from '../agent/model-settings';
import { validateModelId } from '../agent/models';
import { timedRuns } from '../runtime/timed-runs';
import { parseRunDeadline } from '../runtime/run-deadline';
import { timedRunCard, timedRunForm } from '../card/timed-run-card';
import { sendManagedCard } from '../card/managed';
import { canRunAdminCommand } from '../policy/access';

export async function handleRun(args: string, ctx: CommandContext): Promise<void> {
  const opts = { replyTo: ctx.msg.messageId, ...(ctx.chatMode === 'topic' ? { replyInThread: true } : {}) };
  const reply = (markdown: string) => ctx.channel.send(ctx.msg.chatId, { markdown }, opts);
  try {
    const store = await timedRuns(ctx.controls);
    const [action, id] = args.trim().split(/\s+/);
    if (!args.trim()) {
      await sendManagedCard(ctx.channel, ctx.msg.chatId, timedRunForm(ctx.scope,
        ctx.controls.profileConfig.agentKind, await modelEnvironment(ctx.controls),
        store.latest(ctx.scope)?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone), opts);
      return;
    }
    if (['status', 'start', 'stop'].includes(action!)) {
      const activeId = action === 'start' ? undefined : ctx.controls.activeTimedRun?.(ctx.scope);
      const job = id ? store.get(id) : activeId ? store.get(activeId) : store.latest(ctx.scope);
      if (!job || job.scope !== ctx.scope) throw new Error('当前话题/聊天没有对应的限时任务。');
      if (action === 'status') {
        await sendManagedCard(ctx.channel, ctx.msg.chatId, timedRunCard(job), opts);
        return;
      }
      if (job.owner !== ctx.msg.senderId && !(action === 'stop' && canRunAdminCommand(ctx.controls.profileConfig, ctx.controls, ctx.msg.senderId).ok)) {
        throw new Error('仅任务创建者可启动；创建者或管理员可停止。');
      }
      if (action === 'stop') {
        ctx.controls.cancelTimedRun?.(ctx.scope, job.id);
        if (job.state === 'draft') await store.transition(job.id, ['draft'], 'stopped');
        await reply('已请求取消 / 停止限时任务，不会自动续跑。');
        return;
      }
      if (!ctx.controls.launchTimedRun) throw new Error('当前运行环境不支持限时任务。');
      // The launcher atomically reserves the scope before its first await.
      await ctx.controls.launchTimedRun(job, ctx.msg);
      return;
    }
    let form: Record<string, unknown>;
    if (action === 'submit' && ctx.fromCardAction) form = ctx.formValue ?? {};
    else {
      const split = args.indexOf(' -- ');
      if (split < 0) throw new Error('用法：/run 打开表单，或 /run --until 01:00 --tz Asia/Shanghai --effort ultra -- 任务内容');
      form = { task: args.slice(split + 4) };
      const flags = args.slice(0, split).trim().split(/\s+/);
      const names: Record<string, string> = { '--until': 'until', '--tz': 'time_zone', '--margin': 'margin', '--model': 'model', '--effort': 'effort' };
      for (let i = 0; i < flags.length; i += 2) {
        const name = names[flags[i]!];
        if (!name || !flags[i + 1]) throw new Error('无法识别限时任务参数。');
        form[name] = flags[i + 1];
      }
    }
    const task = String(form.task ?? '').trim();
    if (!task || task.length > 10_000) throw new Error('请填写 1～10000 字符的任务目标。');
    const timeZone = String(form.time_zone ?? Intl.DateTimeFormat().resolvedOptions().timeZone).trim();
    const now = Date.now();
    const deadlineAt = parseRunDeadline(String(form.until ?? '').trim(), timeZone, now);
    const margin = Number(form.margin ?? 5);
    if (!Number.isFinite(margin) || margin < 0 || margin > 120) throw new Error('安全余量应为 0～120 分钟。');
    const stopAt = Math.floor(deadlineAt - margin * 60_000);
    if (stopAt - now < 10_000) throw new Error('扣除安全余量后不足 10 秒，请调整停止时间。');
    const patch: ModelSettings = {};
    const model = String(form.model_pick && form.model_pick !== '__manual__' ? form.model_pick : form.model ?? '').trim();
    if (form.model_pick === '__manual__' && !model) throw new Error('请填写本次使用的模型名。');
    if (model && model !== 'default') patch.model = validateModelId(model);
    const effort = parseEffort(form.effort, ctx.controls.profileConfig.agentKind);
    if (effort) patch.reasoningEffort = effort;
    const settings = await resolveRunModelSettings(ctx.controls, ctx.scope, patch);
    if (effort && settings.reasoningEffort !== effort) throw new Error(settings.notice);
    const job = await store.create({
      scope: ctx.scope, owner: ctx.msg.senderId, task, timeZone, deadlineAt, stopAt,
      windDownAt: Math.max(now, stopAt - 5 * 60_000), modelSettings: modelRunArguments(settings),
    });
    await sendManagedCard(ctx.channel, ctx.msg.chatId, timedRunCard(job), opts);
  } catch (err) {
    await reply(`限时任务：${err instanceof Error ? err.message : String(err)}`);
  }
}
