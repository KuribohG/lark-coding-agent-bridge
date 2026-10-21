import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RuntimeAgentResolver } from '../../../src/runtime/agent-runtime';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { resolveAppPaths } from '../../../src/config/app-paths';
import { ScopeExecutionStore } from '../../../src/session/scope-execution';
import { createTmpProfile } from '../../helpers/tmp-profile';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('RuntimeAgentResolver', () => {
  it('selects adapters and capabilities independently for each scope', async () => {
    const tmp = await createTmpProfile('agent-resolver-');
    cleanups.push(tmp.cleanup);
    const binDir = join(tmp.root, 'bin');
    await mkdir(binDir);
    const codex = join(binDir, 'codex');
    const pi = join(binDir, 'pi');
    await writeFile(codex, '#!/bin/sh\necho codex-test\n', 'utf8');
    await writeFile(pi, '#!/bin/sh\necho pi-test\n', 'utf8');
    await chmod(codex, 0o755);
    await chmod(pi, 0o755);
    const profile = createDefaultProfileConfig({
      agentKind: 'codex',
      accounts: { app: { id: 'cli_test', secret: '${APP_SECRET}', tenant: 'feishu' } },
      codex: { binaryPath: codex },
      pi: { binaryPath: pi },
    });
    const paths = resolveAppPaths({ rootDir: tmp.root, profile: 'codex' });
    const store = new ScopeExecutionStore(join(paths.profileDir, 'scope-execution.json'));
    await store.load();
    await store.set('chat:topic-pi', 'pi');
    const resolver = new RuntimeAgentResolver(profile, paths, store);

    expect(resolver.kindFor('chat')).toBe('codex');
    expect(resolver.kindFor('chat:topic-pi')).toBe('pi');
    expect(resolver.get('chat').id).toBe('codex');
    expect(resolver.get('chat:topic-pi').id).toBe('pi');
    expect(resolver.capabilityFor('chat:topic-pi')).toMatchObject({
      agentId: 'pi',
      sessionIdField: 'sessionId',
    });

    await resolver.setScopeKind('chat:new-topic', 'pi');
    expect(store.get('chat:new-topic')).toBe('pi');
    await resolver.setScopeKind('chat:new-topic', 'codex');
    expect(store.get('chat:new-topic')).toBeUndefined();
  });
});
