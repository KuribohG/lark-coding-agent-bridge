import { reasoningEffortOptions, type ModelEnvironment, type ModelSettings, type ResolvedModelSettings } from '../agent/model-settings';
import type { AgentKind } from '../config/profile-schema';
import {
  AUTO_MODEL_PROVIDER,
  selectedProvider,
  type ModelProviderOption,
} from '../model-provider/provider';

export function modelSettingsSummary(settings: ResolvedModelSettings): string {
  const source = { scope: '当前聊天设置', profile: 'bot 默认', cli: 'CLI 默认', model: '模型默认' };
  return `模型：\`${settings.modelSource === 'cli' ? 'CLI 默认' : settings.model}\`（${source[settings.modelSource]}）\n` +
    `思考强度：\`${settings.effortSource === 'cli' ? 'CLI 默认' : settings.reasoningEffort}\`（${source[settings.effortSource]}）` +
    (settings.notice ? `\n${settings.notice}` : '');
}

export function modelFormCard(input: {
  agentKind: AgentKind;
  scope: string;
  scopeLabel: string;
  overrides: ModelSettings;
  resolved: ResolvedModelSettings;
  environment: ModelEnvironment;
  providers: ModelProviderOption[];
  activeProvider?: { id: string; displayName: string; fixedUntilRestart: boolean };
}): object {
  const provider = selectedProvider(input.providers, input.resolved.model);
  const selectedModel = provider && input.resolved.model?.startsWith(`${provider.id}/`)
    ? input.resolved.model.slice(provider.id.length + 1)
    : input.resolved.model;
  return {
    schema: '2.0',
    config: { summary: { content: '模型与思考强度' } },
    body: { elements: [
      { tag: 'markdown', content: `**${input.scopeLabel}**\n${input.activeProvider ? `当前 Provider：\`${input.activeProvider.displayName}\`（启动时固定；切换需修改配置并重启）\n` : ''}${modelSettingsSummary(input.resolved)}\n\n下一轮新任务生效；/new 保留设置。填写 default 可跟随 bot 默认。` },
      { tag: 'form', name: 'model_settings', elements: [
        { tag: 'markdown', content: '**模型 Provider**（选择后填写该 Provider 的模型 ID）' },
        { tag: 'select_static', name: 'provider_pick', initial_option: input.activeProvider && input.providers.some(p => p.id === input.activeProvider!.id) ? input.activeProvider.id : provider?.id ?? AUTO_MODEL_PROVIDER, options: [
          { text: { tag: 'plain_text', content: '自动 / 保留当前模型' }, value: AUTO_MODEL_PROVIDER },
          ...input.providers.map(item => ({
            text: { tag: 'plain_text', content: item.label },
            value: item.id,
          })),
        ] },
        { tag: 'markdown', content: '**模型名**（可以直接填写）' },
        { tag: 'input', name: 'model', default_value: selectedModel ?? 'default',
          placeholder: { tag: 'plain_text', content: 'provider/model 或 default' } },
        { tag: 'select_static', name: 'model_pick', initial_option: '__manual__', options: [
          { text: { tag: 'plain_text', content: '使用上方输入的模型名' }, value: '__manual__' },
          { text: { tag: 'plain_text', content: '使用所选 Provider 的默认模型' }, value: '__provider_default__' },
          ...input.environment.models.slice(0, 80).map((m) => ({ text: { tag: 'plain_text', content: m.label }, value: m.value })),
        ] },
        { tag: 'markdown', content: '**思考强度**（保存时按所选模型校验）' },
        { tag: 'select_static', name: 'reasoning_effort', initial_option: input.overrides.reasoningEffort ?? 'default', options:
          reasoningEffortOptions(input.agentKind).map(({ value, label }) => ({
            text: { tag: 'plain_text', content: label }, value,
          })),
        },
        { tag: 'button', name: 'save', type: 'primary', form_action_type: 'submit',
          text: { tag: 'plain_text', content: `保存到${input.scopeLabel}` },
          behaviors: [{ type: 'callback', value: { cmd: 'model.submit', settings_scope: input.scope } }],
        },
      ] },
    ] },
  };
}
