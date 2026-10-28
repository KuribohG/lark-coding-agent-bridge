import { modelStatus } from './model';
import { readFile } from 'node:fs/promises';
import { statusCard } from '../card/templates';
import type { AgentKind, ProfileConfig } from '../config/profile-schema';
import { accessToClaudePermissionMode, accessToCodexSandbox } from '../config/permissions';
import { canRunAdminCommand } from '../policy/access';
import { hasStructuredLarkCliUserAuth } from '../lark-cli/identity-policy';
import type { CommandContext } from './types';
import { commandProfilePaths, effectiveWorkspaceCwd } from './context';
import { commandReplyOptions } from './presentation';
import { agentBackendSpec } from '../agent/backend-spec';

export function runtimeAccessStatus(
  profileConfig: ProfileConfig,
  agentKind: AgentKind = profileConfig.agentKind,
): { label: string; value: string } {
  const spec = agentBackendSpec(agentKind);
  if (spec.permissionView === 'permission') {
    return {
      label: 'permission',
      value: accessToClaudePermissionMode(
        profileConfig.permissions.defaultAccess,
        profileConfig.permissions,
      ),
    };
  }
  if (spec.permissionView === 'tools') {
    return {
      label: 'tools',
      value: profileConfig.permissions.defaultAccess === 'read-only'
        ? 'read-only allowlist'
        : 'Pi tools (no OS sandbox)',
    };
  }
  const sandbox = profileConfig.sandbox;
  return {
    label: 'sandbox',
    value: sandbox
      ? `${sandbox.defaultMode}/${sandbox.maxMode}`
      : `${accessToCodexSandbox(profileConfig.permissions.defaultAccess)}/${accessToCodexSandbox(profileConfig.permissions.maxAccess)}`,
  };
}

async function larkCliStatus(ctx: CommandContext): Promise<'app' | 'user-ready' | 'user-missing' | 'check-failed'> {
  const appPaths = commandProfilePaths(ctx);
  try {
    const raw = JSON.parse(await readFile(appPaths.larkCliTargetConfigFile, 'utf8')) as {
      apps?: Array<{
        appId?: string;
        brand?: string;
        defaultAs?: string;
        strictMode?: string;
        users?: unknown;
      }>;
    };
    const app = raw.apps?.find(
      (candidate) =>
        candidate.appId === ctx.controls.profileConfig.accounts.app.id &&
        candidate.brand === ctx.controls.profileConfig.accounts.app.tenant,
    );
    if (app?.defaultAs === 'auto' && app.strictMode === 'off' && hasStructuredLarkCliUserAuth(app.users)) {
      return 'user-ready';
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return 'check-failed';
  }
  if (
    ctx.controls.profileConfig.larkCli.identityPreset === 'user-default' &&
    canRunAdminCommand(ctx.controls.profileConfig, ctx.controls, ctx.msg.senderId).ok
  ) {
    return 'user-missing';
  }
  return 'app';
}

export async function handleStatus(_args: string, ctx: CommandContext): Promise<void> {
  const cwd = effectiveWorkspaceCwd(ctx);
  const sess = ctx.sessions.getRaw(ctx.scope);
  const agentKind = ctx.agentKind ?? ctx.controls.profileConfig.agentKind;
  const spec = agentBackendSpec(agentKind);
  const usesThread = spec.sessionIdField === 'threadId';
  const catalogEntry =
    ctx.sessionCatalog && ctx.sessionCatalogIdentity
      ? ctx.sessionCatalog.activeFor(ctx.sessionCatalogIdentity)
      : undefined;
  const card = statusCard({
    profileName: ctx.controls.profile,
    modelStatus: await modelStatus(ctx),
    cwd,
    sessionId: usesThread
      ? catalogEntry?.threadId
      : catalogEntry?.sessionId ?? (spec.legacySessionStore ? sess?.sessionId : undefined),
    emptySessionText: usesThread ? '(未建立)' : undefined,
    sessionStale: spec.legacySessionStore && Boolean(cwd && sess && sess.cwd !== cwd),
    contextUsage: formatContextUsage(catalogEntry?.contextUsage),
    agentName: ctx.agent.displayName,
    runtimeAccess: runtimeAccessStatus(ctx.controls.profileConfig, agentKind),
    larkCliStatus: await larkCliStatus(ctx),
    activeRun: Boolean(ctx.activeRuns.get(ctx.scope)),
    activeScopes: ctx.activeRuns.scopes().filter((scope) => !scope.startsWith('comment:')),
    activeCommentScopes: ctx.activeRuns.scopes().filter((scope) => scope.startsWith('comment:')),
    queue: ctx.processPool?.snapshot(),
    ownerState: formatOwnerState(ctx),
    scope: ctx.scope,
    chatMode: ctx.chatMode,
  });
  await ctx.channel.send(ctx.msg.chatId, { card }, commandReplyOptions(ctx));
}

function formatContextUsage(
  usage: { inputTokens: number; contextWindowTokens: number } | undefined,
): string | undefined {
  if (!usage || usage.contextWindowTokens <= 0) return undefined;
  const percent = Math.round((usage.inputTokens / usage.contextWindowTokens) * 100);
  return `${percent}% (${formatTokenCount(usage.inputTokens)} / ${formatTokenCount(usage.contextWindowTokens)} tokens)`;
}

function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return String(tokens);
}

export function formatOwnerState(ctx: CommandContext): string {
  const state = ctx.controls.ownerRefreshState;
  const owner = ctx.controls.botOwnerId ? 'present' : 'missing';
  const refreshed = ctx.controls.ownerRefreshedAt
    ? ` refreshed=${new Date(ctx.controls.ownerRefreshedAt).toISOString()}`
    : '';
  return `${state} owner=${owner}${refreshed}`;
}
