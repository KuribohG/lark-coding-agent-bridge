import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { resolveAppPaths } from '../../../src/config/app-paths';
import { SCOPE_AGENTS_FILE, ScopeExecutionStore } from '../../../src/session/scope-execution';
import { ProfileExecutionController } from '../../../src/runtime/execution-controller';
import { createTmpProfile } from '../../helpers/tmp-profile';
import type { AgentAdapter } from '../../../src/agent/types';

// Adapters own long-lived transports (shared codex daemon, shared pi SDK host).
// Dropping an adapter must release them, and a config swap must not cut off the
// runs that still use the old one: the adapter drains itself.
const adapters: StubAdapter[] = [];

interface StubAdapter extends AgentAdapter {
  shutdown: ReturnType<typeof vi.fn>;
}

vi.mock('../../../src/agent/backends', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/agent/backends')>();
  return { ...actual, createAgentAdapter: () => stubAdapter() };
});

function stubAdapter(): StubAdapter {
  const adapter = {
    id: 'codex',
    displayName: 'stub',
    capabilities: { finalAnswer: 'stream', input: 'active-session' },
    isAvailable: async () => true,
    checkAvailability: async () => ({ ok: true as const, version: 'stub' }),
    prepareRun: async () => { throw new Error('not used'); },
    shutdown: vi.fn(async () => {}),
  };
  adapters.push(adapter as StubAdapter);
  return adapter as StubAdapter;
}

async function controller() {
  const tmp = await createTmpProfile('execution-dispose-');
  const profile = createDefaultProfileConfig({
    agentKind: 'codex',
    accounts: { app: { id: 'cli_test', secret: '${APP_SECRET}', tenant: 'feishu' } },
    codex: { binaryPath: '/opt/codex' },
    pi: { binaryPath: '/opt/pi' },
  });
  const paths = resolveAppPaths({ rootDir: tmp.root, profile: 'codex' });
  const store = new ScopeExecutionStore(join(paths.profileDir, SCOPE_AGENTS_FILE));
  await store.load();
  const execution = new ProfileExecutionController({ profileConfig: profile, scopeExecution: store, appPaths: paths, systemPrompt: '' });
  return { tmp, profile, execution };
}

describe('adapter lifetime', () => {
  it('releases the adapter it drops on a launch reconfigure, and never the kept one', async () => {
    const { execution, profile } = await controller();
    const kept = execution.defaultAgent() as StubAdapter;
    vi.clearAllMocks();

    await execution.reconfigure({ ...profile, codex: { ...profile.codex, binaryPath: '/opt/codex-next' } });
    await vi.waitFor(() => expect(kept.shutdown).toHaveBeenCalledTimes(1));
    expect(execution.defaultAgent()).not.toBe(kept);
  });

  it('releases every adapter on dispose', async () => {
    const { execution } = await controller();
    const first = execution.defaultAgent() as StubAdapter;
    const second = execution.get('chat', 'pi') as StubAdapter;

    await execution.dispose();
    expect(first.shutdown).toHaveBeenCalledTimes(1);
    expect(second.shutdown).toHaveBeenCalledTimes(1);
  });
});
