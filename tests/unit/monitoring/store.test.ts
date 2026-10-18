import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { createRootConfig, loadRootConfig, saveRootConfig, withConfigFileLock } from '../../../src/config/profile-store';
import { normalizeInbox } from '../../../src/inbox/config';
import { parseStorageConfig } from '../../../src/monitoring/sources/storage/config';
import { normalizeGitLabCi } from '../../../src/monitoring/sources/gitlab-ci/config';
import { formatMonitorConfig, parseMonitorConfig } from '../../../src/monitoring/config';
import { loadMonitorRoot, saveMonitorRoot } from '../../../src/monitoring/store';
import { checkMonitors, configureMonitors, initMonitors, statusMonitors } from '../../../src/cli/commands/monitors';
import { configureCiWatch } from '../../../src/cli/commands/ci-watch';
import { removeModelService } from '../../../src/model-service/registry';
import * as atomic from '../../../src/platform/atomic-write';

const folders: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(folders.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function setup() {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const folder = await mkdtemp(join(tmpdir(), 'monitors-')); folders.push(folder);
  const path = join(folder, 'config.json'); const file = join(folder, 'monitors.toml');
  const root = createRootConfig('codex', createDefaultProfileConfig({ agentKind: 'codex', codex: { binaryPath: 'codex' },
    accounts: { app: { id: 'cli_fixture', secret: 'PRIVATE_APP_SECRET', tenant: 'feishu' } } }));
  root.inbox = normalizeInbox({ enabled: true, executorProfile: 'codex', ownerOpenId: 'ou_owner',
    destination: { chatId: 'oc_group', threadId: 'omt_topic', replyTo: 'om_message' }, intakeScope: 'private_mentions' });
  root.gitlabCi = normalizeGitLabCi({ enabled: true, executorProfile: 'codex', url: 'https://gitlab.test', outputDir: folder,
    credentialsFile: join(folder, 'credentials.env'), repositories: [{ project: 'group/repo', refs: ['dev'] }] });
  await saveRootConfig(root, path);
  return { root, path, file };
}

it('migrates both sources without changing switches, model defaults, profiles or state files', async () => {
  const s = await setup();
  const state = join(dirname(s.path), 'state.json'); await writeFile(state, 'fixture-state');
  await initMonitors({ config: s.path });
  const raw = JSON.parse(await readFile(s.path, 'utf8'));
  expect(raw.monitorConfigFile).toBe('monitors.toml'); expect(raw.inbox).toBeUndefined(); expect(raw.gitlabCi).toBeUndefined();
  const loaded = (await loadMonitorRoot(s.path))!;
  expect(loaded.inbox).toEqual(s.root.inbox); expect(loaded.gitlabCi).toEqual(s.root.gitlabCi);
  expect(loaded.profiles).toEqual((await loadRootConfig(s.path))!.profiles);
  expect(await readFile(s.file, 'utf8')).not.toContain('PRIVATE_APP_SECRET');
  expect(await readFile(state, 'utf8')).toBe('fixture-state');
  if (process.platform !== 'win32') expect((await stat(s.file)).mode & 0o777).toBe(0o600);
  const original = await readFile(s.file, 'utf8'); await initMonitors({ config: s.path });
  expect(await readFile(s.file, 'utf8')).toBe(original);
});

it('retains JSON behavior until migration and unrelated root edits never copy monitor settings back', async () => {
  const s = await setup(); let root = (await loadMonitorRoot(s.path))!;
  root.inbox!.pollSeconds = 2; await saveMonitorRoot(root, s.path);
  expect((await loadRootConfig(s.path))!.inbox?.pollSeconds).toBe(2);
  await initMonitors({ config: s.path }); root = (await loadMonitorRoot(s.path))!;
  const before = await readFile(s.file, 'utf8');
  root.profiles.codex!.preferences.model = 'another-model'; await saveRootConfig(root, s.path);
  expect(await readFile(s.file, 'utf8')).toBe(before);
  expect((await loadRootConfig(s.path))!.inbox).toBeUndefined();
  expect((await loadMonitorRoot(s.path))!.inbox?.pollSeconds).toBe(2);
});

it('updates a source in the TOML while preserving other sources and the original comments in a backup', async () => {
  const s = await setup(); await initMonitors({ config: s.path });
  const original = '# a human note\n' + await readFile(s.file, 'utf8'); await writeFile(s.file, original);
  await withConfigFileLock(s.path, async () => {
    const root = (await loadMonitorRoot(s.path))!; root.inbox!.enabled = false; await saveMonitorRoot(root, s.path);
  });
  const updated = (await loadMonitorRoot(s.path))!;
  expect(updated.inbox?.enabled).toBe(false); expect(updated.gitlabCi).toEqual(s.root.gitlabCi);
  expect(await readFile(`${s.file}.bak`, 'utf8')).toBe(original);
  const stable = await readFile(s.file, 'utf8'); await saveMonitorRoot(updated, s.path);
  expect(await readFile(s.file, 'utf8')).toBe(stable);
});

it('rejects stale snapshots and leaves the editor change intact', async () => {
  const s = await setup(); await initMonitors({ config: s.path });
  const root = (await loadMonitorRoot(s.path))!; root.inbox!.enabled = false;
  const changed = '# edited outside the bridge\n' + await readFile(s.file, 'utf8'); await writeFile(s.file, changed);
  await expect(saveMonitorRoot(root, s.path)).rejects.toThrow('已被修改');
  expect(await readFile(s.file, 'utf8')).toBe(changed);
});

it('does not accept failed saves or lose the current configuration', async () => {
  const s = await setup(); await initMonitors({ config: s.path });
  const before = await readFile(s.file, 'utf8'); const root = (await loadMonitorRoot(s.path))!; root.inbox!.enabled = false;
  const write = atomic.writeFileAtomic;
  vi.spyOn(atomic, 'writeFileAtomic').mockImplementation((path, data, opts) => path === s.file ? Promise.reject(Error('disk full')) : write(path, data, opts));
  await expect(saveMonitorRoot(root, s.path)).rejects.toThrow('disk full');
  expect(await readFile(s.file, 'utf8')).toBe(before);
});

it('never falls back to stale JSON when the selected TOML is absent or invalid', async () => {
  const s = await setup(); await initMonitors({ config: s.path });
  await writeFile(s.file, 'version = 1\n[sources.lark]\nenabled = "wrong"');
  await expect(loadMonitorRoot(s.path)).rejects.toThrow('enabled');
  expect((await loadRootConfig(s.path))!.profiles.codex).toBeDefined();
  await rm(s.file);
  await expect(loadMonitorRoot(s.path)).rejects.toThrow('未回退');
});

it('refuses to overwrite an existing target and leaves root JSON untouched', async () => {
  const s = await setup(); const before = await readFile(s.path, 'utf8'); await writeFile(s.file, '# user file');
  await expect(initMonitors({ config: s.path })).rejects.toMatchObject({ code: 'EEXIST' });
  expect(await readFile(s.path, 'utf8')).toBe(before); expect(await readFile(s.file, 'utf8')).toBe('# user file');
});

it('validates and activates a custom file relative to the root directory without importing missing sources', async () => {
  const s = await setup(); const custom = join(dirname(s.path), 'custom.toml');
  await writeFile(custom, 'version = 1\n[sources.gitlab_ci]\nenabled = false');
  await checkMonitors(custom, { config: s.path });
  expect((await loadRootConfig(s.path))!.monitorConfigFile).toBeUndefined();
  await configureMonitors(custom, { config: s.path });
  expect((await loadRootConfig(s.path))!.monitorConfigFile).toBe('custom.toml');
  const loaded = (await loadMonitorRoot(s.path))!;
  expect(loaded.inbox).toBeUndefined(); expect(loaded.gitlabCi?.enabled).toBe(false);
  await statusMonitors({ config: s.path });
  expect(console.log).toHaveBeenLastCalledWith(expect.stringContaining('custom.toml'));
});

it('rejects invalid profile references before switching files', async () => {
  const s = await setup(); const custom = join(dirname(s.path), 'bad.toml');
  await writeFile(custom, formatMonitorConfig({ gitlabCi: { ...s.root.gitlabCi!, executorProfile: 'missing' } }));
  await expect(configureMonitors(custom, { config: s.path })).rejects.toThrow('executorProfile');
  expect((await loadRootConfig(s.path))!.monitorConfigFile).toBeUndefined();
});

it('routes the existing CI configure command to TOML without replacing Lark settings', async () => {
  const s = await setup(); await initMonitors({ config: s.path });
  const ci = join(dirname(s.path), 'ci.json'); await writeFile(ci, JSON.stringify({ ...s.root.gitlabCi, pollSeconds: 9 }));
  await configureCiWatch(ci, { config: s.path });
  expect(parseMonitorConfig(await readFile(s.file, 'utf8')).gitlabCi?.pollSeconds).toBe(9);
  expect((await loadMonitorRoot(s.path))!.inbox).toEqual(s.root.inbox);
  expect((await loadRootConfig(s.path))!.gitlabCi).toBeUndefined();
});

it('protects a screening service referenced only from TOML from removal', async () => {
  const s = await setup();
  s.root.modelServices = { screen: { protocol: 'responses', baseUrl: 'https://model.test/v1', model: 'small', apiKey: { source: 'env', id: 'MODEL_KEY' } } };
  s.root.inbox!.triageService = 'screen'; await saveRootConfig(s.root, s.path); await initMonitors({ config: s.path });
  await expect(removeModelService(s.path, 'screen')).rejects.toThrow('仍引用');
  expect((await loadRootConfig(s.path))!.modelServices?.screen).toBeDefined();
});

it('keeps UID subscriptions when another source or profile saves the shared configuration', async () => {
  const s = await setup();
  s.root.storageMonitor = parseStorageConfig({ executorProfile: 'codex', clusters: [{ id: 'c', database: 'db', datasource: 'metrics' }],
    platforms: [{ id: 'p', datasource: 'tasks' }], watches: [{ id: 'u', kind: 'user', platform: 'p', uid: 42, clusters: ['c'] }] });
  await saveRootConfig(s.root, s.path); await initMonitors({ config: s.path });
  let root = (await loadMonitorRoot(s.path))!; root.inbox!.enabled = false; await saveMonitorRoot(root, s.path);
  root = (await loadMonitorRoot(s.path))!;
  expect(root.storageMonitor).toEqual(s.root.storageMonitor);
  await saveRootConfig(root, s.path);
  expect(JSON.parse(await readFile(s.path, 'utf8')).storageMonitor).toBeUndefined();
  expect((await loadMonitorRoot(s.path))!.storageMonitor).toEqual(s.root.storageMonitor);
});
