import { defaultWorkspaceFor } from '../agent/state-layout';
import { dirname } from 'node:path';
import { resolveAppPaths } from '../config/app-paths';
import type { CommandContext } from './types';

export function effectiveWorkspaceCwd(ctx: CommandContext): string | undefined {
  return ctx.workspaces.cwdFor(ctx.scope) ??
    defaultWorkspaceFor(ctx.controls.profileConfig, ctx.agentKind);
}

export async function cancelPendingInput(
  ctx: CommandContext,
  scope = ctx.scope,
): Promise<number> {
  const dropped = ctx.controls.channel?.cancelPendingInput(scope) ?? 0;
  await ctx.controls.channel?.flushPendingInput();
  return dropped;
}

/**
 * Drops everything in flight for the scope before its session or workspace
 * changes: side questions, workflow and timed-run bindings, queued input and
 * the active run. Returns whether a run was interrupted.
 */
export async function abandonScopeWork(ctx: CommandContext): Promise<boolean> {
  ctx.controls.channel?.btw.reset(ctx.scope);
  ctx.controls.channel?.workflow()?.invalidate(ctx.scope);
  ctx.controls.channel?.cancelTimedRun(ctx.scope);
  await cancelPendingInput(ctx);
  return ctx.activeRuns.interrupt(ctx.scope);
}

export function commandProfilePaths(ctx: CommandContext) {
  return resolveAppPaths({
    rootDir: dirname(ctx.controls.configPath),
    profile: ctx.controls.profile,
  });
}
