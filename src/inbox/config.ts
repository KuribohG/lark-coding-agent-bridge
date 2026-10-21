import { normalizeNotification, validateNotification } from '../monitoring/notification';

export type IntakeScope = 'private' | 'private_mentions' | 'all';
export const intakeScope = (c: Pick<InboxConfig, 'intakeScope' | 'watchPrivate' | 'watchMentions'>): IntakeScope | undefined =>
  c.intakeScope ?? (c.watchPrivate ? c.watchMentions ? 'private_mentions' : 'private' : undefined);
export type InboxMode = 'off' | 'on';
const INBOX_DAILY_TRIAGE_LIMIT = 1_000_000;
export const INBOX_MIN_POLL_SECONDS = 1;
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
  triageMessageLimit: number;
  triageMessageChars: number;
  /** Empty follows the executor's defaults; absent keeps Flash for legacy Codex configs. */
  analysisModel?: string;
  analysisTimeoutMinutes: number;
  /** Explicit standalone service; takes precedence over all legacy profile routing. */
  triageService?: string;
  /** Legacy Codex model configuration source, used only without triageService. */
  triageProfile?: string;
  triageModel?: string;
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
  attentionProfile: '', analysisModel: '', analysisTimeoutMinutes: 30, dailyTriageLimit: INBOX_DAILY_TRIAGE_LIMIT,
  triageMessageLimit: 12, triageMessageChars: 2000,
  waitMinutes: 30, pollSeconds: INBOX_MIN_POLL_SECONDS, contextMinutes: 15,
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
    analysisTimeoutMinutes: num(r.analysisTimeoutMinutes, 1, 1440, INBOX_DEFAULTS.analysisTimeoutMinutes),
    ...(str(r.triageProfile) ? { triageProfile: str(r.triageProfile) } : {}),
    ...(str(r.triageService) ? { triageService: str(r.triageService) } : {}),
    ...(typeof r.triageModel === 'string' ? { triageModel: str(r.triageModel).slice(0, 200) } : {}),
    enabled: r.enabled === true, executorProfile: str(r.executorProfile), ...normalizeNotification(r),
    watchPrivate: scope ? true : r.watchPrivate !== false, watchMentions: scope ? scope !== 'private' : r.watchMentions !== false, autoAnalyze: false,
    attentionProfile: str(r.attentionProfile).slice(0, 3000), dailyTriageLimit: num(r.dailyTriageLimit, 0, INBOX_DAILY_TRIAGE_LIMIT, INBOX_DAILY_TRIAGE_LIMIT),
    triageMessageLimit: num(r.triageMessageLimit, 2, 100, INBOX_DEFAULTS.triageMessageLimit),
    triageMessageChars: num(r.triageMessageChars, 200, 16_000, INBOX_DEFAULTS.triageMessageChars),
    waitMinutes: num(r.waitMinutes, 1, 1440, 30), pollSeconds: num(r.pollSeconds, INBOX_MIN_POLL_SECONDS, 3600, INBOX_DEFAULTS.pollSeconds),
    contextMinutes: num(r.contextMinutes, 5, 1440, 15), maxContextChars: num(r.maxContextChars, 2000, 100_000, 24_000),
    dailyAutoLimit: num(r.dailyAutoLimit, 0, 1000, 20),
    h5: { publicUrl: str(r.h5?.publicUrl), port: num(r.h5?.port, 1024, 65535, 19182) },
    gui: { publicUrl: str(r.gui?.publicUrl), apiKeyFile: str(r.gui?.apiKeyFile) },
  };
}

export function validateInbox(c: InboxConfig): void {
  if (!c.enabled) return;
  validateNotification(c, c.executorProfile);
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
