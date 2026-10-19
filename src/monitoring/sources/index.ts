import type { LarkMonitorProfiles } from './lark/host';
import { larkMonitor } from './lark';
import { gitlabCiMonitor } from './gitlab-ci';
import { storageMonitor } from './storage';

/** Explicit, statically linked modules. Order also defines reverse shutdown order. */
export const monitorModules = (profiles: LarkMonitorProfiles) => ({ lark: larkMonitor(profiles), gitlab_ci: gitlabCiMonitor, storage: storageMonitor });
