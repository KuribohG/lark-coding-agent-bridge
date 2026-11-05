import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { Controls } from '../../../src/commands';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { createRootConfig, runtimeProfileConfig, saveRootConfig } from '../../../src/config/profile-store';
import { configureModelService } from '../../../src/model-service/registry';
import { normalizeInbox } from '../../../src/inbox/config';
import type { WorkItemRuntime } from '../../../src/work-items/contracts';
import { InboxManager } from '../../../src/monitoring/sources/lark/manager';
import { InboxLark } from '../../../src/inbox/lark';
import { WorkItemService } from '../../../src/work-items/service';
import type { InboxJob } from '../../../src/inbox/types';
import { processInbox } from '../../../src/monitoring/sources/lark/processor';
import { triageWithChatTools } from '../../../src/monitoring/sources/lark/codex-triage';
import { workItemTarget } from '../../../src/inbox/lark-target';

vi.mock('../../../src/work-items/service', () => ({ WorkItemService: vi.fn(function (_store, config) {
  return { config, start: vi.fn(), close: vi.fn(), list: () => [] };
}) }));
vi.mock('../../../src/inbox/lark', () => ({ InboxLark: vi.fn(function () { return { close: vi.fn() }; }) }));
vi.mock('../../../src/inbox/progress', () => ({ startInboxProgress: vi.fn(async () => undefined) }));
vi.mock('../../../src/monitoring/sources/lark/processor', () => ({ processInbox: vi.fn(async () => ({ text: '{}' })) }));
vi.mock('../../../src/monitoring/sources/lark/codex-triage', async importOriginal => ({
  ...await importOriginal<typeof import('../../../src/monitoring/sources/lark/codex-triage')>(), triageWithChatTools: vi.fn(async () => ({ id: 'fixture', state: 'quiet', reason: 'fixture' })),
}));

const managers: InboxManager[] = [], dirs: string[] = [];
afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.close();
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
  vi.clearAllMocks(); vi.unstubAllEnvs();
});
async function setup(standalone = true) {
  const dir = await mkdtemp(join(tmpdir(), 'claude-inbox-manager-')); dirs.push(dir);
  vi.stubEnv('CLAUDE_CONFIG_DIR', dir); vi.stubEnv('ANTHROPIC_MODEL', undefined); vi.stubEnv('CLAUDE_CODE_EFFORT_LEVEL', undefined);
  const accounts = { app: { id: 'fixture', secret: 'fixture', tenant: 'feishu' as const } };
  const claude = createDefaultProfileConfig({ accounts, agentKind: 'claude', preferences: { model: 'sonnet', reasoningEffort: 'high' } });
  const root = createRootConfig('claude', claude);
  root.inbox = normalizeInbox({ enabled: true, executorProfile: 'claude', triageModel: 'cheap', analysisModel: '',
    triageMessageLimit: 17, triageMessageChars: 1000,
    recipientKey: 'ou_owner', target: workItemTarget({ chatId: 'oc_group', threadId: 'omt_topic', replyTo: 'om_anchor' }) });
  if (standalone) {
    vi.stubEnv('TEST_INBOX_MODEL_KEY', 'independent-key');
    root.modelServices = { screen: { protocol: 'responses', baseUrl: 'https://independent.test/v1', model: 'independent-model', apiKey: { source: 'env', id: 'TEST_INBOX_MODEL_KEY' } } };
    root.inbox.triageService = 'screen'; root.inbox.triageModel = undefined;
  }
  const configPath = join(dir, 'config.json'); await saveRootConfig(root, configPath);
  const controls: Controls = { profile: 'claude', profileConfig: claude, cfg: runtimeProfileConfig(root, 'claude'), configPath,
    ownerRefreshState: 'ok', processId: 'test', refreshOwner: async () => {}, restart: async () => {}, exit: async () => {} };
  const manager = new InboxManager(configPath, profile => profile === 'claude' ? controls : undefined, dir); managers.push(manager);
  return { manager, configPath, serviceConfig: root.modelServices?.screen };
}

async function screen(runtime: WorkItemRuntime) {
  const policy = runtime.source.assessment;
  if (policy?.kind !== 'item') throw new Error('Lark must screen one item at a time');
  await policy.evaluate({ id: 'fixture' } as InboxJob, new AbortController().signal, () => {});
}

it('rejects missing screening routing before opening Lark or invoking any model', async () => {
  const h = await setup(false); await h.manager.reconcile();
  expect((await h.manager.view()).error).toContain('请选择独立筛选模型服务');
  expect(InboxLark).not.toHaveBeenCalled(); expect(processInbox).not.toHaveBeenCalled();
});

it('uses and reloads an independent service on a Claude-only installation without reading Codex', async () => {
  const h = await setup(); await h.manager.reconcile();
  expect((await h.manager.view()).error).toBeUndefined();
  const first = vi.mocked(WorkItemService).mock.calls[0]![2] as WorkItemRuntime;
  await screen(first);
  expect(triageWithChatTools).toHaveBeenLastCalledWith({ id: 'fixture' }, '', expect.objectContaining({ model: 'independent-model', key: 'independent-key', url: 'https://independent.test/v1/responses' }), expect.anything(), expect.anything(), expect.any(Function),
    undefined, undefined, expect.objectContaining({ triageMessageLimit: 17, triageMessageChars: 1000 }));
  await configureModelService(h.configPath, 'screen', { ...h.serviceConfig!, model: 'updated-model' });
  await h.manager.reconcile();
  expect(WorkItemService).toHaveBeenCalledTimes(2);
  const second = vi.mocked(WorkItemService).mock.calls[1]![2] as WorkItemRuntime;
  await screen(second);
  expect(triageWithChatTools).toHaveBeenLastCalledWith({ id: 'fixture' }, '', expect.objectContaining({ model: 'updated-model' }), expect.anything(), expect.anything(), expect.any(Function),
    undefined, undefined, expect.objectContaining({ triageMessageLimit: 17, triageMessageChars: 1000 }));
  await second.investigate({} as InboxJob, new AbortController().signal);
  expect(vi.mocked(processInbox).mock.calls[0]![7]).toEqual({ model: 'sonnet', reasoningEffort: 'high' });
  expect(vi.mocked(InboxLark).mock.calls.every(call => call[0].profile === 'claude')).toBe(true);
});
