import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { Controls } from '../../../src/commands';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { createRootConfig, loadRootConfig, runtimeProfileConfig, saveRootConfig } from '../../../src/config/profile-store';
import { normalizeInbox } from '../../../src/inbox/config';
import { InboxManager } from '../../../src/inbox/manager';

vi.mock('../../../src/inbox/analyzer', () => ({ loadAnalysisProvider: vi.fn(async () => ({ model: 'test' })), analyzeInbox: vi.fn() }));
vi.mock('../../../src/inbox/lark', () => ({ InboxLark: class { checkOwner = vi.fn(async () => {}); close = vi.fn(); } }));
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
