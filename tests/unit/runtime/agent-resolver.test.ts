import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProfileExecutionController } from '../../../src/runtime/execution-controller';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { resolveAppPaths } from '../../../src/config/app-paths';
import { ScopeExecutionStore } from '../../../src/session/scope-execution';
import { createTmpProfile } from '../../helpers/tmp-profile';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('ProfileExecutionController', () => {
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
    const resolver = new ProfileExecutionController({
      profileConfig: profile,
      scopeExecution: store,
      appPaths: paths,
      systemPrompt: '',
    });

    expect(resolver.kindFor('chat')).toBe('codex');
    expect(resolver.kindFor('chat:topic-pi')).toBe('pi');
    expect(resolver.get('chat').id).toBe('codex');
    expect(resolver.get('chat:topic-pi').id).toBe('pi');
    expect(resolver.get('chat', 'pi').id).toBe('pi');
    expect(resolver.kindFor('chat')).toBe('codex');
    expect(store.get('chat')).toBeUndefined();
    expect(resolver.profileFor('chat:topic-pi').agentKind).toBe('pi');
    expect(resolver.capabilityFor('chat:topic-pi')).toMatchObject({
      agentId: 'pi',
      sessionIdField: 'sessionId',
    });

    await resolver.setScopeKind('chat:new-topic', 'pi');
    expect(store.get('chat:new-topic')).toBe('pi');
    await resolver.setScopeKind('chat:new-topic', 'codex');
    expect(store.get('chat:new-topic')).toBeUndefined();
  });

  it('rejects an engine whose sandbox cannot honor the profile access mode', async () => {
    const tmp = await createTmpProfile('agent-resolver-access-');
    cleanups.push(tmp.cleanup);
    const binDir = join(tmp.root, 'bin');
    await mkdir(binDir);
    const pi = join(binDir, 'pi');
    await writeFile(pi, '#!/bin/sh\necho pi-test\n', 'utf8');
    await chmod(pi, 0o755);
    const profile = createDefaultProfileConfig({
      agentKind: 'claude',
      accounts: { app: { id: 'cli_test', secret: '${APP_SECRET}', tenant: 'feishu' } },
      permissions: { defaultAccess: 'workspace', maxAccess: 'workspace' },
      pi: { binaryPath: pi },
    });
    const paths = resolveAppPaths({ rootDir: tmp.root, profile: 'claude' });
    const store = new ScopeExecutionStore(join(paths.profileDir, 'scope-execution.json'));
    await store.load();
    const resolver = new ProfileExecutionController({
      profileConfig: profile,
      scopeExecution: store,
      appPaths: paths,
      systemPrompt: '',
    });

    await expect(resolver.setScopeKind('chat:pi', 'pi')).rejects.toThrow(/does not support workspace access/);
    expect(store.get('chat:pi')).toBeUndefined();
    const previous = resolver.defaultAgent();
    await expect(resolver.setDefaultProfile({ ...profile, agentKind: 'pi' })).rejects.toThrow(/does not support workspace access/);
    expect(resolver.defaultAgentKind).toBe('claude');
    expect(resolver.defaultAgent()).toBe(previous);
  });

  it('reconfigures launch settings make-before-break and keeps unaffected engines', async () => {
    const tmp = await createTmpProfile('agent-resolver-reconfigure-');
    cleanups.push(tmp.cleanup);
    const binDir = join(tmp.root, 'bin');
    await mkdir(binDir);
    const [codexA, codexB, pi] = ['codex-a', 'codex-b', 'pi'].map(name => join(binDir, name));
    for (const bin of [codexA, codexB, pi]) {
      await writeFile(bin!, '#!/bin/sh\necho test 0.1\n', 'utf8');
      await chmod(bin!, 0o755);
    }
    const profile = createDefaultProfileConfig({
      agentKind: 'codex',
      accounts: { app: { id: 'cli_test', secret: '${APP_SECRET}', tenant: 'feishu' } },
      codex: { binaryPath: codexA! },
      pi: { binaryPath: pi! },
    });
    const paths = resolveAppPaths({ rootDir: tmp.root, profile: 'codex' });
    const resolver = new ProfileExecutionController({ profileConfig: profile, appPaths: paths, systemPrompt: '', env: { PATH: process.env.PATH } });
    const previousCodex = resolver.defaultAgent();
    const previousPi = resolver.get('chat', 'pi');

    await expect(resolver.reconfigure({ ...profile, codex: { binaryPath: join(binDir, 'missing') } })).rejects.toThrow();
    expect(resolver.defaultAgent()).toBe(previousCodex);
    expect(resolver.profileFor('chat').codex?.binaryPath).toBe(codexA);

    await resolver.reconfigure({ ...profile, codex: { binaryPath: codexB! } });
    expect(resolver.defaultAgent()).not.toBe(previousCodex);
    expect(resolver.profileFor('chat').codex?.binaryPath).toBe(codexB);
    expect(resolver.get('chat', 'pi')).toBe(previousPi);

    await resolver.reconfigure({ ...profile, codex: { binaryPath: codexB! }, permissions: { defaultAccess: 'read-only', maxAccess: 'full' } });
    expect(resolver.get('chat', 'pi')).not.toBe(previousPi);
  });
});
