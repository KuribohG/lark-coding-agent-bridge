import { larkMonitorConfig } from './lark/config';
import { gitlabMonitorConfig } from './gitlab-ci/config';
import { storageMonitorConfig } from './storage/config';
import type { MonitorSettings } from '../module';

// Keep config-only imports separate from runtime factories (CLI validation never starts collectors).
export const monitorConfigs = [larkMonitorConfig, gitlabMonitorConfig, storageMonitorConfig] as const;

type MonitorRootKey = typeof monitorConfigs[number]['key'];

/** Let the monitor registry own its feature-specific config normalization. */
export function normalizeMonitorRootValues(
  values: Partial<Record<MonitorRootKey, unknown>>,
): Partial<MonitorSettings> {
  const normalized: Partial<MonitorSettings> = {};
  for (const source of monitorConfigs) {
    const value = values[source.key];
    if (value !== undefined) {
      Object.assign(normalized, { [source.key]: source.normalize(value) });
    }
  }
  return normalized;
}
