import { executionCapabilitiesForProfile } from '../agent/backends';
import type { AgentExecutionCapabilities } from '../agent/types';
import type { ProfileConfig } from '../config/profile-schema';

/** Profile-time discovery uses the same declaration as the configured adapter. */
export function profileExecutionCapabilities(profile: ProfileConfig): AgentExecutionCapabilities {
  return executionCapabilitiesForProfile(profile);
}

export function supportsBackgroundProfile(profile: ProfileConfig): boolean {
  return profile.mode !== 'team' && profileExecutionCapabilities(profile).finalAnswer === 'separate-event';
}
