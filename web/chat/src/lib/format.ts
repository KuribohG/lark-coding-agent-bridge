import type { Conversation } from './types';

const DAY = 86_400_000;

function startOfDay(at: number): number {
  const date = new Date(at);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** The clock time today, the day and time this year, otherwise the full date. */
export function clock(at: number, now = Date.now()): string {
  const date = new Date(at);
  const time = date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  if (startOfDay(at) === startOfDay(now)) return time;
  if (startOfDay(at) === startOfDay(now) - DAY) return `昨天 ${time}`;
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return `${date.toLocaleDateString('zh-CN', sameYear ? { month: 'numeric', day: 'numeric' } : { year: 'numeric', month: 'numeric', day: 'numeric' })} ${time}`;
}

export function ago(at: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 45) return '刚刚';
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))} 分钟前`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} 小时前`;
  if (seconds < 86_400 * 30) return `${Math.round(seconds / 86_400)} 天前`;
  return new Date(at).toLocaleDateString('zh-CN', { year: 'numeric', month: 'numeric', day: 'numeric' });
}

export function duration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分 ${seconds % 60} 秒`;
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
}

export interface ConversationGroup {
  label: string;
  conversations: Conversation[];
}

/** The sidebar's sections: pinned first, then by how recently each was active. */
export function groupConversations(conversations: Conversation[], now = Date.now()): ConversationGroup[] {
  const today = startOfDay(now);
  const sections: Array<[string, (conversation: Conversation) => boolean]> = [
    ['置顶', conversation => Boolean(conversation.pinned)],
    ['今天', conversation => conversation.updatedAt >= today],
    ['昨天', conversation => conversation.updatedAt >= today - DAY],
    ['过去 7 天', conversation => conversation.updatedAt >= today - 7 * DAY],
    ['过去 30 天', conversation => conversation.updatedAt >= today - 30 * DAY],
    ['更早', () => true],
  ];
  const groups = sections.map(([label]) => ({ label, conversations: [] as Conversation[] }));
  for (const conversation of conversations) {
    groups[sections.findIndex(([, belongs]) => belongs(conversation))]!.conversations.push(conversation);
  }
  return groups.filter(group => group.conversations.length > 0);
}

/** The last part of a path, which is what people call a project. */
export function baseName(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path;
}

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
export const modKey = isMac ? '⌘' : 'Ctrl';
