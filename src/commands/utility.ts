import { helpCard, helpDetailCard } from '../card/templates';
import { commandHelpLines, findCommand } from './catalog';
import type { CommandContext } from './types';
import { reply, commandReplyOptions } from './presentation';

export async function handleHelp(args: string, ctx: CommandContext): Promise<void> {
  const escapedAgentName = ctx.agent.displayName.replace(/([*_`\\])/g, '\\$1');
  const target = args.trim().split(/\s+/)[0]?.replace(/^\//, '') ?? '';
  if (target) {
    const definition = ctx.controls.commands?.find(target) ?? findCommand(target);
    if (!definition) {
      await reply(ctx, `未找到命令 \`/${target}\`。发送 \`/help\` 查看全部命令。`);
      return;
    }
    const card = helpDetailCard(
      definition.name,
      commandHelpLines(escapedAgentName, [definition]),
      definition.aliases,
    );
    await ctx.channel.send(ctx.msg.chatId, { card }, commandReplyOptions(ctx));
    return;
  }
  const card = helpCard(ctx.agent.displayName, ctx.controls.commands?.helpLines(escapedAgentName));
  await ctx.channel.send(ctx.msg.chatId, { card }, commandReplyOptions(ctx));
}
