import { InboxManager } from './manager';
import type { LarkMonitorProfiles } from './host';
import type { MonitorModule } from '../../module';

export const larkMonitor = (profiles: LarkMonitorProfiles): MonitorModule<InboxManager> => ({
  id: 'lark',
  create: c => new InboxManager(c.configPath, profiles, c.rootDir, c.sources),
});
