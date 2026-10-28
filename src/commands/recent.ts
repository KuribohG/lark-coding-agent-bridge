import { basename } from 'node:path';
import type { SessionCatalogEntry } from '../session/catalog';
import { formatRelTime } from '../session/history';
import { canRunAdminCommand } from '../policy/access';
import { agentDisplayName } from '../agent/backend-spec';
import {
  lookupMessageAppLink,
  scopeAppLink,
} from '../bot/message-links';
import type { CommandContext } from './types';
import { reply } from './presentation';

const DEFAULT_RECENT_LIMIT = 5;
const MAX_RECENT_LIMIT = 20;

type CompletedSessionCatalogEntry = SessionCatalogEntry & { completedAt: number };

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
  const active = activeSessionFilter(ctx);
  const recent = uniqueRecent(entries
    .filter(isCompleted)
    .filter((entry) => !isActivelyRunning(entry, active))
    .filter((entry) => profileWide || entry.scopeId === ctx.scope)
    .sort((a, b) => b.completedAt - a.completedAt))
    .slice(0, limit);

  if (recent.length === 0) {
    await reply(ctx, '最近没有已完成的 session。正在运行的 session 不会计入 `/recent`。');
    return;
  }

  const heading = profileWide ? '（当前 profile）' : '（当前会话）';
  const lines = [`最近完成的 ${recent.length} 个 session${heading}：`];
  const links = await Promise.all(recent.map((entry) => resolveRecentLink(ctx, entry)));
  recent.forEach((entry, index) => {
    const summary = formatSummary(entry.lastSummary) ?? basename(entry.cwdRealpath);
    const title = links[index]
      ? `[${escapeMarkdownLinkLabel(summary)}](${links[index]})`
      : escapeMarkdownLinkLabel(summary);
    lines.push(
      `${index + 1}. ${title}`,
      `   ${agentDisplayName(entry.agentId)} · ${formatCompletionTime(entry.completedAt)}`
        + ` · ${scopeLabel(entry.scopeId, ctx)}`,
    );
  });
  await reply(ctx, lines.join('\n'));
}

function uniqueRecent(entries: CompletedSessionCatalogEntry[]): CompletedSessionCatalogEntry[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    const identity = nativeSessionKey(entry);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

function isCompleted(entry: SessionCatalogEntry): entry is CompletedSessionCatalogEntry {
  return entry.completedAt !== undefined && Boolean(entry.sessionId || entry.threadId);
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

function formatCompletionTime(completedAt: number): string {
  const completed = new Date(completedAt);
  const now = new Date();
  const day = (date: Date) => new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
  const absolute = day(completed) === day(now)
    ? new Intl.DateTimeFormat('zh-CN', {
        timeZone: 'Asia/Shanghai',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(completed)
    : new Intl.DateTimeFormat('zh-CN', {
        timeZone: 'Asia/Shanghai',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(completed);
  return `${absolute}（${formatRelTime(completedAt)}）`;
}

async function resolveRecentLink(
  ctx: CommandContext,
  entry: CompletedSessionCatalogEntry,
): Promise<string | undefined> {
  if (entry.sourceMessageId) {
    const link = await lookupMessageAppLink(ctx.channel, entry.sourceMessageId, 1_500);
    if (link) return link;
  }
  return scopeAppLink(entry.scopeId);
}

function activeSessionFilter(ctx: CommandContext): {
  nativeKeys: Set<string>;
  unidentifiedScopes: Set<string>;
} {
  const nativeKeys = new Set<string>();
  const unidentifiedScopes = new Set<string>();
  for (const scope of ctx.activeRuns.scopes()) {
    const identity = ctx.activeRuns.get(scope)?.sessionIdentity;
    if (!identity?.sessionId && !identity?.threadId) {
      unidentifiedScopes.add(scope);
      continue;
    }
    nativeKeys.add(nativeSessionKey(identity));
  }
  return { nativeKeys, unidentifiedScopes };
}

function isActivelyRunning(
  entry: CompletedSessionCatalogEntry,
  active: ReturnType<typeof activeSessionFilter>,
): boolean {
  return active.unidentifiedScopes.has(entry.scopeId)
    || active.nativeKeys.has(nativeSessionKey(entry));
}

function nativeSessionKey(entry: {
  agentId: string;
  sessionId?: string;
  threadId?: string;
}): string {
  return `${entry.agentId}:${entry.threadId ?? entry.sessionId ?? ''}`;
}

function escapeMarkdownLinkLabel(value: string): string {
  return value.replace(/([\\[\]])/g, '\\$1');
}

function plainText(value: string): string {
  return value.replace(/[*_~[\]<>]/g, '');
}
