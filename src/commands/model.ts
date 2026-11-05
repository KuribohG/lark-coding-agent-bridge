import type { AgentKind } from '../config/profile-schema';
import type { CommandContext } from './types';
import { validateModelId } from '../agent/models';
import {
  availableEfforts,
  parseEffort,
  resolveModelSettings,
  type ModelSettings,
} from '../agent/model-settings';
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

const MODEL_USAGE =
  '用法：/model <模型名|default> [强度] [任务]；/effort <强度|default>；全局默认请用 /config run。';

interface ModelCommandArguments {
  model: string;
  effort?: string;
  /** Text after the model and effort, submitted as a normal run. */
  prompt?: string;
}

/**
 * Parse `/model <model> [effort] [prompt...]`. The prompt keeps its original
 * whitespace; only the first one or two tokens are interpreted.
 */
function parseModelCommandArguments(args: string, agentKind: AgentKind): ModelCommandArguments {
  const trimmed = args.trim();
  const first = /^\S+/.exec(trimmed);
  if (!first) throw new Error(MODEL_USAGE);
  const rest = trimmed.slice(first[0].length).trimStart();
  if (!rest) return { model: first[0] };

  const second = /^\S+/.exec(rest)!;
  const effort = second[0];
  if (effort !== 'default' && !availableEfforts(agentKind).includes(effort)) {
    throw new Error(MODEL_USAGE);
  }
  const prompt = rest.slice(effort.length).trimStart();
  return { model: first[0], effort, ...(prompt ? { prompt } : {}) };
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
    const activeProvider = await ctx.agent.modelProviderState?.();
    if (!args.trim()) {
      const resolved = resolveModelSettings(ctx.controls.profileConfig.preferences, overrides, environment);
      await sendManagedCard(ctx.channel, ctx.msg.chatId, modelFormCard({
        agentKind, scope: ctx.scope, scopeLabel: modelScopeLabel(ctx), overrides, resolved, environment, providers, activeProvider,
      }), replyOptions(ctx));
      return;
    }
    const patch: ModelSettings = {};
    let followUpPrompt: string | undefined;
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
    } else if (field === 'model') {
      const parsed = parseModelCommandArguments(args, agentKind);
      patch.model = parsed.model === 'default' ? undefined : validateModelId(parsed.model);
      patch.reasoningEffort = parseEffort(parsed.effort, agentKind);
      followUpPrompt = parsed.prompt;
    } else {
      const match = /^(\S+)$/.exec(args.trim());
      if (!match) throw new Error('用法：/effort <强度|default>；全局默认请用 /config run。');
      patch.reasoningEffort = parseEffort(match[1], agentKind);
    }
    const profileDefaults = agentKind === ctx.controls.profileConfig.agentKind
      ? ctx.controls.profileConfig.preferences
      : { ...ctx.controls.profileConfig.preferences, model: undefined, reasoningEffort: undefined };
    const next = resolveModelSettings(
      profileDefaults,
      { ...overrides, ...patch },
      environment,
    );
    if (patch.reasoningEffort && next.reasoningEffort !== patch.reasoningEffort) throw new Error(next.notice);
    const requestedProvider = providers.find(provider => next.model?.startsWith(`${provider.id}/`) || next.model === provider.defaultModel);
    if (activeProvider?.fixedUntilRestart && requestedProvider && requestedProvider.id !== activeProvider.id) {
      await reply(`Provider 未切换，设置未保存。当前继续使用 ${activeProvider.displayName}；请修改 bridge 的 launch.provider 配置并重启后使用 ${requestedProvider.label}。普通消息仍可继续发送。`);
      return;
    }
    await store.update(agentKind, ctx.scope, patch);
    saved = true;
    if (followUpPrompt) {
      ctx.followUpPrompt = followUpPrompt;
      await reply(`已保存到${modelScopeLabel(ctx)}，开始执行。\n${modelSettingsSummary(next)}`);
      return;
    }
    await reply(`已保存到${modelScopeLabel(ctx)}。\n${modelSettingsSummary(next)}\n下一轮新任务生效，当前任务继续原设置。全局默认请用 /config run。`);
  } catch (err) {
    await reply(`${saved ? '设置已保存，但发送回执失败' : '设置未保存'}：${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function modelStatus(ctx: CommandContext): Promise<string> {
  const agentKind = ctx.agentKind ?? ctx.controls.profileConfig.agentKind;
  const next = await resolveRunModelSettings(ctx.controls, ctx.scope, undefined, agentKind);
  const active = ctx.activeRuns.get(ctx.scope)?.modelSettings;
  const provider = await ctx.agent.modelProviderState?.();
  return (provider ? `当前 Provider：\`${provider.displayName}\`（启动时固定）\n` : '') + `**下一轮 · ${modelScopeLabel(ctx)}**\n${modelSettingsSummary(next)}` +
    (active ? `\n**当前任务**：\`${active.model ?? 'CLI 默认'}\` / \`${active.reasoningEffort ?? 'CLI 默认'}\`` : '');
}
