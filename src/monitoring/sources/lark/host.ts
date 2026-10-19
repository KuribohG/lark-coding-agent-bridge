import type { ProfileConfig } from '../../../config/profile-schema';
import type { AppConfig } from '../../../config/schema';

export interface LarkMonitorProfile {
  profileConfig: ProfileConfig;
  cfg: AppConfig;
  botIdentity?: { openId: string; name?: string };
}
export type LarkMonitorProfiles = (profile: string) => LarkMonitorProfile | undefined;
