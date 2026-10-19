import type { Controls } from '../commands';
import type { ModelSettings } from '../agent/model-settings';
import { resolveAppPaths } from '../config/app-paths';
import { resolveAppSecret } from '../config/secret-resolver';
import { getCotMessages } from '../config/schema';
import { CotClient } from '../bot/cot';
import { createRuntimeAgent } from '../runtime/agent-runtime';
import { EventSource } from '../work-items/event-source';
import { createInvestigator } from '../work-items/investigation';
import type { SourceAdapter, RuleAssessmentPolicy, InvestigationDriver } from '../work-items/contracts';
import type { WorkItem } from '../work-items/types';
import { normalizeInbox, type InboxConfig } from '../inbox/config';
import { InboxLark } from '../inbox/lark';
import { processAnalysis } from '../work-items/analysis';
import { startInboxProgress } from '../inbox/progress';
import type { WorkItemSourceOptions } from '../work-items/registry';

export interface MonitorSourceOptions {
  id: string; label: string; profile: string; enabled: boolean;
  controls?: Controls;
  lane?: 'normal' | 'incident';
  sourceNotifications?: boolean;
  muted?: boolean;
  dailyAnalysisLimit?: number;
  resumeInterrupted?: boolean;
  status?: () => { error?: string; health?: { checkedAt?: number; checks: { id: string; state: string; detail: string; lastSuccessAt?: number }[] } };
  notification?: Pick<InboxConfig, 'ownerOpenId' | 'destination' | 'deliveryMode'>;
  settings: ModelSettings;
  source?: SourceAdapter;
  assessment?: RuleAssessmentPolicy;
  driver: InvestigationDriver & { accepts?(item: WorkItem): boolean };
}

export function createWorkItemSource(options: MonitorSourceOptions, configPath: string, rootDir?: string): WorkItemSourceOptions {
    if ((!options.source && !options.driver.accepts) || (options.source && options.assessment)) throw new Error('Invalid source adapter');
    const config = normalizeInbox({ ...options.notification, executorProfile: options.profile,
      ownerOpenId: options.notification?.ownerOpenId || `local:${options.profile}`, enabled: options.enabled,
      watchPrivate: false, watchMentions: false });
    const lark = options.notification && !options.muted ? new InboxLark({ profile: options.profile, rootDir }, config) : undefined;
    return { ...options, config, source: options.source ?? new EventSource(options.id, options.driver.accepts!, options.assessment), runtime: {
        dailyAnalysisLimit: options.dailyAnalysisLimit, resumeInterrupted: options.resumeInterrupted,
        checkAccess: async () => {},
        cancel: () => lark?.close(),
        deliver: async (job, phase) => { await lark?.deliver(job, phase); },
        ...(lark && !options.sourceNotifications ? { beginAnalysis: (job: Parameters<InboxLark['beginAnalysis']>[0], text: string) => lark.beginAnalysis(job, text) } : {}),
        ...(lark && options.sourceNotifications ? { notifyChange: (job: WorkItem, notice: NonNullable<WorkItem['sourceNotices']>[number]) =>
          lark.beginAnalysis({ ...job, startDelivery: { ...notice, confirmed: false } }, notice.text) } : {}),
        investigate: async (job, signal) => {
          const controls = options.controls;
          if (!controls || !options.enabled) throw new Error('盯盘执行器未上线');
          let progress: Awaited<ReturnType<typeof startInboxProgress>>;
          let success = false;
          try {
            const result = await createInvestigator(options.driver, async prepared => {
              const paths = resolveAppPaths({ rootDir, profile: options.profile });
              const agent = createRuntimeAgent(controls.profileConfig, { ...paths, configPath });
              if (controls.botIdentity) agent.setBotIdentity?.(controls.botIdentity);
              if (lark && job.analysisTopic && getCotMessages(controls.cfg) !== 'off') {
                try {
                  const secret = await resolveAppSecret(controls.cfg, paths);
                  progress = await startInboxProgress(job, lark, new CotClient({ tenant: controls.cfg.accounts.app.tenant,
                    appId: controls.cfg.accounts.app.id, appSecret: secret }), getCotMessages(controls.cfg), signal);
                } catch (error) { if (!options.sourceNotifications) throw error; }
              }
              return processAnalysis(agent, { runId: `inbox-${job.id}-${job.attempt}`, cwd: prepared.cwd,
                prompt: prepared.prompt, ...options.settings, deadlineAt: Date.now() + 30 * 60_000 }, signal, event => progress?.event(event));
            }, options.settings)(job, signal);
            success = true; return result;
          } finally { await progress?.finish(success); }
        },
      } };
}
