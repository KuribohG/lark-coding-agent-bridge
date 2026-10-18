import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { Controls } from '../../../src/commands';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { createRootConfig, loadRootConfig, runtimeProfileConfig, saveRootConfig } from '../../../src/config/profile-store';
import { normalizeInbox } from '../../../src/inbox/config';
import * as runtimeAgent from '../../../src/runtime/agent-runtime';
import { InboxManager } from '../../../src/inbox/manager';
import { InboxGui } from '../../../src/inbox/gui';
import { startInboxH5 } from '../../../src/inbox/h5-server';
import { initMonitors } from '../../../src/cli/commands/monitors';
import { loadMonitorRoot } from '../../../src/monitoring/store';
import { formatMonitorConfig } from '../../../src/monitoring/config';

vi.mock('../../../src/agent/model-service', async importOriginal => ({ ...await importOriginal<typeof import('../../../src/agent/model-service')>(), loadProfileModelService: vi.fn(async () => ({ model: 'test' })) }));
vi.mock('../../../src/inbox/analyzer', () => ({ INBOX_ANALYSIS_MODEL: 'deepseek-flash', loadAnalysisProvider: vi.fn(async () => ({ model: 'test' })), analyzeInbox: vi.fn() }));
vi.mock('../../../src/inbox/lark', () => ({ InboxLark: class { checkOwner = vi.fn(async () => {}); close = vi.fn(); cancelPending = vi.fn(); } }));
vi.mock('../../../src/inbox/gui', () => ({ InboxGui: vi.fn(function (...args: unknown[]) { return { start: vi.fn(async () => {}), close: vi.fn(async () => {}), setMode: args[5], setScope: args[6] }; }) }));
vi.mock('../../../src/inbox/h5-server', () => ({ startInboxH5: vi.fn(async () => ({ close: async () => {} })) }));
vi.mock('../../../src/lark-cli/user-im', () => ({ getUserAuthStatus: vi.fn(async () => ({ openId: 'ou_owner', scopes: ['search:message', 'im:chat:read', 'im:message.p2p_msg:get_as_user', 'im:message.group_msg:get_as_user'] })) }));
const managers: InboxManager[] = [];
afterEach(async () => { for (const manager of managers.splice(0)) await manager.close(); });

async function setup() {
  const rootDir = await mkdtemp(join(tmpdir(), 'inbox-manager-')); const path = join(rootDir, 'config.json');
  const profile = createDefaultProfileConfig({ agentKind: 'codex', accounts: { app: { id: 'cli_fixture', secret: 'fixture', tenant: 'feishu' } }, codex: { binaryPath: 'codex' } });
  profile.larkCli.identityPreset = 'user-default';
  const root = createRootConfig('codex', profile);
  root.inbox = normalizeInbox({ enabled: true, executorProfile: 'codex', ownerOpenId: 'ou_owner', destination: { chatId: 'oc_group', threadId: 'omt_topic', replyTo: 'om_message' }, h5: { publicUrl: 'https://example.com/assistant/', port: 19182 } });
  await saveRootConfig(root, path);
  const controls: Controls = { cfg: runtimeProfileConfig(root, 'codex'), profileConfig: profile, profile: 'codex', configPath: path,
    ownerRefreshState: 'ok', processId: 'test', refreshOwner: async () => {}, restart: async () => {}, exit: async () => {} };
  const create = () => { const m = new InboxManager(path, () => controls, rootDir); managers.push(m); return m; };
  return { create, path, root, controls, rootDir };
}

it('allows one watcher across managers, releasing the lease on stop', async () => {
  const { create } = await setup(); const first = create(); const second = create();
  await first.reconcile(); await second.reconcile();
  expect((await first.view()).running).toBe(true); expect((await second.view()).running).toBe(false);
  await first.close(); await second.reconcile(); expect((await second.view()).running).toBe(true);
});

it('persists the global switch without changing profile preferences', async () => {
  const { create, path, root } = await setup(); const manager = create(); await manager.reconcile();
  const before = (await loadRootConfig(path))!.profiles.codex;
  await manager.configure({ ...root.inbox, enabled: false });
  expect((await manager.view()).running).toBe(false);
  expect((await manager.view()).config.dailyTriageLimit).toBe(1_000_000);
  expect((await loadRootConfig(path))!.inbox?.dailyTriageLimit).toBe(1_000_000);
  expect((await loadRootConfig(path))!.profiles.codex).toEqual(before);
});

it('loads Lark settings from TOML and writes workbench changes back to the same file', async () => {
  const { create, path, root, rootDir } = await setup();
  await initMonitors({ config: path });
  const manager = create(); await manager.reconcile();
  expect(await manager.view()).toMatchObject({ running: true, configFile: join(rootDir, 'monitors.toml') });
  const original = await manager.view();
  await manager.configure({ ...root.inbox, enabled: false, pollSeconds: 3 });
  await expect(manager.configure({ ...original.config, configRevision: original.configRevision })).rejects.toThrow('本次未覆盖');
  expect((await loadMonitorRoot(path))!.inbox).toMatchObject({ enabled: false, pollSeconds: 3 });
  expect((await loadRootConfig(path))!.inbox).toBeUndefined();
  expect(await readFile(join(rootDir, 'monitors.toml'), 'utf8')).toContain('pollSeconds = 3');
  const command = (action: string, target: string) => manager.workbenchCommand({ id: '00000000-0000-0000-0000-000000000000', action, target });
  await command('mode', 'on'); await command('scope', 'all');
  expect((await loadMonitorRoot(path))!.inbox).toMatchObject({ enabled: true, intakeScope: 'all' });
});

it('retains a running source on invalid TOML and picks up a repaired file without recreating it', async () => {
  const { create, path, rootDir } = await setup(); await initMonitors({ config: path });
  const file = join(rootDir, 'monitors.toml'); const valid = await readFile(file, 'utf8');
  const manager = create(); await manager.reconcile();
  await writeFile(file, 'version=1\n[sources.lark]\nenabled="wrong"');
  await manager.reconcile();
  expect(await manager.view()).toMatchObject({ running: true, error: expect.stringContaining('enabled') });
  const invalidReference = valid.replace('executorProfile = "codex"', 'executorProfile = "missing"');
  await writeFile(file, invalidReference); await manager.reconcile();
  expect(await manager.view()).toMatchObject({ running: true, error: expect.stringContaining('executorProfile') });
  await writeFile(file, valid); await manager.reconcile();
  expect(await manager.view()).toMatchObject({ running: true, error: undefined });
  const root = (await loadMonitorRoot(path))!; root.inbox!.enabled = false;
  await writeFile(file, formatMonitorConfig(root)); await manager.reconcile();
  expect((await manager.view()).running).toBe(false);
  await manager.close(); await manager.reconcile();
  expect((await manager.view()).running).toBe(false);
});

it('starts without HTTPS and does not open an HTTP listener', async () => {
  const { create, root, path } = await setup();
  root.inbox!.h5.publicUrl = ''; await saveRootConfig(root, path);
  vi.mocked(startInboxH5).mockClear();
  const manager = create(); await manager.reconcile();
  expect((await manager.view()).running).toBe(true);
  expect(startInboxH5).not.toHaveBeenCalled();
});

it('returns visible feedback for a command when the service is not running', async () => {
  const { create } = await setup();
  const feedback = await create().command('', { profile: 'codex', operator: 'ou_owner', chatId: 'oc_group', threadId: 'omt_new', messageId: 'om_new' });
  expect(feedback).toContain('未运行');
});

it('keeps the GUI connected while off, persists mode, and can re-enable after restart', async () => {
  const { create, path, root } = await setup();
  const key = join(path, '..', 'key'); await writeFile(key, 'fixture', { mode: 0o600 });
  root.inbox!.gui = { publicUrl: 'https://gui.example', apiKeyFile: key };
  root.inbox!.enabled = false; await saveRootConfig(root, path);
  const manager = create(); await manager.reconcile();
  const gui = vi.mocked(InboxGui).mock.results.at(-1)!.value as { setMode(mode: string): Promise<void>; close: ReturnType<typeof vi.fn> };
  expect((await manager.view()).running).toBe(false);
  await gui.setMode('on'); expect((await manager.view()).running).toBe(true);
  expect((await loadRootConfig(path))!.inbox).toMatchObject({ enabled: true, autoAnalyze: false });
  await gui.setMode('off'); await manager.reconcile(); expect(gui.close).not.toHaveBeenCalled();
  await manager.close();
  const restarted = create(); await restarted.reconcile();
  const second = vi.mocked(InboxGui).mock.results.at(-1)!.value as typeof gui;
  expect(second).not.toBe(gui); expect((await restarted.view()).running).toBe(false);
  await second.setMode('on'); expect((await restarted.view()).running).toBe(true);
  expect((await loadRootConfig(path))!.inbox).toMatchObject({ enabled: true, autoAnalyze: false });
});

it('persists GUI intake changes while off and retains them after restart', async () => {
  const { create, path, root } = await setup();
  root.inbox!.gui = { publicUrl: 'https://gui.example', apiKeyFile: join(path, '..', 'key') };
  root.inbox!.enabled = false; root.inbox!.autoAnalyze = false; await saveRootConfig(root, path);
  const before = (await loadRootConfig(path))!.profiles;
  const manager = create(); await manager.reconcile();
  const gui = vi.mocked(InboxGui).mock.results.at(-1)!.value as { setScope(scope: string): Promise<void>; close: ReturnType<typeof vi.fn> };
  for (const scope of ['private', 'private_mentions', 'all']) {
    await gui.setScope(scope); await manager.reconcile();
    expect((await loadRootConfig(path))!.inbox).toMatchObject({ intakeScope: scope, enabled: false, autoAnalyze: false });
    expect((await manager.view()).running).toBe(false); expect(gui.close).not.toHaveBeenCalled();
  }
  expect((await loadRootConfig(path))!.profiles).toEqual(before);
  await manager.close(); const restarted = create(); await restarted.reconcile();
  expect((await restarted.view()).config.intakeScope).toBe('all');
});


it('uses the shared Codex runtime configuration and quarantines both trusted bot identity forms on startup', async () => {
  const { create, controls, rootDir, path } = await setup();
  controls.botIdentity = { openId: 'ou_self', name: '助理' };
  const spy = vi.spyOn(runtimeAgent, 'createRuntimeAgent');
  const { InboxStore } = await import('../../../src/inbox/store');
  const store = new InboxStore(join(rootDir, 'inbox', 'state.json'));
  store.data.jobs = ['cli_fixture', 'ou_self'].map((senderId, i) => ({
    id: `self-${i}`, ownerOpenId: 'ou_owner', profile: 'codex', destination: { chatId: 'oc_group', threadId: 'omt_topic', replyTo: 'om_message' },
    source: { chatId: 'oc_source', name: '群', type: 'group' }, state: 'queued', automatic: true, alert: true, createdAt: 1, updatedAt: 1,
    analysisRequested: true, attention: { state: 'needed', reason: '旧输出' },
    messages: [{ id: `om_${i}`, chatId: 'oc_source', chatName: '群', chatType: 'group', senderId, senderName: '助理', bot: true, time: 1, text: '请确认', mentions: [] }],
  }));
  await store.save();
  try {
    const manager = create(); await manager.reconcile();
    expect((await manager.view()).running).toBe(true);
    expect(spy).toHaveBeenCalledWith(controls.profileConfig, expect.objectContaining({ rootDir, profile: 'codex', configPath: path }));
    const saved = new InboxStore(store.path); await saved.load();
    expect(saved.data.jobs.map(j => j.state)).toEqual(['ignored', 'ignored']);
  } finally { spy.mockRestore(); }
});


it('fills a result topic only for the authorized owner without enabling collection', async () => {
  const { create, root, path } = await setup();
  root.inbox = normalizeInbox(undefined); await saveRootConfig(root, path);
  const manager = create();
  const ctx = { profile: 'codex', operator: 'ou_other', chatId: 'oc_output', threadId: 'omt_output', messageId: 'om_anchor' };
  expect(await manager.command('setup', ctx)).toContain('授权');
  expect((await manager.view()).config.executorProfile).toBe('');
  expect(await manager.command('setup', { ...ctx, operator: 'ou_owner' })).toContain('已记录');
  expect((await manager.view()).config).toMatchObject({ enabled: false, analysisModel: '', ownerOpenId: 'ou_owner',
    destination: { chatId: 'oc_output', threadId: 'omt_output', replyTo: 'om_anchor' } });
});

it('checks owner, model and destination without exposing provider credentials', async () => {
  const { create, root } = await setup(); const manager = create();
  const result = await manager.checkSetup(root.inbox);
  expect(result.ok).toBe(true); expect(result.ownerOpenId).toBe('ou_owner');
  expect(JSON.stringify(result)).not.toContain('key');
  const other = await manager.checkSetup({ ...root.inbox, ownerOpenId: 'ou_wrong' });
  expect(other.ok).toBe(false);
  expect(other.checks.find(c => c.label === '飞书用户授权')?.detail).toContain('不一致');
});

it('retains local workbench reviews while paused, without a hosted GUI', async () => {
  const { create, root, path } = await setup();
  root.inbox!.enabled = false; root.inbox!.h5.publicUrl = ''; await saveRootConfig(root, path);
  const manager = create(); await manager.reconcile();
  expect(await manager.workbench()).toMatchObject({ running: false, connected: true, jobs: [] });
  await expect(manager.workbenchCommand({ id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', action: 'manual', target: 'oc_source' })).rejects.toThrow('已关闭');
});
