import { codexExecutionCapabilities } from '../agent/codex/capabilities';
import { CLAUDE_EXECUTION_CAPABILITIES } from '../agent/claude/capabilities';
import type { AgentExecutionCapabilities } from '../agent/types';
import type { ProfileConfig } from '../config/profile-schema';

/** Profile-time discovery uses the same declaration as the configured adapter. */
export function profileExecutionCapabilities(profile: ProfileConfig): AgentExecutionCapabilities {
  return profile.agentKind === 'codex'
    ? codexExecutionCapabilities(profile.codex?.transport)
    : CLAUDE_EXECUTION_CAPABILITIES;
}

export function supportsBackgroundProfile(profile: ProfileConfig): boolean {
  return profile.mode !== 'team' && profileExecutionCapabilities(profile).finalAnswer === 'separate-event';
}
