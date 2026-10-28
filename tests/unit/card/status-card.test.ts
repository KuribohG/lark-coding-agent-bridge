import { describe, expect, it } from 'vitest';
import { statusCard } from '../../../src/card/templates';

describe('status card context usage', () => {
  it('shows context occupancy with the rest of the run status', () => {
    const card = statusCard({
      profileName: 'codex',
      cwd: '/workspace',
      sessionId: 'thread-12345678',
      sessionStale: false,
      contextUsage: '72% (720k / 1.0M tokens)',
      agentName: 'Codex',
      runtimeAccess: { label: 'sandbox', value: 'danger-full-access/danger-full-access' },
      activeRun: false,
      ownerState: 'ready owner=present',
      scope: 'oc_chat',
      chatMode: 'group',
    });

    expect(JSON.stringify(card)).toContain('72% (720k / 1.0M tokens)');
  });
});
