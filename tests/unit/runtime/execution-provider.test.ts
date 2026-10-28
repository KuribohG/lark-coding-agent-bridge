import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ProfileExecutionProvider } from '../../../src/plugins/work-items/execution-provider';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { createRootConfig, saveRootConfig } from '../../../src/config/profile-store';
import type { AgentAdapter } from '../../../src/agent/types';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

it('loads a configured executor without a messaging connection and reports binary availability independently', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'execution-provider-')); cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'config.json');
  const root = createRootConfig('local', createDefaultProfileConfig({ agentKind: 'claude', accounts: { app: { id: 'cli_fixture', secret: 'fixture', tenant: 'feishu' } } }));
  await saveRootConfig(root, path);
  let available = false;
  const createAgent = vi.fn(() => ({ id: 'claude', displayName: 'Claude', isAvailable: async () => available } as AgentAdapter));
  const provider = new ProfileExecutionProvider(path, dir, createAgent);
  expect(await provider.resolve('missing')).toBeUndefined();
  expect(createAgent).not.toHaveBeenCalled();
  expect(await provider.resolve('local')).toMatchObject({ available: false });
  available = true;
  const executor = await provider.resolve('local');
  expect(executor?.available).toBe(true);
  expect(executor?.config).not.toHaveProperty('accounts');
  expect(executor?.config).not.toHaveProperty('larkCli');
  const samePolicy = await provider.resolve('local');
  expect(samePolicy?.signal).toBe(executor?.signal);
  expect(executor?.signal?.aborted).toBe(false);
  root.profiles.local!.mode = 'team'; await saveRootConfig(root, path);
  expect(await provider.resolve('local')).toBeUndefined();
  expect(executor?.signal?.aborted).toBe(true);
});
