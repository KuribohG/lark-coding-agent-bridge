import type { CommandContext } from './index';
import { agentCard } from '../card/agent-card';
import { sendManagedCard } from '../card/managed';

export async function handleAgent(args: string, ctx: CommandContext): Promise<void> {
  const opts = { replyTo: ctx.msg.messageId, ...(ctx.chatMode === 'topic' ? { replyInThread: true } : {}) };
  const reply = (markdown: string) => ctx.channel.send(ctx.msg.chatId, { markdown }, opts);
  const [next, expected, ...extra] = args.trim().split(/\s+/);
  if (!next || next === 'status') {
    await sendManagedCard(ctx.channel, ctx.msg.chatId, agentCard(ctx.controls.profileConfig.agentKind), opts);
    return;
  }
  if ((next !== 'claude' && next !== 'codex') || extra.length ||
      (expected !== undefined && expected !== 'claude' && expected !== 'codex')) {
    await reply('用法：/agent、/agent codex 或 /agent claude。');
    return;
  }
  let saved = false;
  try {
    if (!ctx.controls.switchAgent) throw new Error('当前运行环境不支持切换执行引擎。');
    await ctx.controls.switchAgent(next, expected ?? ctx.controls.profileConfig.agentKind);
    saved = true;
    await reply('已将此 bot 的全局执行引擎设为 **' + (next === 'codex' ? 'Codex' : 'Claude Code') +
      '**，所有聊天的后续任务使用此设置；重启后保留。');
  } catch (err) {
    await reply((saved ? '执行引擎已切换，但回执发送失败：' : '未切换：') + (err instanceof Error ? err.message : String(err)));
  }
}
