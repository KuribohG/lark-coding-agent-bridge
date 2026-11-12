import { AGENT_KINDS, agentShortDisplayName, isAgentKind } from '../agent/backend-spec';
import type { ResolvedModelSettings } from '../agent/model-settings';
import { modelSettingsSummary } from '../card/model-card';
import { resolveRunModelSettings } from '../runtime/model-settings';
import { modelScopeLabel, saveScopeModelArguments } from './model';
import { reply } from './presentation';
import type { CommandContext } from './types';

const AGENT_USAGE =
  `用法：/agent <${AGENT_KINDS.join('|')}|default> [模型名|default] [强度] [任务]；全局默认请用 /config run。`;

/**
 * `/agent <engine> [model] [effort] [prompt...]` picks the engine of one scope.
 * Sessions are tracked per engine, so each engine keeps its own conversation
 * here and nothing is carried over.
 */
export async function handleAgent(args: string, ctx: CommandContext): Promise<void> {
  const agents = ctx.controls.channel?.scopeAgents;
  if (!agents) return reply(ctx, '当前入口暂不支持 /agent。');
  const label = modelScopeLabel(ctx);
  const defaultKind = agents.defaultKind();
  const previous = ctx.agentKind;
  const trimmed = args.trim();
  const name = /^\S*/.exec(trimmed)![0];
  const modelArgs = trimmed.slice(name.length).trim();
  if (!name) {
    return reply(ctx, `${label}的执行引擎：**${agentShortDisplayName(previous)}**` +
      `（${previous === defaultKind ? '跟随全局默认' : '单独设置'}）\n${AGENT_USAGE}`);
  }
  const kind = name === 'default' ? defaultKind : name.toLowerCase();
  if (!isAgentKind(kind)) return reply(ctx, `未切换：未知执行引擎。\n${AGENT_USAGE}`);
  // A running task keeps its adapter, and its cards and follow-ups resolve the scope's engine.
  if (ctx.activeRuns.get(ctx.scope) || ctx.controls.channel?.activeTimedRun(ctx.scope)) {
    return reply(ctx, '未切换：当前有任务在执行，请等它结束或先 /stop。');
  }

  let settings: ResolvedModelSettings;
  let prompt: string | undefined;
  try {
    const agent = agents.adapter(ctx.scope, kind);
    await agents.select(ctx.scope, kind);
    try {
      if (modelArgs) {
        ({ settings, prompt } = await saveScopeModelArguments(ctx, { agentKind: kind, agent }, modelArgs, AGENT_USAGE));
      } else {
        settings = await resolveRunModelSettings(ctx.controls, ctx.scope, undefined, kind);
      }
    } catch (err) {
      await agents.select(ctx.scope, previous);
      throw err;
    }
  } catch (err) {
    return reply(ctx, `未切换：${err instanceof Error ? err.message : String(err)}`);
  }

  const changed = kind !== previous;
  // Side questions fork the previous engine's session.
  if (changed) ctx.controls.channel?.btw.reset(ctx.scope);
  if (prompt) ctx.followUpPrompt = prompt;
  const engine = `**${agentShortDisplayName(kind)}**${kind === defaultKind ? '（全局默认）' : ''}`;
  await reply(ctx, [
    changed
      ? `${label}的执行引擎已切换：${agentShortDisplayName(previous)} → ${engine}${prompt ? '，开始执行' : ''}。`
      : `${label}继续使用 ${engine}${prompt ? '，开始执行' : ''}。`,
    modelSettingsSummary(settings),
    ...(changed ? ['各引擎的上下文相互独立：切回某个引擎会继续它在这里的原会话，首次使用则新开会话。'] : []),
  ].join('\n'));
}
