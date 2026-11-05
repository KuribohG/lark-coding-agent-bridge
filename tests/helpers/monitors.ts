import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { RootConfig } from '../../src/config/profile-schema';
import { saveRootConfig } from '../../src/config/profile-store';
import { formatMonitorConfig } from '../../src/monitoring/config';

/** Persist the root plus its monitoring settings in monitors.toml beside it; `root` keeps both. */
export async function saveWithMonitors(root: RootConfig, path: string): Promise<void> {
  root.monitorConfigFile ??= 'monitors.toml';
  const { inbox, gitlabCi, storageMonitor, workItemConcurrency } = root;
  await writeFile(join(dirname(path), root.monitorConfigFile), formatMonitorConfig(root), { mode: 0o600 });
  await saveRootConfig(root, path);
  Object.assign(root, { inbox, gitlabCi, storageMonitor, workItemConcurrency });
}
