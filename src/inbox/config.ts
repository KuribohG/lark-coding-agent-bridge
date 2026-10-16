export type IntakeScope = 'private' | 'private_mentions' | 'all';
export const intakeScope = (c: Pick<InboxConfig, 'intakeScope' | 'watchPrivate' | 'watchMentions'>): IntakeScope | undefined =>
  c.intakeScope ?? (c.watchPrivate ? c.watchMentions ? 'private_mentions' : 'private' : undefined);
export type InboxMode = 'off' | 'on';
export const INBOX_TRIAGE_BATCH_SIZE = 50;
export const INBOX_DAILY_TRIAGE_LIMIT = 1_000_000;
export const inboxMode = (config: Pick<InboxConfig, 'enabled' | 'autoAnalyze'>): InboxMode =>
  config.enabled ? 'on' : 'off';

export interface InboxConfig {
  enabled: boolean;
  executorProfile: string;
  ownerOpenId: string;
  destination: { chatId: string; threadId: string; replyTo: string };
  deliveryMode: 'thread' | 'new_topic';
  intakeScope?: IntakeScope;
  watchPrivate: boolean;
  watchMentions: boolean;
  /** Retained for older snapshots; legacy countdown-based analysis is disabled. */
  autoAnalyze: boolean;
  attentionProfile: string;
  /** Empty = profile/provider default; absent on legacy configs = DeepSeek Flash. */
  analysisModel?: string;
  dailyTriageLimit: number;
  waitMinutes: number;
  pollSeconds: number;
  contextMinutes: number;
  maxContextChars: number;
  dailyAutoLimit: number;
  h5: { publicUrl: string; port: number };
  gui: { publicUrl: string; apiKeyFile: string };
}

export const INBOX_DEFAULTS: InboxConfig = {
  enabled: false, executorProfile: '', ownerOpenId: '',
  destination: { chatId: '', threadId: '', replyTo: '' },
  deliveryMode: 'thread',
  watchPrivate: true, watchMentions: true, autoAnalyze: false,
  attentionProfile: '', analysisModel: '', dailyTriageLimit: INBOX_DAILY_TRIAGE_LIMIT,
  waitMinutes: 30, pollSeconds: 60, contextMinutes: 15,
  maxContextChars: 24_000, dailyAutoLimit: 20,
  h5: { publicUrl: '', port: 19182 },
  gui: { publicUrl: '', apiKeyFile: '' },
};

export function normalizeInbox(input: unknown): InboxConfig {
  const r = (input && typeof input === 'object' ? input : {}) as Partial<InboxConfig>;
  const str = (v: unknown) => typeof v === 'string' ? v.trim() : '';
  const num = (v: unknown, min: number, max: number, fallback: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.max(min, Math.min(max, Math.floor(v))) : fallback;
  const scope = ['private', 'private_mentions', 'all'].includes(String(r.intakeScope)) ? r.intakeScope : undefined;
  return {
    intakeScope: scope,
    analysisModel: input == null ? '' : typeof r.analysisModel === 'string' ? str(r.analysisModel).slice(0, 200) : undefined,
    enabled: r.enabled === true, executorProfile: str(r.executorProfile), ownerOpenId: str(r.ownerOpenId),
    destination: { chatId: str(r.destination?.chatId), threadId: str(r.destination?.threadId), replyTo: str(r.destination?.replyTo) },
    deliveryMode: r.deliveryMode === 'new_topic' ? 'new_topic' : 'thread',
    watchPrivate: scope ? true : r.watchPrivate !== false, watchMentions: scope ? scope !== 'private' : r.watchMentions !== false, autoAnalyze: false,
    attentionProfile: str(r.attentionProfile).slice(0, 3000), dailyTriageLimit: num(r.dailyTriageLimit, 0, INBOX_DAILY_TRIAGE_LIMIT, INBOX_DAILY_TRIAGE_LIMIT),
    waitMinutes: num(r.waitMinutes, 1, 1440, 30), pollSeconds: num(r.pollSeconds, 30, 3600, 60),
    contextMinutes: num(r.contextMinutes, 5, 1440, 15), maxContextChars: num(r.maxContextChars, 2000, 100_000, 24_000),
    dailyAutoLimit: num(r.dailyAutoLimit, 0, 1000, 20),
    h5: { publicUrl: str(r.h5?.publicUrl), port: num(r.h5?.port, 1024, 65535, 19182) },
    gui: { publicUrl: str(r.gui?.publicUrl), apiKeyFile: str(r.gui?.apiKeyFile) },
  };
}

export function validateInbox(c: InboxConfig): void {
  if (!c.enabled) return;
  if (!c.executorProfile || !/^ou_[\w]+$/.test(c.ownerOpenId)) throw new Error('请设置执行 profile 和用户 Open ID');
  if (!/^oc_\w+$/.test(c.destination.chatId) || !/^omt_\w+$/.test(c.destination.threadId) || !/^om_\w+$/.test(c.destination.replyTo)) {
    throw new Error('请设置结果群 ID、话题 ID 和话题内的回复消息 ID');
  }
  if (c.h5.publicUrl) {
    const url = new URL(c.h5.publicUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !url.pathname.endsWith('/')) {
      throw new Error('助理页面地址必须是 HTTPS，以 / 结尾，且不含查询参数');
    }
  }
  if (c.gui.publicUrl) {
    const url = new URL(c.gui.publicUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !c.gui.apiKeyFile.startsWith('/')) {
      throw new Error('工作台需要 HTTPS 地址和本地凭证文件的绝对路径');
    }
  }
}
