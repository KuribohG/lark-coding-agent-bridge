import type { MonitorHost } from './host';
import type { RootConfig } from '../config/profile-schema';
import type { WorkItemSources } from '../work-items/registry';
import { supportsBackgroundProfile } from '../runtime/agent-capabilities';
import { fail } from './validation';

export type MonitorSettings = Pick<RootConfig, 'inbox' | 'gitlabCi' | 'storageMonitor' | 'workItemConcurrency'>;

/** Configuration registrations must be safe to import without starting a runtime. */
export function defineMonitorConfig<K extends Exclude<keyof MonitorSettings, 'workItemConcurrency'>>(options: {
  id: string;
  key: K;
  parse(value: unknown): NonNullable<MonitorSettings[K]>;
  references?(config: NonNullable<MonitorSettings[K]>, root: RootConfig): void;
  summary?(config: MonitorSettings[K]): object;
}) {
  return {
    id: options.id, key: options.key,
    parseInto(settings: MonitorSettings, value: unknown) { settings[options.key] = options.parse(value); },
    format(settings: MonitorSettings) {
      const config = settings[options.key];
      return config ? options.parse(JSON.parse(JSON.stringify(config))) : undefined;
    },
    validateReferences(settings: MonitorSettings, root: RootConfig) {
      const config = settings[options.key];
      if (!config) return;
      if (config.enabled) {
        const profile = root.profiles[config.executorProfile];
        if (!profile || !supportsBackgroundProfile(profile)) fail(`sources.${options.id}.executorProfile`, '需要支持后台分析的个人 profile');
      }
      options.references?.(config, root);
    },
    summary(settings: MonitorSettings) {
      const config = settings[options.key];
      return { id: options.id, enabled: config?.enabled ?? false, executorProfile: config?.executorProfile ?? '',
        pollSeconds: config?.pollSeconds, ...options.summary?.(config) };
    },
  };
}

export interface MonitorContext {
  configPath: string;
  rootDir?: string;
  host: MonitorHost;
  sources: WorkItemSources;
}

export interface MonitorController {
  reconcile(): Promise<void>;
  close(): Promise<void>;
}

export interface MonitorModule<T extends MonitorController = MonitorController> {
  id: string;
  create(context: MonitorContext): T;
}
