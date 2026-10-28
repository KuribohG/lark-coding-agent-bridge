import type { CommandContext } from './types';
import { CommandRegistry } from './registry';

const defaultCommandRegistry = new CommandRegistry();

export async function tryHandleCommand(ctx: CommandContext): Promise<boolean> {
  return (ctx.controls.commands ?? defaultCommandRegistry).tryHandle(ctx);
}

/** Card buttons and text commands share authorization and handler selection. */
export async function runCommandHandler(
  name: string,
  args: string,
  ctx: CommandContext,
): Promise<boolean> {
  return (ctx.controls.commands ?? defaultCommandRegistry).run(name, args, ctx);
}

export { CommandRegistry } from './registry';
export type {
  CommandContext,
  Controls,
  Handler,
  FeatureCommandContribution,
} from './types';
