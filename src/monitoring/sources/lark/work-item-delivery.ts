import { resolveAppPaths } from '../../../config/app-paths';
import { loadRootConfig, runtimeProfileConfig } from '../../../config/profile-store';
import { getCotMessages } from '../../../config/schema';
import { CotClient } from '../../../bot/cot';
import { LarkProfileAuth } from '../../../lark-auth/profile-auth';
import { InboxLark } from '../../../inbox/lark';
import { startInboxProgress } from '../../../inbox/progress';
import { normalizeInbox } from '../../../inbox/config';
import type { WorkItemDeliveryPort } from '../../../work-items/delivery-port';
import type { MonitorNotification } from '../../notification';
import { validateLarkNotification } from './notification';

export function createLarkWorkItemDelivery(options: {
  profile: string;
  rootDir?: string;
  configPath: string;
  notification?: MonitorNotification;
  muted?: boolean;
  sourceNotifications?: boolean;
  larkAuth?: LarkProfileAuth;
}): WorkItemDeliveryPort | undefined {
  if (!options.notification || options.muted) return;
  validateLarkNotification(options.notification, options.profile);
  const config = normalizeInbox({
    ...options.notification,
    executorProfile: options.profile,
    enabled: true,
    watchPrivate: false,
    watchMentions: false,
  });
  const lark = new InboxLark({ profile: options.profile, rootDir: options.rootDir }, config);
  const activeReleases = new Set<() => Promise<void>>();
  return {
    ownerKey: options.notification.recipientKey,
    target: options.notification.target,
    close: async () => {
      lark.close();
      await Promise.all([...activeReleases].map(release => release()));
    },
    deliver: lark.deliver.bind(lark),
    ...(options.sourceNotifications
      ? {
          notifyChange: (job, notice) =>
            lark.beginAnalysis(
              { ...job, startDelivery: { ...notice, confirmed: false } },
              notice.text,
            ),
        }
      : {
          beginAnalysis: lark.beginAnalysis.bind(lark),
        }),
    notifyAttention: lark.notifyAttention.bind(lark),
    progress: async (job, signal) => {
      if (!job.analysisTarget) return;
      const root = await loadRootConfig(options.configPath);
      if (!root?.profiles[options.profile]) throw new Error('通知 profile 不存在');
      const cfg = runtimeProfileConfig(root, options.profile);
      if (getCotMessages(cfg) === 'off') return;
      const paths = resolveAppPaths({ rootDir: options.rootDir, profile: options.profile });
      const auth = options.larkAuth ?? new LarkProfileAuth(cfg, paths);
      const releaseLease = auth.retainNetwork();
      const release = async () => {
        if (!activeReleases.delete(release)) return;
        await releaseLease();
        if (!options.larkAuth) await auth.close();
      };
      activeReleases.add(release);
      try {
        const credentials = await auth.credentials();
        const client = new CotClient({
          tenant: credentials.tenant,
          appId: credentials.appId,
          appSecret: credentials.appSecret,
          tenantTokens: await auth.tenantTokens(),
          request: auth.request,
        });
        const progress = await startInboxProgress(job, lark, client, getCotMessages(cfg), signal);
        if (!progress) { await release(); return; }
        return {
          event: progress.event,
          finish: async success => {
            try { await progress.finish(success); } finally { await release(); }
          },
        };
      } catch (error) { await release(); throw error; }
    },
  };
}
