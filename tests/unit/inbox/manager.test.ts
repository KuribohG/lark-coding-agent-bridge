import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { Controls } from '../../../src/commands';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { createRootConfig, loadRootConfig, runtimeProfileConfig, saveRootConfig } from '../../../src/config/profile-store';
import { normalizeInbox } from '../../../src/inbox/config';
import { InboxManager } from '../../../src/inbox/manager';
import { InboxGui } from '../../../src/inbox/gui';
import { startInboxH5 } from '../../../src/inbox/h5-server';

vi.mock('../../../src/inbox/analyzer', () => ({ loadAnalysisProvider: vi.fn(async () => ({ model: 'test' })), analyzeInbox: vi.fn() }));
vi.mock('../../../src/inbox/lark', () => ({ InboxLark: class { checkOwner = vi.fn(async () => {}); close = vi.fn(); cancelPending = vi.fn(); } }));
vi.mock('../../../src/inbox/gui', () => ({ InboxGui: vi.fn(function (...args: unknown[]) { return { start: vi.fn(async () => {}), close: vi.fn(async () => {}), setMode: args[5], setScope: args[6] }; }) }));
vi.mock('../../../src/inbox/h5-server', () => ({ startInboxH5: vi.fn(async () => ({ close: async () => {} })) }));
const managers: InboxManager[] = [];
afterEach(async () => { for (const manager of managers.splice(0)) await manager.close(); });

async function setup() {
  const rootDir = await mkdtemp(join(tmpdir(), 'inbox-manager-')); const path = join(rootDir, 'config.json');
  const profile = createDefaultProfileConfig({ agentKind: 'codex', accounts: { app: { id: 'cli_fixture', secret: 'fixture', tenant: 'feishu' } }, codex: { binaryPath: 'codex' } });
  const root = createRootConfig('codex', profile);
  root.inbox = normalizeInbox({ enabled: true, executorProfile: 'codex', ownerOpenId: 'ou_owner', destination: { chatId: 'oc_group', threadId: 'omt_topic', replyTo: 'om_message' }, h5: { publicUrl: 'https://example.com/assistant/', port: 19182 } });
  await saveRootConfig(root, path);
  const controls: Controls = { cfg: runtimeProfileConfig(root, 'codex'), profileConfig: profile, profile: 'codex', configPath: path,
    ownerRefreshState: 'ok', processId: 'test', refreshOwner: async () => {}, restart: async () => {}, exit: async () => {} };
  const create = () => { const m = new InboxManager(path, () => controls, rootDir); managers.push(m); return m; };
  return { create, path, root };
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
  expect((await loadRootConfig(path))!.profiles.codex).toEqual(before);
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
