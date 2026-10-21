import { describe, expect, it } from 'vitest';
import {
  AGENT_KINDS,
  backendFor,
  capabilityForProfile,
} from '../../../src/agent/backends';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';

describe('agent backend registry', () => {
  it('declares every supported backend through one metadata contract', () => {
    expect(AGENT_KINDS).toEqual(['claude', 'codex', 'pi']);
    expect(AGENT_KINDS.map((kind) => backendFor(kind).displayName)).toEqual([
      'Claude Code',
      'Codex CLI',
      'Pi Coding Agent',
    ]);
    expect(AGENT_KINDS.map((kind) => backendFor(kind).commandEnv)).toEqual([
      'LARK_CHANNEL_CLAUDE_BIN',
      'LARK_CHANNEL_CODEX_BIN',
      'LARK_CHANNEL_PI_BIN',
    ]);
  });

  it('derives session identity from each backend capability', () => {
    const pi = createDefaultProfileConfig({
      agentKind: 'pi',
      accounts: {
        app: { id: 'cli_test', secret: '${APP_SECRET}', tenant: 'feishu' },
      },
      pi: { binaryPath: '/usr/local/bin/pi' },
    });

    expect(capabilityForProfile(pi)).toMatchObject({
      agentId: 'pi',
      sessionIdField: 'sessionId',
      sessionKind: 'pi-session',
    });
  });
});
