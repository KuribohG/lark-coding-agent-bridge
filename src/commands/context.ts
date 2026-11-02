import { defaultWorkspaceFor } from '../agent/state-layout';
import { dirname } from 'node:path';
import { resolveAppPaths } from '../config/app-paths';
import type { CommandContext } from './types';

export function effectiveWorkspaceCwd(ctx: CommandContext): string | undefined {
  return ctx.workspaces.cwdFor(ctx.scope) ??
    defaultWorkspaceFor(ctx.controls.profileConfig, ctx.agentKind ?? ctx.controls.profileConfig.agentKind);
}

export async function cancelPendingInput(
  ctx: CommandContext,
  scope = ctx.scope,
): Promise<number> {
  const dropped = ctx.controls.cancelPendingInput?.(scope) ?? 0;
  await ctx.controls.flushPendingInput?.();
  return dropped;
}

export function commandProfilePaths(ctx: CommandContext) {
  return resolveAppPaths({
    rootDir: dirname(ctx.controls.configPath),
    profile: ctx.controls.profile,
  });
}
