import type { CommandContext } from './types';
import { canRunAdminCommand } from '../policy/access';
import { saveModelPreferences } from '../config/config-ops';
import { validateModelId } from '../agent/models';
import { parseEffort, resolveModelSettings, type ModelSettings } from '../agent/model-settings';
import {
  modelEnvironment,
  modelProviderOptions,
  resolveRunModelSettings,
  scopePreferences,
} from '../runtime/model-settings';
import { modelFormCard, modelSettingsSummary } from '../card/model-card';
import { sendManagedCard } from '../card/managed';
import {
  AUTO_MODEL_PROVIDER,
  composeProviderSelection,
} from '../model-provider/provider';

function modelScopeLabel(ctx: CommandContext): string {
  return ctx.chatMode === 'topic' ? '当前话题' : ctx.chatMode === 'p2p' ? '当前私聊' : '当前群聊';
}

function replyOptions(ctx: CommandContext) {
  return { replyTo: ctx.msg.messageId, ...(ctx.chatMode === 'topic' && ctx.msg.threadId ? { replyInThread: true as const } : {}) };
}

export async function handleModelCommand(field: 'model' | 'reasoningEffort', args: string, ctx: CommandContext): Promise<void> {
  const reply = (markdown: string) => ctx.channel.send(ctx.msg.chatId, { markdown }, replyOptions(ctx));
  let saved = false;
  try {
    const agentKind = ctx.agentKind ?? ctx.controls.profileConfig.agentKind;
    const [store, environment, providers] = await Promise.all([
      scopePreferences(ctx.controls),
      modelEnvironment(ctx.controls, agentKind, !args.trim()),
      modelProviderOptions(ctx.controls, agentKind),
    ]);
    const overrides = store.get(agentKind, ctx.scope);
    if (!args.trim()) {
      const resolved = resolveModelSettings(ctx.controls.profileConfig.preferences, overrides, environment);
      await sendManagedCard(ctx.channel, ctx.msg.chatId, modelFormCard({
        agentKind, scope: ctx.scope, scopeLabel: modelScopeLabel(ctx), overrides, resolved, environment, providers,
      }), replyOptions(ctx));
      return;
    }
    let target: 'chat' | 'profile' = 'chat';
    const patch: ModelSettings = {};
    if (args === 'submit' && ctx.fromCardAction) {
      const form = ctx.formValue ?? {};
      const picked = form.model_pick;
      const model = picked === '__provider_default__'
        ? 'default'
        : picked && picked !== '__manual__'
          ? String(picked)
          : String(form.model ?? 'default').trim();
      const qualified = composeProviderSelection(
        providers,
        String(form.provider_pick ?? AUTO_MODEL_PROVIDER),
        model,
      );
      patch.model = qualified && qualified !== 'default' ? validateModelId(qualified) : undefined;
      patch.reasoningEffort = parseEffort(form.reasoning_effort, agentKind);
    } else {
      const match = /^(\S+)(?:\s+--scope\s+(chat|profile))?$/.exec(args.trim());
      if (!match) throw new Error('用法：/model <模型名|default> 或 /effort <强度|default>，可加 --scope profile。');
      target = match[2] === 'profile' ? 'profile' : 'chat';
      if (field === 'model') patch.model = match[1] === 'default' ? undefined : validateModelId(match[1]!);
      else patch.reasoningEffort = parseEffort(match[1], agentKind);
    }
    if (target === 'profile' && !canRunAdminCommand(ctx.controls.profileConfig, ctx.controls, ctx.msg.senderId).ok) {
      await reply('修改 bot 默认值仅 owner/管理员可用。');
      return;
    }
    const profileDefaults = agentKind === ctx.controls.profileConfig.agentKind
      ? ctx.controls.profileConfig.preferences
      : { ...ctx.controls.profileConfig.preferences, model: undefined, reasoningEffort: undefined };
    const next = resolveModelSettings(
      target === 'profile' ? { ...profileDefaults, ...patch } : profileDefaults,
      target === 'profile' ? {} : { ...overrides, ...patch },
      environment,
    );
    if (patch.reasoningEffort && next.reasoningEffort !== patch.reasoningEffort) throw new Error(next.notice);
    if (target === 'profile') {
      if (agentKind !== ctx.controls.profileConfig.agentKind) {
        throw new Error('profile 默认模型只能为 profile 默认执行引擎设置；当前上下文使用覆盖引擎，请保存到当前聊天。');
      }
      await saveModelPreferences(ctx.controls, patch);
    }
    else await store.update(agentKind, ctx.scope, patch);
    saved = true;
    await reply(`已保存到${target === 'profile' ? '此 bot 默认值（已有聊天覆盖保留）' : modelScopeLabel(ctx)}。\n${modelSettingsSummary(next)}\n下一轮新任务生效，当前任务继续原设置。`);
  } catch (err) {
    await reply(`${saved ? '设置已保存，但发送回执失败' : '设置未保存'}：${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function modelStatus(ctx: CommandContext): Promise<string> {
  const agentKind = ctx.agentKind ?? ctx.controls.profileConfig.agentKind;
  const next = await resolveRunModelSettings(ctx.controls, ctx.scope, undefined, agentKind);
  const active = ctx.activeRuns.get(ctx.scope)?.modelSettings;
  return `**下一轮 · ${modelScopeLabel(ctx)}**\n${modelSettingsSummary(next)}` +
    (active ? `\n**当前任务**：\`${active.model ?? 'CLI 默认'}\` / \`${active.reasoningEffort ?? 'CLI 默认'}\`` : '');
}
