import { describe, expect, it } from 'vitest';
import {
  AGENT_KINDS,
  agentBackendSpec,
  agentDisplayName,
  isAgentKind,
  sessionIdFieldForAgent,
} from '../../../src/agent/backend-spec';
import {
  agentLaunchPatch,
  agentStateDirectory,
  capabilityForBackend,
  withAgentBinary,
} from '../../../src/agent/capability';
import {
  createDefaultProfileConfig,
  type AgentKind,
} from '../../../src/config/profile-schema';

describe('agent backend specification', () => {
  it('is the single static metadata source for every backend', () => {
    expect(AGENT_KINDS).toEqual(['claude', 'codex', 'pi']);
    expect(AGENT_KINDS.map(agentDisplayName)).toEqual([
      'Claude Code',
      'Codex CLI',
      'Pi Coding Agent',
    ]);
    expect(AGENT_KINDS.map((kind) => agentBackendSpec(kind).stateDirectory.envName)).toEqual([
      'CLAUDE_CONFIG_DIR',
      'CODEX_HOME',
      'PI_CODING_AGENT_DIR',
    ]);
    expect(AGENT_KINDS.map(sessionIdFieldForAgent)).toEqual([
      'sessionId',
      'threadId',
      'sessionId',
    ]);
  });

  it.each(AGENT_KINDS)('derives static capability fields for %s', (kind) => {
    const spec = agentBackendSpec(kind);
    const capability = capabilityForBackend(kind, {
      permissions: { defaultAccess: 'full', maxAccess: 'full' },
    });

    expect(capability).toMatchObject({
      agentId: spec.kind,
      sessionKind: spec.sessionKind,
      sessionIdField: spec.sessionIdField,
      imageInput: spec.imageInput,
      legacySessionStore: spec.legacySessionStore,
      promptInjection: spec.promptInjection,
      supportsNativeHistory: spec.supportsNativeHistory,
    });
  });

  it('keeps launch validation and state-directory policy backend-owned', () => {
    expect(agentBackendSpec('claude').launchKeys).toContain('configDir');
    expect(agentBackendSpec('codex').launchKeys).toEqual(expect.arrayContaining([
      'transport',
      'codexHome',
      'inheritCodexHome',
    ]));
    expect(agentBackendSpec('pi').launchKeys).toContain('agentDir');
    expect(agentBackendSpec('pi').supportedAccess).toEqual(['read-only', 'full']);
    expect(agentBackendSpec('pi').webDefaultAccess).toBe('full');
  });

  it('builds binary patches and resolves configured state directories generically', () => {
    const profiles = {
      claude: createDefaultProfileConfig({
        agentKind: 'claude',
        accounts: appAccounts(),
        claude: { configDir: '/state/claude' },
      }),
      codex: createDefaultProfileConfig({
        agentKind: 'codex',
        accounts: appAccounts(),
        codex: { binaryPath: 'codex', codexHome: '/state/codex' },
      }),
      pi: createDefaultProfileConfig({
        agentKind: 'pi',
        accounts: appAccounts(),
        pi: { binaryPath: 'pi', agentDir: '/state/pi' },
      }),
    } satisfies Record<AgentKind, ReturnType<typeof createDefaultProfileConfig>>;

    expect(agentStateDirectory(profiles.claude)).toBe('/state/claude');
    expect(agentStateDirectory(profiles.codex)).toBe('/state/codex');
    expect(agentStateDirectory(profiles.pi)).toBe('/state/pi');
    expect(agentLaunchPatch('pi', '/bin/pi')).toEqual({
      pi: { binaryPath: '/bin/pi' },
    });
    expect(withAgentBinary(profiles.pi, 'pi', '/new/pi').pi).toEqual({
      binaryPath: '/new/pi',
      agentDir: '/state/pi',
    });
  });

  it('rejects unknown backend identifiers centrally', () => {
    expect(isAgentKind('codex')).toBe(true);
    expect(isAgentKind('unknown')).toBe(false);
    expect(isAgentKind(undefined)).toBe(false);
  });
});

function appAccounts() {
  return {
    app: {
      id: 'cli_test',
      secret: '${APP_SECRET}',
      tenant: 'feishu' as const,
    },
  };
}
