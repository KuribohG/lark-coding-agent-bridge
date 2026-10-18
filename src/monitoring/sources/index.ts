import { larkMonitor } from './lark';
import { gitlabCiMonitor } from './gitlab-ci';
import { storageMonitor } from './storage';

/** Explicit, statically linked modules. Order also defines reverse shutdown order. */
export const monitorModules = { lark: larkMonitor, gitlab_ci: gitlabCiMonitor, storage: storageMonitor };
