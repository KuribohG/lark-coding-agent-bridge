import { describe, expect, it } from 'vitest';
import type { AgentKind } from '../../../src/config/profile-schema';
import { configFormCard } from '../../../src/card/config-card';
import { modelFormCard } from '../../../src/card/model-card';

function selectValues(card: object, name: string): Array<[string, string]> {
  const visit = (value: unknown): Array<[string, string]> | undefined => {
    if (!value || typeof value !== 'object') return undefined;
    const node = value as Record<string, unknown>;
    if (node.tag === 'select_static' && node.name === name && Array.isArray(node.options)) {
      return node.options.map((option) => {
        const item = option as { value: string; text: { content: string } };
        return [item.value, item.text.content];
      });
    }
    for (const child of Object.values(node)) {
      const found = visit(child);
      if (found) return found;
    }
    return undefined;
  };
  const values = visit(card);
  if (!values) throw new Error(`missing select ${name}`);
  return values;
}

describe('reasoning effort selectors', () => {
  it.each(['codex', 'claude', 'pi'] satisfies AgentKind[])(
    'uses identical /model and /config options for %s',
    (agentKind) => {
      const config = configFormCard({
        agentKind,
        mode: 'personal',
        model: 'default',
        messageReply: 'markdown',
        showToolCalls: false,
        cotMessages: 'off',
        maxConcurrentRuns: 1,
        runIdleTimeoutMinutes: 0,
        requireMentionInGroup: false,
        larkCliIdentity: 'bot-only',
        allowedUsers: [],
        allowedChats: [],
        admins: [],
        knownChats: [],
      });
      const model = modelFormCard({
        agentKind,
        scope: 'chat',
        scopeLabel: '当前聊天',
        overrides: {},
        resolved: { modelSource: 'cli', effortSource: 'cli' },
        environment: { defaults: {}, models: [] },
        providers: [],
      });

      expect(selectValues(config, 'reasoning_effort')).toEqual(selectValues(model, 'reasoning_effort'));
    },
  );

  it('renders Provider choices from registry metadata', () => {
    const card = modelFormCard({
      agentKind: 'pi',
      scope: 'chat',
      scopeLabel: '当前聊天',
      overrides: { model: 'deepseek/deepseek-flash' },
      resolved: { model: 'deepseek/deepseek-flash', modelSource: 'scope', effortSource: 'cli' },
      environment: { defaults: {}, models: [] },
      providers: [
        { id: 'deepseek', label: 'DeepSeek Gateway', defaultModel: 'deepseek-flash' },
      ],
    });
    expect(selectValues(card, 'provider_pick')).toEqual([
      ['__auto__', '自动 / 保留当前模型'],
      ['deepseek', 'DeepSeek Gateway'],
    ]);
    expect(selectValues(card, 'model_pick')).toContainEqual([
      '__provider_default__',
      '使用所选 Provider 的默认模型',
    ]);
  });
});
