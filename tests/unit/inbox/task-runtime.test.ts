import { createWorkItemSource } from '../../../src/host/work-item-runtime';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import type { Controls } from '../../../src/commands';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { createRootConfig, runtimeProfileConfig } from '../../../src/config/profile-store';
import { createRuntimeAgent } from '../../../src/runtime/agent-runtime';
import { processAnalysis } from '../../../src/work-items/analysis';
import { InboxTaskSources } from '../../../src/inbox/task-sources';

vi.mock('../../../src/runtime/agent-runtime', () => ({ createRuntimeAgent: vi.fn(() => ({})) }));
vi.mock('../../../src/work-items/analysis', () => ({ processAnalysis: vi.fn(async () => ({
  text: JSON.stringify({ replyDraft: 'CI draft', analysis: 'CI evidence', missingInfo: '' }), inputTokens: 1, outputTokens: 2,
})) }));

it('executes a registered source through the shared agent path and commits its evidence result', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'source-runtime-'));
  const registry = new InboxTaskSources(join(rootDir, 'config.json'));
  const profile = createDefaultProfileConfig({ agentKind: 'claude', accounts: { app: { id: 'cli_test', secret: 'fixture', tenant: 'feishu' } } });
  const controls: Controls = { profile: 'claude', profileConfig: profile, cfg: runtimeProfileConfig(createRootConfig('claude', profile), 'claude'),
    configPath: join(rootDir, 'config.json'), processId: 'test', ownerRefreshState: 'ok',
    refreshOwner: async () => {}, restart: async () => {}, exit: async () => {} };
  const prepared = { cwd: rootDir, prompt: 'Read-only CI investigation' };
  const completed = vi.fn(async () => {});
  try {
    const source = await registry.connect(createWorkItemSource({ id: 'gitlab-ci', label: 'CI', profile: 'claude', enabled: true, controls,
      settings: { model: 'test-model', reasoningEffort: 'max' }, driver: { accepts: () => true, prepare: async () => prepared, completed } }, join(rootDir, 'config.json'), rootDir));
    await source.submit({ key: 'pipeline-1', title: 'CI', reason: 'failed', time: Date.now(), url: '', data: {} });
    await vi.waitFor(() => expect(registry.list()[0]?.replyDraft).toBe('CI draft'), { timeout: 7000 });
    expect(createRuntimeAgent).toHaveBeenCalledWith(profile, expect.objectContaining({ rootDir, configPath: join(rootDir, 'config.json') }));
    expect(processAnalysis).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ ...prepared, model: 'test-model', reasoningEffort: 'max' }), expect.any(AbortSignal), expect.any(Function));
    expect(completed).toHaveBeenCalledTimes(1);
  } finally { await registry.close(); }
}, 10000);
