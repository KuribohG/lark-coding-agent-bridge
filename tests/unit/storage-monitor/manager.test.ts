import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRootConfig, saveRootConfig } from '../../../src/config/profile-store';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { formatMonitorConfig } from '../../../src/monitoring/config';
import { parseStorageConfig } from '../../../src/monitoring/sources/storage/config';
import { StorageMonitorManager } from '../../../src/monitoring/sources/storage/manager';
import type { WorkItemSources } from '../../../src/work-items/registry';
import type { Controls } from '../../../src/commands';

const mocks = vi.hoisted(() => ({ credentials: vi.fn(async () => ({ url: 'https://grafana.test', headers: {} })) }));
vi.mock('../../../src/monitoring/sources/storage/grafana', () => ({ grafanaCredentials: mocks.credentials, GrafanaQueryClient: class {} }));
vi.mock('../../../src/monitoring/sources/storage/provider', () => ({ GrafanaStorageProvider: class {
  async cluster(c: { id: string }) { return { id: c.id, at: Date.now(), connectedNodes: 10, io: [] }; }
  async tasks() { return []; }
} }));
vi.mock('../../../src/runtime/background-model', () => ({ backgroundModelSettings: async () => ({ model: 'deepseek-flash' }) }));
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); vi.clearAllMocks(); });

it('retains the last valid collector on a TOML typo and keeps disabled source items accessible', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'storage-manager-')); cleanup.push(() => rm(folder, { recursive: true, force: true }));
  const path = join(folder, 'config.json'); const file = join(folder, 'monitors.toml');
  const profileConfig = createDefaultProfileConfig({ agentKind: 'codex', codex: { binaryPath: 'codex' }, accounts: { app: { id: 'cli_fixture', secret: 'fixture', tenant: 'feishu' } } });
  const root = createRootConfig('p', profileConfig); root.monitorConfigFile = 'monitors.toml'; await saveRootConfig(root, path);
  const config = parseStorageConfig({ enabled: true, executorProfile: 'p', outputDir: folder,
    clusters: [{ id: 'c', datasource: 'metrics', database: 'db' }], watches: [{ id: 'w', kind: 'cluster', cluster: 'c' }] });
  await writeFile(file, formatMonitorConfig({ storageMonitor: config }));
  const close = vi.fn(async () => {}); const connect = vi.fn(async (_options: unknown) => ({ close, observe: vi.fn() }));
  const sources = { connect, isAnalyzing: () => false } as unknown as WorkItemSources;
  const manager = new StorageMonitorManager(path, () => ({ profileConfig } as Controls), folder, sources); cleanup.push(() => manager.close());
  await manager.reconcile(); await vi.waitFor(() => expect(manager.status().state?.checkedAt).toBeGreaterThan(0));
  expect(connect).toHaveBeenCalledTimes(1); expect(connect.mock.calls[0]![0]).toMatchObject({ lane: 'incident', sourceNotifications: true });
  await writeFile(file, 'version = 1\n[sources.storage]\nenabled = "oops"'); await manager.reconcile();
  expect(manager.error).toContain('enabled'); expect(close).not.toHaveBeenCalled();
  await writeFile(file, formatMonitorConfig({ storageMonitor: { ...config, enabled: false } })); await manager.reconcile();
  expect(close).toHaveBeenCalledTimes(1); expect(connect).toHaveBeenCalledTimes(2);
  expect(connect.mock.calls[1]![0]).toMatchObject({ enabled: false });
  expect(mocks.credentials).toHaveBeenCalledTimes(1);
});
