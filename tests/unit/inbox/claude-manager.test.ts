import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { Controls } from '../../../src/commands';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { createRootConfig, runtimeProfileConfig, saveRootConfig } from '../../../src/config/profile-store';
import { configureModelService } from '../../../src/model-service/registry';
import { normalizeInbox } from '../../../src/inbox/config';
import { InboxManager } from '../../../src/inbox/manager';
import { InboxLark } from '../../../src/inbox/lark';
import { InboxService } from '../../../src/inbox/service';
import type { InboxIO, InboxJob } from '../../../src/inbox/types';
import { processInbox } from '../../../src/inbox/processor';
import { triageWithChatTools } from '../../../src/inbox/codex-triage';
import { loadProfileModelService } from '../../../src/agent/model-service';

vi.mock('../../../src/inbox/service', () => ({ InboxService: vi.fn(function (_store, config) {
  return { config, start: vi.fn(), close: vi.fn(), list: () => [] };
}) }));
vi.mock('../../../src/inbox/lark', () => ({ InboxLark: vi.fn(function () { return { close: vi.fn() }; }) }));
vi.mock('../../../src/inbox/progress', () => ({ startInboxProgress: vi.fn(async () => undefined) }));
vi.mock('../../../src/inbox/processor', () => ({ processInbox: vi.fn(async () => ({ text: '{}' })) }));
vi.mock('../../../src/inbox/codex-triage', () => ({ triageWithChatTools: vi.fn(async () => []) }));
vi.mock('../../../src/agent/model-service', async importOriginal => ({ ...await importOriginal<typeof import('../../../src/agent/model-service')>(),
  loadProfileModelService: vi.fn(async (_profile, model) => ({ model, url: 'https://test/responses', key: 'fixture' })),
}));

const managers: InboxManager[] = [], dirs: string[] = [];
afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.close();
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
  vi.clearAllMocks(); vi.unstubAllEnvs();
});
async function setup(triageProfile?: string, standalone = false) {
  const dir = await mkdtemp(join(tmpdir(), 'claude-inbox-manager-')); dirs.push(dir);
  vi.stubEnv('CLAUDE_CONFIG_DIR', dir); vi.stubEnv('ANTHROPIC_MODEL', undefined); vi.stubEnv('CLAUDE_CODE_EFFORT_LEVEL', undefined);
  const accounts = { app: { id: 'fixture', secret: 'fixture', tenant: 'feishu' as const } };
  const claude = createDefaultProfileConfig({ accounts, agentKind: 'claude', preferences: { model: 'sonnet', reasoningEffort: 'high' } });
  const codex = createDefaultProfileConfig({ accounts, agentKind: 'codex', codex: { binaryPath: 'unused', codexHome: dir } });
  const root = createRootConfig('claude', claude); root.profiles.codex = codex;
  root.inbox = normalizeInbox({ enabled: true, executorProfile: 'claude', triageProfile, triageModel: 'cheap', analysisModel: '',
    ownerOpenId: 'ou_owner', destination: { chatId: 'oc_group', threadId: 'omt_topic', replyTo: 'om_anchor' } });
  if (standalone) {
    delete root.profiles.codex;
    vi.stubEnv('TEST_INBOX_MODEL_KEY', 'independent-key');
    root.modelServices = { screen: { protocol: 'responses', baseUrl: 'https://independent.test/v1', model: 'independent-model', apiKey: { source: 'env', id: 'TEST_INBOX_MODEL_KEY' } } };
    root.inbox.triageService = 'screen'; root.inbox.triageModel = undefined;
  }
  const configPath = join(dir, 'config.json'); await saveRootConfig(root, configPath);
  const controls: Controls = { profile: 'claude', profileConfig: claude, cfg: runtimeProfileConfig(root, 'claude'), configPath,
    ownerRefreshState: 'ok', processId: 'test', refreshOwner: async () => {}, restart: async () => {}, exit: async () => {} };
  const manager = new InboxManager(configPath, profile => profile === 'claude' ? controls : undefined, dir); managers.push(manager);
  return { manager, codex, configPath, serviceConfig: root.modelServices?.screen };
}

it('runs Claude analysis while an offline Codex profile supplies only screening model credentials', async () => {
  const h = await setup('codex'); await h.manager.reconcile();
  expect((await h.manager.view()).error).toBeUndefined();
  const io = vi.mocked(InboxService).mock.calls[0]![2] as InboxIO;
  await io.analyze!({} as InboxJob, new AbortController().signal);
  const args = vi.mocked(processInbox).mock.calls[0]!;
  expect(args[1].id).toBe('claude'); expect(args[1].capabilities?.finalAnswer).toBe('separate-event');
  expect(args[7]).toEqual({ model: 'sonnet', reasoningEffort: 'high' });
  await io.triage!([], new AbortController().signal, undefined);
  expect(loadProfileModelService).toHaveBeenCalledWith(expect.objectContaining({ agentKind: 'codex',
    codex: expect.objectContaining({ codexHome: h.codex.codex?.codexHome }) }), 'cheap', expect.stringMatching(/profiles\/codex$/));
  expect(triageWithChatTools).toHaveBeenCalledWith([], '', expect.objectContaining({ model: 'cheap' }), expect.anything(), expect.anything(), undefined);
  expect(InboxLark).toHaveBeenCalledWith(expect.objectContaining({ profile: 'claude' }), expect.anything());
  expect(vi.mocked(InboxLark).mock.calls.every(call => call[0].profile === 'claude')).toBe(true);
});

it('rejects missing screening routing before opening Lark or invoking any model', async () => {
  const h = await setup(); await h.manager.reconcile();
  expect((await h.manager.view()).error).toContain('筛选 profile');
  expect(InboxLark).not.toHaveBeenCalled(); expect(loadProfileModelService).not.toHaveBeenCalled(); expect(processInbox).not.toHaveBeenCalled();
});

it('uses and reloads an independent service on a Claude-only installation without reading Codex', async () => {
  const h = await setup(undefined, true); await h.manager.reconcile();
  expect((await h.manager.view()).error).toBeUndefined();
  const first = vi.mocked(InboxService).mock.calls[0]![2] as InboxIO;
  await first.triage!([], new AbortController().signal, undefined);
  expect(loadProfileModelService).not.toHaveBeenCalled();
  expect(triageWithChatTools).toHaveBeenLastCalledWith([], '', expect.objectContaining({ model: 'independent-model', key: 'independent-key', url: 'https://independent.test/v1/responses' }), expect.anything(), expect.anything(), undefined);
  await configureModelService(h.configPath, 'screen', { ...h.serviceConfig!, model: 'updated-model' });
  await h.manager.reconcile();
  expect(InboxService).toHaveBeenCalledTimes(2);
  const second = vi.mocked(InboxService).mock.calls[1]![2] as InboxIO;
  await second.triage!([], new AbortController().signal, undefined);
  expect(triageWithChatTools).toHaveBeenLastCalledWith([], '', expect.objectContaining({ model: 'updated-model' }), expect.anything(), expect.anything(), undefined);
  await second.analyze!({} as InboxJob, new AbortController().signal);
  expect(vi.mocked(processInbox).mock.calls[0]![7]).toEqual({ model: 'sonnet', reasoningEffort: 'high' });
  expect(vi.mocked(InboxLark).mock.calls.every(call => call[0].profile === 'claude')).toBe(true);
});
