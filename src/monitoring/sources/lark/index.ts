import { InboxManager } from './manager';
import type { MonitorModule } from '../../module';

export const larkMonitor: MonitorModule<InboxManager> = {
  id: 'lark',
  create: c => new InboxManager(c.configPath, c.controls, c.rootDir, c.sources),
};
