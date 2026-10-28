import { normalizeNotification } from '../monitoring/notification';
import { validateLarkNotification } from '../monitoring/sources/lark/notification';
import type { WorkItemConfig } from '../work-items/config';

export type IntakeScope = 'private' | 'private_mentions' | 'all';
export const intakeScope = (c: Pick<InboxConfig, 'intakeScope' | 'watchPrivate' | 'watchMentions'>): IntakeScope | undefined =>
  c.intakeScope ?? (c.watchPrivate ? c.watchMentions ? 'private_mentions' : 'private' : undefined);
export type InboxMode = 'off' | 'on';
const INBOX_DAILY_TRIAGE_LIMIT = 1_000_000;
export const INBOX_MIN_POLL_SECONDS = 1;
export const inboxMode = (config: Pick<InboxConfig, 'enabled' | 'autoAnalyze'>): InboxMode =>
  config.enabled ? 'on' : 'off';
export const inboxWorkbenchUrl = (config: Pick<InboxConfig, 'workbenchUrl' | 'gui' | 'h5'>): string =>
  config.workbenchUrl || config.gui.publicUrl || config.h5.publicUrl;

export interface InboxConfig extends WorkItemConfig {
  recipientKey: string;
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
  /** Public, read/write workbench shown in Feishu result messages. */
  workbenchUrl: string;
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
  enabled: false, executorProfile: '', ownerKey: '', recipientKey: '',
  target: { transport: 'lark', containerId: '', threadId: '', replyTo: '' },
  deliveryMode: 'thread',
  watchPrivate: true, watchMentions: true, autoAnalyze: false,
  attentionProfile: '', analysisModel: '', analysisTimeoutMinutes: 30, workbenchUrl: '', dailyTriageLimit: INBOX_DAILY_TRIAGE_LIMIT,
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
  const notification = normalizeNotification(r);
  const h5 = { publicUrl: str(r.h5?.publicUrl), port: num(r.h5?.port, 1024, 65535, 19182) };
  const gui = { publicUrl: str(r.gui?.publicUrl), apiKeyFile: str(r.gui?.apiKeyFile) };
  return {
    intakeScope: scope,
    analysisModel: input == null ? '' : typeof r.analysisModel === 'string' ? str(r.analysisModel).slice(0, 200) : undefined,
    analysisTimeoutMinutes: num(r.analysisTimeoutMinutes, 1, 1440, INBOX_DEFAULTS.analysisTimeoutMinutes),
    workbenchUrl: (str(r.workbenchUrl) || gui.publicUrl || h5.publicUrl).slice(0, 2000),
    ...(str(r.triageProfile) ? { triageProfile: str(r.triageProfile) } : {}),
    ...(str(r.triageService) ? { triageService: str(r.triageService) } : {}),
    ...(typeof r.triageModel === 'string' ? { triageModel: str(r.triageModel).slice(0, 200) } : {}),
    enabled: r.enabled === true, executorProfile: str(r.executorProfile),
    ownerKey: notification.recipientKey, ...notification,
    watchPrivate: scope ? true : r.watchPrivate !== false, watchMentions: scope ? scope !== 'private' : r.watchMentions !== false, autoAnalyze: false,
    attentionProfile: str(r.attentionProfile).slice(0, 3000), dailyTriageLimit: num(r.dailyTriageLimit, 0, INBOX_DAILY_TRIAGE_LIMIT, INBOX_DAILY_TRIAGE_LIMIT),
    triageMessageLimit: num(r.triageMessageLimit, 2, 100, INBOX_DEFAULTS.triageMessageLimit),
    triageMessageChars: num(r.triageMessageChars, 200, 16_000, INBOX_DEFAULTS.triageMessageChars),
    waitMinutes: num(r.waitMinutes, 1, 1440, 30), pollSeconds: num(r.pollSeconds, INBOX_MIN_POLL_SECONDS, 3600, INBOX_DEFAULTS.pollSeconds),
    contextMinutes: num(r.contextMinutes, 5, 1440, 15), maxContextChars: num(r.maxContextChars, 2000, 100_000, 24_000),
    dailyAutoLimit: num(r.dailyAutoLimit, 0, 1000, 20),
    h5, gui,
  };
}

export function validateInbox(c: InboxConfig): void {
  if (!c.enabled) return;
  validateLarkNotification(c, c.executorProfile);
  if (c.workbenchUrl) {
    const url = new URL(c.workbenchUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
      throw new Error('工作台展示地址必须是 HTTPS，且不含查询参数或锚点');
    }
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
