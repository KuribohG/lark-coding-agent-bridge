import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { openExecution, rebuildExecution } from '../../../src/runtime/execution-host';
import { SCOPE_AGENTS_FILE } from '../../../src/session/scope-execution';
import { createTmpProfile } from '../../helpers/tmp-profile';

const availability = vi.hoisted(() => vi.fn());
vi.mock('../../../src/runtime/agent-runtime', () => ({ checkRuntimeAgentAvailability: availability }));

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()));
});

async function host() {
  const tmp = await createTmpProfile('execution-host-');
  cleanups.push(tmp.cleanup);
  await mkdir(tmp.profile, { recursive: true });
  const profileConfig = createDefaultProfileConfig({
    agentKind: 'codex',
    accounts: { app: { id: 'cli_test', secret: '${APP_SECRET}', tenant: 'feishu' } },
    codex: { binaryPath: 'codex' },
  });
  return { options: { profileConfig, appPaths: { profileDir: tmp.profile }, systemPrompt: '' }, dir: tmp.profile };
}

describe('openExecution', () => {
  it('loads the conversations\' engine choices from the host state directory and checks the default engine', async () => {
    const { options, dir } = await host();
    await writeFile(join(dir, SCOPE_AGENTS_FILE), JSON.stringify({ version: 1, scopes: { 'chat:a': 'pi' } }));
    availability.mockResolvedValue({ ok: true });

    const { execution, scopeExecution } = await openExecution(options);

    expect(execution.kindFor('chat:a')).toBe('pi');
    expect(execution.kindFor('chat:b')).toBe('codex');
    expect(availability).toHaveBeenCalledOnce();

    await execution.setScopeKind('chat:b', 'claude');
    expect(rebuildExecution(options, scopeExecution).kindFor('chat:b')).toBe('claude');
    expect((await openExecution(options)).execution.kindFor('chat:b')).toBe('claude');
  });

  it('refuses a host whose default engine is unavailable unless the check is skipped', async () => {
    const { options } = await host();
    const error = new Error('codex missing');
    availability.mockResolvedValue({ ok: false, error });

    await expect(openExecution(options)).rejects.toBe(error);
    await expect(openExecution(options, { preflight: false })).resolves.toBeDefined();
    expect(availability).toHaveBeenCalledOnce();
  });
});
