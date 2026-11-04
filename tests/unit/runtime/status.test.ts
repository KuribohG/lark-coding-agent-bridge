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
      configFileChangedSinceApply: true,
      matchesStatusBuild: false,
    });
    expect(report.summary).toEqual({
      processCount: 1,
      onlineCount: 1,
      serviceManagedCount: 1,
      configChangedSinceStartCount: 1,
      configNotAppliedCount: 1,
      configPendingRestartCount: 0,
      buildMismatchCount: 1,
      busyCount: 0,
      idleUnknownCount: 1,
    });
    expect(report.processes[0]!.idle).toBeNull();
  });

  it('derives idleness from fresh activity snapshots only', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bridge-status-'));
    dirs.push(root);
    const configPath = join(root, 'config.toml');
    await writeFile(configPath, 'version = 3\n');
    const registryFile = join(root, 'processes.json');
    const quiet = { runs: 0, turns: 0, queuedMessages: 0, sideQuestions: 0, workflowScripts: 0, workflowTasks: 0, newRunsPaused: false };
    const now = new Date().toISOString();
    await writeFile(registryFile, JSON.stringify({ entries: [
      registryEntry({ id: 'idle', configPath, activity: quiet, activityAt: now }),
      registryEntry({ id: 'busy', configPath, activity: { ...quiet, turns: 1 }, activityAt: now }),
      registryEntry({ id: 'queued', configPath, activity: { ...quiet, queuedMessages: 2 }, activityAt: now }),
      registryEntry({ id: 'stale', configPath, activity: quiet, activityAt: new Date(Date.now() - 10 * 60_000).toISOString() }),
    ] }));

    const report = await collectBridgeStatus({ registryFile });

    expect(Object.fromEntries(report.processes.map(item => [item.id, item.idle])))
      .toEqual({ idle: true, busy: false, queued: false, stale: null });
    expect(report.summary).toMatchObject({ busyCount: 2, idleUnknownCount: 1 });
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
