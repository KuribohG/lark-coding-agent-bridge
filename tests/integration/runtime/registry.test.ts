import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { configRevision } from '../../../src/config/revision';
import {
  readAndPrune,
  register,
  unregister,
  type ProcessEntry,
} from '../../../src/runtime/registry';

const roots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await import('node:fs/promises').then((fs) =>
    fs.mkdtemp(join(tmpdir(), 'bridge-registry-')),
  );
  roots.push(root);
  return root;
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('process registry', () => {
  it('read path does not prune or rewrite stale entries', async () => {
    const root = await makeRoot();
    const registryFile = join(root, 'registry', 'processes.json');
    const body = {
      entries: [
        entry({ id: 'dead', pid: 999_999_999, profileName: 'claude', agentKind: 'claude' }),
        entry({ id: 'self', pid: process.pid, profileName: 'codex', agentKind: 'codex' }),
      ],
    };
    await writeJson(registryFile, body);
    const before = await readFile(registryFile, 'utf8');

    const live = readAndPrune(registryFile);

    expect(live.map((item) => item.id)).toEqual(['dead', 'self']);
    expect(await readFile(registryFile, 'utf8')).toBe(before);
  });

  it('write path prunes entries with stale profile/app locks and records profile plus agent identity', async () => {
    const root = await makeRoot();
    const registryFile = join(root, 'registry', 'processes.json');
    const configPath = join(root, 'config.toml');
    const configText = 'version = 3\n';
    vi.stubEnv('LARK_BUILD_COMMIT', 'registry-commit');
    vi.stubEnv('LARK_BUILD_TIME', '2026-10-28T11:00:00.000Z');
    await writeFile(configPath, configText);
    await writeJson(registryFile, {
      entries: [entry({ id: 'dead', pid: 999_999_999, profileName: 'claude', agentKind: 'claude' })],
    });

    const registered = await register({
      appId: 'cli_test',
      tenant: 'feishu',
      configPath,
      version: '0.1.32',
      profileName: 'codex-dev',
      agentKind: 'codex',
      registryFile,
    });

    const persisted = JSON.parse(await readFile(registryFile, 'utf8')) as { entries: ProcessEntry[] };
    expect(persisted.entries).toHaveLength(1);
    expect(persisted.entries[0]).toMatchObject({
      id: registered.id,
      appId: 'cli_test',
      tenant: 'feishu',
      profileName: 'codex-dev',
      agentKind: 'codex',
      pid: process.pid,
      buildCommit: 'registry-commit',
      buildTime: '2026-10-28T11:00:00.000Z',
      nodeVersion: process.version,
      startupConfigRevision: configRevision(configText),
    });

    await unregister(registered.id, registryFile);
  });
});

function entry(overrides: Partial<ProcessEntry>): ProcessEntry {
  return {
    id: 'id',
    pid: process.pid,
    appId: 'cli_test',
    tenant: 'feishu',
    configPath: '/tmp/config.json',
    startedAt: new Date().toISOString(),
    version: '0.1.32',
    profileName: 'claude',
    agentKind: 'claude',
    ...overrides,
  };
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
