import { larkMonitorConfig } from './lark/config';
import { gitlabMonitorConfig } from './gitlab-ci/config';
import { storageMonitorConfig } from './storage/config';

// Keep config-only imports separate from runtime factories (CLI validation never starts collectors).
export const monitorConfigs = [larkMonitorConfig, gitlabMonitorConfig, storageMonitorConfig] as const;
