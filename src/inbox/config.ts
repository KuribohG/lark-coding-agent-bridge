export interface InboxConfig {
  enabled: boolean;
  executorProfile: string;
  ownerOpenId: string;
  destination: { chatId: string; threadId: string; replyTo: string };
  watchPrivate: boolean;
  watchMentions: boolean;
  autoAnalyze: boolean;
  waitMinutes: number;
  pollSeconds: number;
  contextMinutes: number;
  maxContextChars: number;
  dailyAutoLimit: number;
  h5: { publicUrl: string; port: number };
}

export const INBOX_DEFAULTS: InboxConfig = {
  enabled: false, executorProfile: '', ownerOpenId: '',
  destination: { chatId: '', threadId: '', replyTo: '' },
  watchPrivate: true, watchMentions: true, autoAnalyze: true,
  waitMinutes: 30, pollSeconds: 60, contextMinutes: 15,
  maxContextChars: 24_000, dailyAutoLimit: 20,
  h5: { publicUrl: '', port: 19182 },
};

export function normalizeInbox(input: unknown): InboxConfig {
  const r = (input && typeof input === 'object' ? input : {}) as Partial<InboxConfig>;
  const str = (v: unknown) => typeof v === 'string' ? v.trim() : '';
  const num = (v: unknown, min: number, max: number, fallback: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.max(min, Math.min(max, Math.floor(v))) : fallback;
  return {
    enabled: r.enabled === true, executorProfile: str(r.executorProfile), ownerOpenId: str(r.ownerOpenId),
    destination: { chatId: str(r.destination?.chatId), threadId: str(r.destination?.threadId), replyTo: str(r.destination?.replyTo) },
    watchPrivate: r.watchPrivate !== false, watchMentions: r.watchMentions !== false, autoAnalyze: r.autoAnalyze !== false,
    waitMinutes: num(r.waitMinutes, 1, 1440, 30), pollSeconds: num(r.pollSeconds, 30, 3600, 60),
    contextMinutes: num(r.contextMinutes, 5, 1440, 15), maxContextChars: num(r.maxContextChars, 2000, 100_000, 24_000),
    dailyAutoLimit: num(r.dailyAutoLimit, 0, 1000, 20),
    h5: { publicUrl: str(r.h5?.publicUrl), port: num(r.h5?.port, 1024, 65535, 19182) },
  };
}

export function validateInbox(c: InboxConfig): void {
  if (!c.enabled) return;
  if (!c.executorProfile || !/^ou_[\w]+$/.test(c.ownerOpenId)) throw new Error('请设置执行 profile 和用户 Open ID');
  if (!/^oc_\w+$/.test(c.destination.chatId) || !/^omt_\w+$/.test(c.destination.threadId) || !/^om_\w+$/.test(c.destination.replyTo)) {
    throw new Error('请设置结果群 ID、话题 ID 和话题内的回复消息 ID');
  }
  if (!c.h5.publicUrl) throw new Error('请先设置助理页面 HTTPS 地址，以便选择处理或忽略待办');
  if (c.h5.publicUrl) {
    const url = new URL(c.h5.publicUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !url.pathname.endsWith('/')) {
      throw new Error('助理页面地址必须是 HTTPS，以 / 结尾，且不含查询参数');
    }
  }
}
