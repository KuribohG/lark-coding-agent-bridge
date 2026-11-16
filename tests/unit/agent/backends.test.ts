import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AGENT_KINDS,
  backendFor,
  capabilityForProfile,
  executionCapabilitiesForProfile,
} from '../../../src/agent/backends';
import { PiAdapter } from '../../../src/agent/pi/adapter';
import { PiSdkAdapter } from '../../../src/agent/pi-sdk/adapter';
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

// CI hosts have no agent CLIs installed; treat every binary as present.
vi.mock('../../../src/agent/preflight', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../src/agent/preflight')>(),
  checkAgentAvailability: vi.fn(async () => ({ ok: true as const })),
}));

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe('agent backend registry', () => {
  it.each([undefined, true, false])('honors Codex home inheritance with inheritCodexHome=%s', async (inheritCodexHome) => {
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

    (await adapter.prepareRun({ runId: 'test', cwd: process.cwd(), prompt: 'hello' })).start();

    expect(startAppServerRun).toHaveBeenCalledWith(expect.objectContaining({
      env: expect.objectContaining({
        CODEX_HOME: inheritCodexHome === true ? nativeHome : join(profileDir, 'codex-home'),
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

  it('selects the pi SDK transport and its steering capability from launch config', () => {
    const profile = createDefaultProfileConfig({
      agentKind: 'pi',
      accounts: {
        app: { id: 'cli_test', secret: '${APP_SECRET}', tenant: 'feishu' },
      },
      pi: {
        binaryPath: '/usr/local/bin/pi',
        transport: 'sdk',
        sdkPath: '/opt/pi/dist/index.js',
        nodePath: '/opt/node/bin/node',
      },
    });

    expect(executionCapabilitiesForProfile(profile)).toEqual({ finalAnswer: 'separate-event', input: 'active-turn' });
    const adapter = backendFor('pi').createAdapter({ profile, profileDir: '/tmp/profile', env: {}, systemPrompt: '' });
    expect(adapter).toBeInstanceOf(PiSdkAdapter);
    expect(adapter.capabilities).toEqual({ finalAnswer: 'separate-event', input: 'active-turn' });
  });

  it('keeps the pi CLI transport when transport is absent', () => {
    const profile = createDefaultProfileConfig({
      agentKind: 'pi',
      accounts: {
        app: { id: 'cli_test', secret: '${APP_SECRET}', tenant: 'feishu' },
      },
      pi: { binaryPath: '/usr/local/bin/pi' },
    });

    expect(executionCapabilitiesForProfile(profile)).toEqual({ finalAnswer: 'separate-event', input: 'unsupported' });
    const adapter = backendFor('pi').createAdapter({ profile, profileDir: '/tmp/profile', env: {}, systemPrompt: '' });
    expect(adapter).toBeInstanceOf(PiAdapter);
  });
});
