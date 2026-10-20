import { resolveAppPaths } from '../config/app-paths';
import { resolveAppSecret } from '../config/secret-resolver';
import { loadRootConfig, runtimeProfileConfig } from '../config/profile-store';
import { getCotMessages } from '../config/schema';
import { CotClient } from '../bot/cot';
import { EventSource } from '../work-items/event-source';
import { createInvestigator } from '../work-items/investigation';
import { normalizeInbox } from '../inbox/config';
import { InboxLark } from '../inbox/lark';
import { startInboxProgress } from '../inbox/progress';
import type { WorkItemSourceOptions } from '../work-items/registry';
import type { MonitorSourceOptions } from '../monitoring/host';

/** The bridge supplies Lark delivery; other hosts can supply local or Web outputs. */
export function createWorkItemSource(options: MonitorSourceOptions, configPath: string, rootDir?: string): WorkItemSourceOptions {
  if ((!options.source && !options.driver.accepts) || (options.source && options.assessment)) throw new Error('Invalid source adapter');
  const config = normalizeInbox({ ...options.notification, executorProfile: options.profile,
    ownerOpenId: options.notification?.ownerOpenId || `local:${options.profile}`, enabled: options.enabled,
    watchPrivate: false, watchMentions: false });
  const lark = options.notification && !options.muted ? new InboxLark({ profile: options.profile, rootDir }, config) : undefined;
  return { id: options.id, label: options.label, config, status: options.status,
    source: options.source ?? new EventSource(options.id, options.driver.accepts!, options.assessment),
    runtime: {
      dailyAnalysisLimit: options.dailyAnalysisLimit, resumeInterrupted: options.resumeInterrupted,
      canInvestigate: () => { const executor = options.executor(); return executor?.available === true && !executor.signal?.aborted; },
      checkAccess: async () => {}, cancel: () => lark?.close(),
      ...(lark ? { deliver: lark.deliver.bind(lark) } : {}),
      ...(lark && !options.sourceNotifications ? { beginAnalysis: lark.beginAnalysis.bind(lark) } : {}),
      ...(lark && options.sourceNotifications ? { notifyChange: (job, notice) =>
        lark.beginAnalysis({ ...job, startDelivery: { ...notice, confirmed: false } }, notice.text) } : {}),
      investigate: async (job, signal) => {
        const executor = options.executor();
        if (!executor?.available) throw new Error('执行器暂不可用');
        signal = executor.signal ? AbortSignal.any([signal, executor.signal]) : signal;
        signal.throwIfAborted();
        const settings = await executor.settings(options.model, options.reasoningEffort);
        let progress: Awaited<ReturnType<typeof startInboxProgress>>;
        let success = false;
        try {
          const result = await createInvestigator(options.driver, async prepared => {
            if (lark && job.analysisTopic) {
              try {
                const root = await loadRootConfig(configPath);
                if (!root?.profiles[options.profile]) throw new Error('通知 profile 不存在');
                const cfg = runtimeProfileConfig(root, options.profile);
                if (getCotMessages(cfg) !== 'off') {
                  const paths = resolveAppPaths({ rootDir, profile: options.profile });
                  const secret = await resolveAppSecret(cfg, paths);
                  progress = await startInboxProgress(job, lark, new CotClient({ tenant: cfg.accounts.app.tenant,
                    appId: cfg.accounts.app.id, appSecret: secret }), getCotMessages(cfg), signal);
                }
              } catch (error) { if (!options.sourceNotifications) throw error; }
            }
            return executor.execute({ runId: `inbox-${job.id}-${job.attempt}`, cwd: prepared.cwd,
              prompt: prepared.prompt, ...settings, deadlineAt: Date.now() + 30 * 60_000 }, signal, event => progress?.event(event));
          }, settings)(job, signal);
          signal.throwIfAborted();
          success = true; return result;
        } finally { await progress?.finish(success); }
      },
    },
  };
}
