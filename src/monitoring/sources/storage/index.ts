import { StorageMonitorManager } from './manager';
import type { MonitorModule } from '../../module';

export const storageMonitor: MonitorModule<StorageMonitorManager> = {
  id: 'storage',
  create: c => new StorageMonitorManager(c.configPath, c.host, c.sources),
};
