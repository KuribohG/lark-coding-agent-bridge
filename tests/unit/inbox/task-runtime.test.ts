import { ProfileExecutionProvider } from '../../../src/plugins/work-items/execution-provider';
import { createWorkItemSource } from '../../../src/plugins/work-items/work-item-runtime';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { createRootConfig, saveRootConfig } from '../../../src/config/profile-store';
import { createRuntimeAgent } from '../../../src/runtime/agent-runtime';
import { createLarkRuntimeAgent } from '../../../src/channels/lark/agent-host';
import { processAnalysis } from '../../../src/work-items/analysis';
import { InboxTaskSources } from '../../../src/inbox/task-sources';

vi.mock('../../../src/runtime/agent-runtime', async original => ({ ...await original<typeof import('../../../src/runtime/agent-runtime')>(), createRuntimeAgent: vi.fn(() => ({ isAvailable: async () => true })) }));
vi.mock('../../../src/work-items/analysis', () => ({ processAnalysis: vi.fn(async () => ({
  text: JSON.stringify({ replyDraft: 'CI draft', analysis: 'CI evidence', missingInfo: '' }), inputTokens: 1, outputTokens: 2,
})) }));

it('executes a registered source through the shared agent path and commits its evidence result', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'source-runtime-'));
  const registry = new InboxTaskSources(join(rootDir, 'config.json'));
  const profile = createDefaultProfileConfig({ agentKind: 'claude', accounts: { app: { id: 'cli_test', secret: 'fixture', tenant: 'feishu' } } });
  const configPath = join(rootDir, 'config.json');
  await saveRootConfig(createRootConfig('claude', profile), configPath);
  const provider = new ProfileExecutionProvider(
    configPath,
    rootDir,
    (config, paths) => createLarkRuntimeAgent(config, paths, configPath),
  );
  const executor = await provider.resolve('claude');
  const prepared = { cwd: rootDir, prompt: 'Read-only CI investigation' };
  const completed = vi.fn(async () => {});
  try {
    const source = await registry.connect(createWorkItemSource({ id: 'gitlab-ci', label: 'CI', profile: 'claude', enabled: true, executor: () => executor,
      model: 'test-model', reasoningEffort: 'max', driver: { accepts: () => true, prepare: async () => prepared, completed } }));
    await source.submit({ key: 'pipeline-1', title: 'CI', reason: 'failed', time: Date.now(), url: '', data: {} });
    await vi.waitFor(() => expect(registry.list()[0]?.replyDraft).toBe('CI draft'), { timeout: 7000 });
    expect(createRuntimeAgent).toHaveBeenCalledWith(
      expect.objectContaining({ agentKind: 'claude', sandbox: profile.sandbox }),
      expect.objectContaining({ rootDir, profile: 'claude' }),
      expect.objectContaining({
        env: expect.objectContaining({
          LARK_CHANNEL_HOME: rootDir,
          LARK_CHANNEL_PROFILE: 'claude',
        }),
        systemPrompt: expect.any(Function),
      }),
    );
    expect(processAnalysis).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ ...prepared, model: 'test-model', reasoningEffort: 'max' }), expect.any(AbortSignal), expect.any(Function));
    expect(completed).toHaveBeenCalledTimes(1);
  } finally { await registry.close(); }
}, 10000);
