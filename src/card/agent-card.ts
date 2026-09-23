import type { AgentKind } from '../config/profile-schema';

export function agentCard(current: AgentKind): object {
  return {
    schema: '2.0',
    config: { summary: { content: '全局执行引擎' } },
    body: { elements: [
      { tag: 'markdown', content: '**全局执行引擎**\n当前：**' + (current === 'codex' ? 'Codex' : 'Claude Code') +
        '**\n\n对这个 bot 的所有聊天生效，重启后保留。切回时恢复各自的会话和模型设置。请先完成运行中及排队中的任务。' },
      ...(['codex', 'claude'] as const).map(kind => ({
        tag: 'button',
        text: { tag: 'plain_text', content: kind === 'codex' ? '使用 Codex' : '使用 Claude Code' },
        type: kind === current ? 'primary' : 'default',
        behaviors: [{ type: 'callback', value: { cmd: 'agent.' + kind + '.' + current } }],
      })),
    ] },
  };
}
