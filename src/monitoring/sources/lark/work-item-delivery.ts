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
  const config = normalizeInbox({
    ...options.notification,
    executorProfile: options.profile,
    ownerOpenId: options.notification.ownerOpenId,
    enabled: true,
    watchPrivate: false,
    watchMentions: false,
  });
  const lark = new InboxLark({ profile: options.profile, rootDir: options.rootDir }, config);
  return {
    ownerKey: options.notification.ownerOpenId,
    destination: options.notification.destination,
    close: () => lark.close(),
    deliver: lark.deliver.bind(lark),
    ...(options.sourceNotifications
      ? {
          notifyChange: (job, notice) =>
            lark.beginAnalysis({ ...job, startDelivery: { ...notice, confirmed: false } }, notice.text),
        }
      : {
          beginAnalysis: lark.beginAnalysis.bind(lark),
        }),
    notifyAttention: lark.notifyAttention.bind(lark),
    progress: async (job, signal) => {
      if (!job.analysisTopic) return;
      const root = await loadRootConfig(options.configPath);
      if (!root?.profiles[options.profile]) throw new Error('通知 profile 不存在');
      const cfg = runtimeProfileConfig(root, options.profile);
      if (getCotMessages(cfg) === 'off') return;
      const paths = resolveAppPaths({ rootDir: options.rootDir, profile: options.profile });
      const auth = options.larkAuth ?? new LarkProfileAuth(cfg, paths);
      const credentials = await auth.credentials();
      const client = new CotClient({
        tenant: credentials.tenant,
        appId: credentials.appId,
        appSecret: credentials.appSecret,
        tenantTokens: await auth.tenantTokens(),
      });
      return startInboxProgress(job, lark, client, getCotMessages(cfg), signal);
    },
  };
}
