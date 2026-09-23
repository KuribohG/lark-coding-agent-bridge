import type { CommandContext } from './index';
import { modelEnvironment, resolveRunModelSettings } from '../runtime/model-settings';
import { modelRunArguments, resolveModelSettings, type ModelSettings } from '../agent/model-settings';
import { timedRuns } from '../runtime/timed-runs';
import { parseRunDeadline } from '../runtime/run-deadline';
import { timedRunCard, timedRunForm } from '../card/timed-run-card';
import { sendManagedCard } from '../card/managed';
import { canRunAdminCommand } from '../policy/access';
import { builtinRunDefaults, parseRunSettings, readRunDefaults, saveRunDefaults } from '../runtime/run-defaults';

export async function handleRun(args: string, ctx: CommandContext): Promise<void> {
  const opts = { replyTo: ctx.msg.messageId, ...(ctx.chatMode === 'topic' ? { replyInThread: true } : {}) };
  const reply = (markdown: string) => ctx.channel.send(ctx.msg.chatId, { markdown }, opts);
  try {
    const store = await timedRuns(ctx.controls);
    const words = args.trim().split(/\s+/);
    const [action, id] = words;
    const defaultsCommand = action === 'defaults' ? words.join(' ') : '';
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
    const defaults = defaultsCommand === 'defaults reset' ? builtinRunDefaults() : await readRunDefaults(ctx.controls);
    const agentKind = ctx.controls.profileConfig.agentKind;
    if (!args.trim() || args.trim() === 'defaults') {
      await sendManagedCard(ctx.channel, ctx.msg.chatId, timedRunForm(ctx.scope,
        agentKind, await modelEnvironment(ctx.controls), defaults, args.trim() === 'defaults'), opts);
      return;
    }
    const savingDefaults = action === 'defaults';
    if (savingDefaults && !canRunAdminCommand(ctx.controls.profileConfig, ctx.controls, ctx.msg.senderId).ok) {
      throw new Error('修改此 bot 的限时任务默认值仅 owner/管理员可用。');
    }
    let form: Record<string, unknown>;
    if ((action === 'submit' || defaultsCommand === 'defaults save') && ctx.fromCardAction) form = ctx.formValue ?? {};
    else if (savingDefaults) {
      if (defaultsCommand === 'defaults reset') {
        await saveRunDefaults(ctx.controls, builtinRunDefaults());
        await reply('已恢复此 bot 的 /run 内置默认值（2h、提前 5 分钟、模型/强度沿用对话）。');
        return;
      }
      form = parseFlags(args.trim().slice('defaults'.length).trim());
    } else if (!args.trimStart().startsWith('--')) {
      form = { task: args };
    } else {
      const separator = /(?:^|\s)--(?:\s|$)/.exec(args);
      if (!separator) throw new Error('普通任务直接用 /run 任务内容；带运行参数时用 /run --effort high -- 任务内容。');
      form = { ...parseFlags(args.slice(0, separator.index).trim()), task: args.slice(separator.index + separator[0].length) };
    }
    const input = parseRunSettings(form, defaults, agentKind);
    if (savingDefaults) {
      const checked = resolveModelSettings({}, input, await modelEnvironment(ctx.controls));
      if (input.reasoningEffort && checked.reasoningEffort !== input.reasoningEffort) throw new Error(checked.notice);
      await saveRunDefaults(ctx.controls, input);
      await reply(`已保存此 bot 的 /run 默认值：\n截止：${input.until}（${input.timeZone}），提前 ${input.marginMinutes} 分钟停止。\n模型：${input.model ?? '沿用当前对话'}；思考强度：${input.reasoningEffort ?? '沿用当前对话'}。\n以后发送 \`/run 具体任务\` 即可生成预览。已创建的任务保持原设置。`);
      return;
    }
    const task = String(form.task ?? '').trim();
    if (!task || task.length > 10_000) throw new Error('请填写 1～10000 字符的任务目标。');
    const { timeZone, marginMinutes: margin } = input;
    const now = Date.now();
    const deadlineAt = parseRunDeadline(input.until, timeZone, now);
    const stopAt = Math.floor(deadlineAt - margin * 60_000);
    if (stopAt - now < 10_000) throw new Error('扣除安全余量后不足 10 秒，请调整停止时间。');
    const patch: ModelSettings = {};
    if (input.model) patch.model = input.model;
    const effort = input.reasoningEffort;
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

function parseFlags(value: string): Record<string, unknown> {
  if (!value) return {};
  const flags = value.split(/\s+/);
  const names: Record<string, string> = { '--until': 'until', '--tz': 'time_zone', '--margin': 'margin', '--model': 'model', '--effort': 'effort' };
  const form: Record<string, unknown> = {};
  for (let i = 0; i < flags.length; i += 2) {
    const name = names[flags[i]!];
    if (!name || !flags[i + 1] || flags[i + 1]!.startsWith('--')) throw new Error('无法识别限时任务参数。');
    form[name] = flags[i + 1];
  }
  return form;
}
