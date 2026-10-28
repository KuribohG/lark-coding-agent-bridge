import { helpCard } from '../card/templates';
import type { CommandContext } from './types';
import { reply, commandReplyOptions } from './presentation';

export async function handleDoc(args: string, ctx: CommandContext): Promise<void> {
  void args;
  await reply(ctx, '云文档评论现在不需要绑定工作区；在支持的文档评论里 @bot 即可触发回复。');
}

export async function handleHelp(_args: string, ctx: CommandContext): Promise<void> {
  const card = helpCard(ctx.agent.displayName, ctx.controls.commands?.helpLines(
    ctx.agent.displayName.replace(/([*_`\\])/g, '\\$1'),
  ));
  await ctx.channel.send(ctx.msg.chatId, { card }, commandReplyOptions(ctx));
}
