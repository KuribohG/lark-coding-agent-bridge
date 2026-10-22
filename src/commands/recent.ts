import { basename } from 'node:path';
import type { SessionCatalogEntry } from '../session/catalog';
import { formatRelTime } from '../session/history';
import { canRunAdminCommand } from '../policy/access';
import type { CommandContext } from './types';
import { reply } from './presentation';

const DEFAULT_RECENT_LIMIT = 5;
const MAX_RECENT_LIMIT = 20;

export async function handleRecent(args: string, ctx: CommandContext): Promise<void> {
  const requested = Number.parseInt(args.trim(), 10);
  const limit = Number.isFinite(requested) && requested > 0
    ? Math.min(requested, MAX_RECENT_LIMIT)
    : DEFAULT_RECENT_LIMIT;
  const entries = ctx.sessionCatalog?.entries() ?? [];
  if (entries.length === 0) {
    await reply(ctx, '当前 profile 还没有 session 记录。完成一次任务后再使用 `/recent`。');
    return;
  }

  const profileWide = canRunAdminCommand(
    ctx.controls.profileConfig,
    ctx.controls,
    ctx.msg.senderId,
  ).ok;
  const runningScopes = new Set(ctx.activeRuns.scopes());
  const recent = uniqueRecent(entries
    .filter((entry: SessionCatalogEntry) => !runningScopes.has(entry.scopeId))
    .filter((entry: SessionCatalogEntry) => profileWide || entry.scopeId === ctx.scope)
    .filter((entry: SessionCatalogEntry) => Boolean(entry.sessionId || entry.threadId))
    .sort((a: SessionCatalogEntry, b: SessionCatalogEntry) =>
      activityAt(b) - activityAt(a)))
    .slice(0, limit);

  if (recent.length === 0) {
    await reply(ctx, '最近没有已完成的 session。正在运行的 session 不会计入 `/recent`。');
    return;
  }

  const heading = profileWide ? '（当前 profile）' : '（当前会话）';
  const lines = [`最近完成的 ${recent.length} 个 session${heading}：`];
  recent.forEach((entry: SessionCatalogEntry, index: number) => {
    const identity = entry.threadId ?? entry.sessionId ?? entry.key;
    const summary = formatSummary(entry.lastSummary);
    lines.push(
      `${index + 1}. ${agentLabel(entry.agentId)} · ${formatRelTime(activityAt(entry))}`
        + ` · ${scopeLabel(entry.scopeId, ctx)}`,
      `   \`${identity.slice(0, 8)}\`${summary ? ` · ${summary}` : ` · ${basename(entry.cwdRealpath)}`}`,
    );
  });
  await reply(ctx, lines.join('\n'));
}

function uniqueRecent(entries: SessionCatalogEntry[]): SessionCatalogEntry[] {
  const seen = new Set<string>();
  return entries.filter((entry: SessionCatalogEntry) => {
    const identity = `${entry.agentId}:${entry.threadId ?? entry.sessionId ?? entry.key}`;
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

function activityAt(entry: SessionCatalogEntry): number {
  return entry.completedAt ?? entry.updatedAt;
}

function agentLabel(agentId: SessionCatalogEntry['agentId']): string {
  if (agentId === 'codex') return 'Codex';
  if (agentId === 'claude') return 'Claude';
  return 'Pi';
}

function scopeLabel(scopeId: string, ctx: CommandContext): string {
  if (scopeId === ctx.scope) return '当前会话';
  const chatId = scopeId.split(':', 1)[0];
  const chat = ctx.controls.knownChats?.find((item) => item.id === chatId);
  if (chat) {
    return `群聊 ${plainText(chat.name)}${scopeId.includes(':') ? ' · 话题' : ''}`;
  }
  return `会话 …${scopeId.slice(-8)}`;
}

function formatSummary(summary: string | undefined): string | undefined {
  if (!summary) return undefined;
  const value = summary.replace(/\s+/g, ' ').replaceAll('`', "'").trim();
  return value ? value.slice(0, 120) : undefined;
}

function plainText(value: string): string {
  return value.replace(/[*_~[\]<>]/g, '');
}
