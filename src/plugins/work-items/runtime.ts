import { MonitorRuntime } from '../../monitoring/runtime';
import { monitorModules } from '../../monitoring/sources';
import type { MonitorHost } from '../../monitoring/host';
import type { LarkMonitorProfiles } from '../../monitoring/sources/lark/host';
import { createLarkRuntimeAgent } from '../../channels/lark/agent-host';
import { ProfileExecutionProvider } from './execution-provider';
import { createWorkItemSource } from './work-item-runtime';
import { createLarkWorkItemDelivery } from '../../monitoring/sources/lark/work-item-delivery';

export function createMonitorHost(configPath: string, rootDir?: string, profiles: LarkMonitorProfiles = () => undefined): MonitorHost {
  return {
    executors: new ProfileExecutionProvider(configPath, rootDir, (config, paths) => {
      const agent = createLarkRuntimeAgent(config, paths, configPath);
      const identity = profiles(paths.profile)?.botIdentity;
      if (identity) agent.setBotIdentity?.(identity);
      return agent;
    }),
    source: options => createWorkItemSource({
      ...options,
      delivery: createLarkWorkItemDelivery({
        profile: options.profile,
        rootDir,
        configPath,
        notification: options.notification,
        muted: options.muted,
        sourceNotifications: options.sourceNotifications,
        larkAuth: profiles(options.profile)?.larkAuth,
      }),
    }),
  };
}

export function createMonitorRuntime(context: { configPath: string; rootDir?: string; profiles: LarkMonitorProfiles; host?: MonitorHost }) {
  const host = context.host ?? createMonitorHost(context.configPath, context.rootDir, context.profiles);
  return new MonitorRuntime({ configPath: context.configPath, rootDir: context.rootDir, host }, monitorModules(context.profiles));
}
