import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AGENT_KINDS,
  backendFor,
  capabilityForProfile,
} from '../../../src/agent/backends';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { startAppServerRun } from '../../../src/agent/codex/app-server';

vi.mock('../../../src/agent/codex/app-server', () => ({
  startAppServerRun: vi.fn(() => ({
    runId: 'test',
    events: (async function* () {})(),
    stop: async () => {},
    waitForExit: async () => true,
  })),
}));

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe('agent backend registry', () => {
  it.each([undefined, true, false])('honors Codex home inheritance with inheritCodexHome=%s', (inheritCodexHome) => {
    const nativeHome = join(process.cwd(), 'native-codex-home');
    const profileDir = join(process.cwd(), 'web-state');
    vi.stubEnv('CODEX_HOME', nativeHome);
    const adapter = backendFor('codex').createAdapter({
      profile: {
        agentKind: 'codex',
        permissions: { defaultAccess: 'workspace', maxAccess: 'workspace' },
        codex: { binaryPath: 'codex', inheritCodexHome },
      },
      profileDir,
      env: {},
      systemPrompt: '',
    });

    adapter.run({ runId: 'test', cwd: process.cwd(), prompt: 'hello' });

    expect(startAppServerRun).toHaveBeenCalledWith(expect.objectContaining({
      env: expect.objectContaining({
        CODEX_HOME: inheritCodexHome === false ? join(profileDir, 'codex-home') : nativeHome,
      }),
      sandbox: 'workspace-write',
    }));
  });

  it('declares every supported backend through one metadata contract', () => {
    expect(AGENT_KINDS).toEqual(['claude', 'codex', 'pi', 'agy']);
    expect(AGENT_KINDS.map((kind) => backendFor(kind).displayName)).toEqual([
      'Claude Code',
      'Codex CLI',
      'Pi Coding Agent',
      'Antigravity CLI',
    ]);
    expect(AGENT_KINDS.map((kind) => backendFor(kind).commandEnv)).toEqual([
      'LARK_CHANNEL_CLAUDE_BIN',
      'LARK_CHANNEL_CODEX_BIN',
      'LARK_CHANNEL_PI_BIN',
      'LARK_CHANNEL_AGY_BIN',
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
