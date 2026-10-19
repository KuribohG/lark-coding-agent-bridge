import { MonitorRuntime } from '../monitoring/runtime';
import { monitorModules } from '../monitoring/sources';
import type { MonitorHost } from '../monitoring/host';
import type { LarkMonitorProfiles } from '../monitoring/sources/lark/host';
import { createRuntimeAgent } from '../runtime/agent-runtime';
import { ProfileExecutionProvider } from './execution-provider';
import { createWorkItemSource } from './work-item-runtime';

export function createMonitorHost(configPath: string, rootDir?: string, profiles: LarkMonitorProfiles = () => undefined): MonitorHost {
  return {
    executors: new ProfileExecutionProvider(configPath, rootDir, (config, paths) => {
      const agent = createRuntimeAgent(config, { ...paths, configPath });
      const identity = profiles(paths.profile)?.botIdentity;
      if (identity) agent.setBotIdentity?.(identity);
      return agent;
    }),
    source: options => createWorkItemSource(options, configPath, rootDir),
  };
}

export function createMonitorRuntime(context: { configPath: string; rootDir?: string; profiles: LarkMonitorProfiles; host?: MonitorHost }) {
  const host = context.host ?? createMonitorHost(context.configPath, context.rootDir, context.profiles);
  return new MonitorRuntime({ configPath: context.configPath, rootDir: context.rootDir, host }, monitorModules(context.profiles));
}
