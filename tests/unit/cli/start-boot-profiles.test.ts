import { describe, expect, it } from 'vitest';
import { resolveSupervisorBootProfiles } from '../../../src/cli/commands/start.js';
import { createDefaultProfileConfig, type RootConfig } from '../../../src/config/profile-schema';

const profile = createDefaultProfileConfig({
  agentKind: 'codex',
  accounts: { app: { id: 'cli_test', secret: 'secret', tenant: 'feishu' } },
  codex: { binaryPath: 'codex' },
});

function root(autostartProfiles?: string[]): RootConfig {
  return {
    schemaVersion: 2,
    activeProfile: 'active',
    ...(autostartProfiles !== undefined ? { autostartProfiles } : {}),
    preferences: {},
    profiles: { active: profile, work: profile },
  };
}

describe('supervisor boot profiles', () => {
  it('uses the persisted boot set instead of the active profile', () => {
    expect(resolveSupervisorBootProfiles({
      root: root(['work']),
      resolvedProfile: 'active',
    })).toEqual(['work']);
  });

  it('keeps legacy active-profile fallback when no explicit boot set exists', () => {
    expect(resolveSupervisorBootProfiles({
      root: root(),
      resolvedProfile: 'work',
    })).toEqual(['work']);
  });

  it('lets an explicit --profile override the persisted boot set', () => {
    expect(resolveSupervisorBootProfiles({
      root: root(['active', 'work']),
      resolvedProfile: 'work',
      explicitProfile: 'work',
    })).toEqual(['work']);
  });

  it('supports an explicitly empty boot set', () => {
    expect(resolveSupervisorBootProfiles({ root: root([]), resolvedProfile: 'active' })).toEqual([]);
  });
});
