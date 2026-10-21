import type { ProfileConfig } from '../../../config/profile-schema';
import type { AppConfig } from '../../../config/schema';
import type { LarkProfileAuth } from '../../../lark-auth/profile-auth';

export interface LarkMonitorProfile {
  profileConfig: ProfileConfig;
  cfg: AppConfig;
  botIdentity?: { openId: string; name?: string };
  larkAuth?: LarkProfileAuth;
}
export type LarkMonitorProfiles = (profile: string) => LarkMonitorProfile | undefined;
