import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { configRevision } from '../../../src/config/revision';
import type { ProcessEntry } from '../../../src/runtime/registry';
import { collectBridgeStatus } from '../../../src/runtime/status';

const dirs: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('runtime status report', () => {
  it('describes build, service, live processes and configuration revisions', async () => {
    vi.stubEnv('LARK_BUILD_COMMIT', 'current-build');
    vi.stubEnv('LARK_BUILD_TIME', '2026-10-28T10:00:00.000Z');
    const root = await mkdtemp(join(tmpdir(), 'bridge-status-'));
    dirs.push(root);
    const configPath = join(root, 'config.toml');
    const currentConfig = 'version = 3\n';
    await writeFile(configPath, currentConfig);
    const registryFile = join(root, 'registry', 'processes.json');
    await mkdir(join(root, 'registry'), { recursive: true });
    const entry = registryEntry({
      configPath,
      buildCommit: 'old-build',
      startupConfigRevision: configRevision('version = 3\n# old\n'),
      botName: 'Bridge Bot',
    });
    await writeFile(registryFile, `${JSON.stringify({ entries: [entry] }, null, 2)}\n`);

    const report = await collectBridgeStatus({
      registryFile,
      service: {
        requested: 'supervisor',
        state: 'running',
        pid: process.pid,
        platform: 'systemd',
      },
    });

    expect(report.build).toMatchObject({
      version: '0.7.1',
      commit: 'current-build',
      builtAt: '2026-10-28T10:00:00.000Z',
    });
    expect(report.service).toMatchObject({ requested: 'supervisor', state: 'running' });
    expect(report.processes[0]).toMatchObject({
      id: 'proc-1',
      profile: 'codex',
      agentName: 'Codex CLI',
      online: true,
      managedByService: true,
      botName: 'Bridge Bot',
      buildCommit: 'old-build',
      currentConfigRevision: configRevision(currentConfig),
      configFileChangedSinceStart: true,
      matchesStatusBuild: false,
    });
    expect(report.summary).toEqual({
      processCount: 1,
      onlineCount: 1,
      serviceManagedCount: 1,
      configChangedSinceStartCount: 1,
      buildMismatchCount: 1,
    });
  });
});

function registryEntry(overrides: Partial<ProcessEntry>): ProcessEntry {
  return {
    id: 'proc-1',
    pid: process.pid,
    appId: 'cli_test',
    tenant: 'feishu',
    profileName: 'codex',
    agentKind: 'codex',
    configPath: '/tmp/config.toml',
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    version: '0.7.1',
    buildCommit: 'current-build',
    buildTime: '2026-10-28T10:00:00.000Z',
    nodeVersion: process.version,
    ...overrides,
  };
}
