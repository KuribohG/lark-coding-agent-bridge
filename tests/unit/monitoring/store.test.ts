import { encodeFixture, decodeFixture } from '../../helpers/config-fixture';
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
import { loadMonitorRoot, monitorSectionErrors, saveMonitorRoot } from '../../../src/monitoring/store';
import { checkMonitors, configureMonitors, statusMonitors } from '../../../src/cli/commands/monitors';
import { configureCiWatch } from '../../../src/cli/commands/ci-watch';
import { validateWorkItemsAction } from '../../../src/plugins/work-items/plugin';
import * as atomic from '../../../src/platform/atomic-write';
import { workItemTarget } from '../../../src/inbox/lark-target';
import { saveWithMonitors } from '../../helpers/monitors';

const folders: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(folders.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function setup(withFile = true) {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const folder = await mkdtemp(join(tmpdir(), 'monitors-')); folders.push(folder);
  const path = join(folder, 'config.toml'); const file = join(folder, 'monitors.toml');
  const root = createRootConfig('codex', createDefaultProfileConfig({ agentKind: 'codex', codex: { binaryPath: 'codex' },
    accounts: { app: { id: 'cli_fixture', secret: 'PRIVATE_APP_SECRET', tenant: 'feishu' } } }));
  root.modelServices = { screen: { protocol: 'responses', baseUrl: 'https://model.test/v1', model: 'screen', apiKey: { source: 'env', id: 'MONITOR_TEST_KEY' } } };
  root.inbox = normalizeInbox({ enabled: true, executorProfile: 'codex', recipientKey: 'ou_owner', triageService: 'screen',
    target: workItemTarget({ chatId: 'oc_group', threadId: 'omt_topic', replyTo: 'om_message' }), intakeScope: 'private_mentions' });
  root.gitlabCi = normalizeGitLabCi({ enabled: true, executorProfile: 'codex', url: 'https://gitlab.test', outputDir: folder,
    credentialsFile: join(folder, 'credentials.env'), repositories: [{ project: 'group/repo', refs: ['dev'] }] });
  if (withFile) await saveWithMonitors(root, path);
  else await saveRootConfig(root, path);
  return { root, path, file };
}

it('creates monitors.toml on the first save without touching root secrets or state files', async () => {
  const s = await setup(false);
  const state = join(dirname(s.path), 'state.json'); await writeFile(state, 'fixture-state');
  const root = (await loadMonitorRoot(s.path))!;
  expect(root.inbox).toBeUndefined();
  Object.assign(root, { inbox: s.root.inbox, gitlabCi: s.root.gitlabCi });
  await withConfigFileLock(s.path, () => saveMonitorRoot(root, s.path));
  expect((await loadRootConfig(s.path))!.monitorConfigFile).toBe('monitors.toml');
  const loaded = (await loadMonitorRoot(s.path))!;
  expect(loaded.inbox).toEqual(s.root.inbox); expect(loaded.gitlabCi).toEqual(s.root.gitlabCi);
  expect(await readFile(s.file, 'utf8')).not.toContain('PRIVATE_APP_SECRET');
  expect(await readFile(state, 'utf8')).toBe('fixture-state');
  if (process.platform !== 'win32') expect((await stat(s.file)).mode & 0o777).toBe(0o600);
});

it('refuses to adopt an unreferenced monitors.toml on the first save', async () => {
  const s = await setup(false); const before = await readFile(s.path, 'utf8'); await writeFile(s.file, '# user file');
  const root = (await loadMonitorRoot(s.path))!; root.inbox = s.root.inbox;
  await expect(saveMonitorRoot(root, s.path)).rejects.toThrow('monitors configure');
  expect(await readFile(s.path, 'utf8')).toBe(before); expect(await readFile(s.file, 'utf8')).toBe('# user file');
});

it('edits concurrency independently of source settings and never copies it into the root config', async () => {
  const s = await setup();
  const root = (await loadMonitorRoot(s.path))!;
  root.workItemConcurrency = { analysis: 7, triage: 9 }; await saveMonitorRoot(root, s.path);
  expect((await loadMonitorRoot(s.path))?.workItemConcurrency).toEqual({ analysis: 7, triage: 9 });
  expect((await loadMonitorRoot(s.path))?.inbox).toEqual(s.root.inbox);
  root.workItemConcurrency = { analysis: 99, triage: 99 };
  await saveRootConfig(root, s.path);
  expect((await loadRootConfig(s.path))?.workItemConcurrency).toBeUndefined();
  await writeFile(s.file, 'version = 1\n[sources]');
  expect((await loadMonitorRoot(s.path))?.workItemConcurrency).toBeUndefined();
});

it('never copies monitor settings into the root config on unrelated root edits', async () => {
  const s = await setup(); const root = (await loadMonitorRoot(s.path))!;
  root.inbox!.pollSeconds = 2; await saveMonitorRoot(root, s.path);
  const before = await readFile(s.file, 'utf8');
  root.profiles.codex!.preferences.model = 'another-model'; await saveRootConfig(root, s.path);
  expect(await readFile(s.file, 'utf8')).toBe(before);
  expect((await loadRootConfig(s.path))!.inbox).toBeUndefined();
  expect((await loadMonitorRoot(s.path))!.inbox?.pollSeconds).toBe(2);
});

it('updates a source in the TOML while preserving other sources and the original comments in a backup', async () => {
  const s = await setup();
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
  const s = await setup();
  const root = (await loadMonitorRoot(s.path))!; root.inbox!.enabled = false;
  const changed = '# edited outside the bridge\n' + await readFile(s.file, 'utf8'); await writeFile(s.file, changed);
  await expect(saveMonitorRoot(root, s.path)).rejects.toThrow('已被修改');
  expect(await readFile(s.file, 'utf8')).toBe(changed);
});

it('does not accept failed saves or lose the current configuration', async () => {
  const s = await setup();
  const before = await readFile(s.file, 'utf8'); const root = (await loadMonitorRoot(s.path))!; root.inbox!.enabled = false;
  const write = atomic.writeFileAtomic;
  vi.spyOn(atomic, 'writeFileAtomic').mockImplementation((path, data, opts) => path === s.file ? Promise.reject(Error('disk full')) : write(path, data, opts));
  await expect(saveMonitorRoot(root, s.path)).rejects.toThrow('disk full');
  expect(await readFile(s.file, 'utf8')).toBe(before);
});

it('disables an invalid section and rejects a missing selected TOML', async () => {
  const s = await setup();
  await writeFile(s.file, 'version = 1\n[sources.lark]\nenabled = "wrong"');
  // The invalid section is disabled because nothing good was loaded before.
  const partial = (await loadMonitorRoot(s.path))!;
  expect(partial.inbox).toBeUndefined();
  expect(monitorSectionErrors(partial).lark).toContain('enabled');
  await expect(checkMonitors(s.file, { config: s.path })).rejects.toThrow('enabled');
  expect((await loadRootConfig(s.path))!.profiles.codex).toBeDefined();
  await rm(s.file);
  await expect(loadMonitorRoot(s.path)).rejects.toThrow('监控配置文件不存在');
});

it('validates and activates a custom file relative to the root directory without importing missing sources', async () => {
  const s = await setup(); const custom = join(dirname(s.path), 'custom.toml');
  await writeFile(custom, 'version = 1\n[sources.gitlab_ci]\nenabled = false');
  await checkMonitors(custom, { config: s.path });
  expect((await loadRootConfig(s.path))!.monitorConfigFile).toBe('monitors.toml');
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
  expect((await loadRootConfig(s.path))!.monitorConfigFile).toBe('monitors.toml');
});

it('routes the existing CI configure command to TOML without replacing Lark settings', async () => {
  const s = await setup();
  const ci = join(dirname(s.path), 'ci.json'); await writeFile(ci, encodeFixture({ ...s.root.gitlabCi, pollSeconds: 9 }));
  await configureCiWatch(ci, { config: s.path });
  expect(parseMonitorConfig(await readFile(s.file, 'utf8')).gitlabCi?.pollSeconds).toBe(9);
  expect((await loadMonitorRoot(s.path))!.inbox).toEqual(s.root.inbox);
  expect((await loadRootConfig(s.path))!.gitlabCi).toBeUndefined();
});

it('protects a screening service referenced only from TOML from removal', async () => {
  const s = await setup();
  s.root.modelServices = { screen: { protocol: 'responses', baseUrl: 'https://model.test/v1', model: 'small', apiKey: { source: 'env', id: 'MODEL_KEY' } } };
  s.root.inbox!.triageService = 'screen'; await saveWithMonitors(s.root, s.path);
  await expect(validateWorkItemsAction(
    { configPath: s.path },
    { type: 'model-service.remove', resource: 'screen' },
  )).rejects.toThrow('仍引用');
  expect((await loadRootConfig(s.path))!.modelServices?.screen).toBeDefined();
});

it('keeps UID subscriptions when another source or profile saves the shared configuration', async () => {
  const s = await setup();
  s.root.storageMonitor = parseStorageConfig({ executorProfile: 'codex', clusters: [{ id: 'c', database: 'db', datasource: 'metrics' }],
    platforms: [{ id: 'p', datasource: 'tasks' }], watches: [{ id: 'u', kind: 'user', platform: 'p', uid: 42, clusters: ['c'] }] });
  await saveWithMonitors(s.root, s.path);
  let root = (await loadMonitorRoot(s.path))!; root.inbox!.enabled = false; await saveMonitorRoot(root, s.path);
  root = (await loadMonitorRoot(s.path))!;
  expect(root.storageMonitor).toEqual(s.root.storageMonitor);
  await saveRootConfig(root, s.path);
  expect(decodeFixture(await readFile(s.path, 'utf8')).storageMonitor).toBeUndefined();
  expect((await loadMonitorRoot(s.path))!.storageMonitor).toEqual(s.root.storageMonitor);
});

it('keeps each monitor source on its last good config when only that section breaks', async () => {
  const s = await setup();
  const good = (await loadMonitorRoot(s.path))!;
  const text = await readFile(s.file, 'utf8');
  await writeFile(s.file, text.replace(/\[sources\.gitlab_ci\]\n/, '[sources.gitlab_ci]\nunknownKey = 1\n'));
  const partial = (await loadMonitorRoot(s.path))!;
  expect(monitorSectionErrors(partial).gitlab_ci).toContain('unknownKey');
  expect(monitorSectionErrors(partial).lark).toBeUndefined();
  expect(partial.gitlabCi).toEqual(good.gitlabCi);
  expect(partial.inbox).toEqual(good.inbox);
  partial.inbox!.analysisTimeoutMinutes = 9;
  await expect(saveMonitorRoot(partial, s.path)).rejects.toThrow('gitlab_ci');
  await writeFile(s.file, text);
  expect(monitorSectionErrors(await loadMonitorRoot(s.path))).toEqual({});
});

it('keeps monitors running on the last good root config when config.toml becomes invalid', async () => {
  const s = await setup();
  const before = (await loadMonitorRoot(s.path))!;
  await writeFile(s.path, `not_a_setting = 1\n${await readFile(s.path, 'utf8')}`);
  const after = (await loadMonitorRoot(s.path))!;
  expect(after.gitlabCi).toEqual(before.gitlabCi);
  await expect(loadRootConfig(s.path)).rejects.toThrow('not_a_setting');
});

it('disables only the monitor source whose executor profile is gone', async () => {
  const s = await setup();
  await writeFile(s.file, formatMonitorConfig({ ...s.root, gitlabCi: { ...s.root.gitlabCi!, executorProfile: 'missing' } }));
  const partial = (await loadMonitorRoot(s.path))!;
  expect(monitorSectionErrors(partial).gitlab_ci).toContain('executorProfile');
  expect(partial.gitlabCi).toBeUndefined();
  expect(partial.inbox?.executorProfile).toBe('codex');
  await expect(saveMonitorRoot(partial, s.path)).rejects.toThrow('gitlab_ci');
});
