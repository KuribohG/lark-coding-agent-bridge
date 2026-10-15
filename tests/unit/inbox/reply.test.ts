import { describe, it, expect } from 'vitest';
import { replyContent, handlingState } from '../../../src/inbox/reply';
import { guiJobs, guiContent } from '../../../src/inbox/gui';
import type { InboxJob } from '../../../src/inbox/types';

const job = (id = 'one'): InboxJob => ({ id, source: { chatId: 'oc_source', name: '会话', type: 'p2p' }, messages: [],
  state: 'done', updatedAt: 1, automatic: true, alert: false, result: '## 分析结论\n事实不足\n\n## 建议回复\n请补充版本。\n\n## 待确认事项\n目标版本' } as unknown as InboxJob);

describe('reply content and sync', () => {
  it('extracts only a dedicated draft from legacy headings and never copies undifferentiated analysis', () => {
    expect(replyContent(job().result).replyDraft).toBe('请补充版本。');
    expect(replyContent('分析：建议回复一些内容').replyDraft).toBe('');
    expect(replyContent('{"replyDraft":42}').replyDraft).toBe('');
    expect(replyContent(JSON.stringify({ replyDraft: '', analysis: '无需回复', missingInfo: '' }))).toEqual({ replyDraft: '', analysis: '无需回复', missingInfo: '' });
  });
  it('maps legacy delivery completion to pending and preserves explicit edits including an empty draft', () => {
    expect(handlingState(job())).toBe('open');
    expect(guiContent({ ...job(), replyDraft: '' }).replyDraft).toBe('');
    expect(handlingState({ ...job(), state: 'claimed' })).toBe('handled');
  });
  it('prefetches drafts within the byte budget without losing the summary list', () => {
    const jobs = Array.from({ length: 100 }, (_, index) => ({ ...job(String(index)), replyDraft: '文'.repeat(6000), analysis: '析'.repeat(8000), missingInfo: '缺'.repeat(2000) }));
    const synced = guiJobs(jobs);
    expect(synced).toHaveLength(100); expect(synced[0]?.detail?.replyDraft).toBe(jobs[0]?.replyDraft);
    expect(synced.at(-1)?.detail).toBeUndefined(); expect(Buffer.byteLength(JSON.stringify(synced))).toBeLessThanOrEqual(700000);
    expect(JSON.stringify({ ...synced[0], detail: undefined, ...guiContent(jobs[0]!) }).length).toBeLessThan(24000);
  });
});

import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAnalysisProvider, analysisBody } from '../../../src/inbox/analyzer';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';

it('routes clicked analysis to the configured default provider model', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'inbox-provider-'));
  await writeFile(join(dir, 'config.toml'), 'model = "openai/gpt-6-astra"\nmodel_provider = "third-party"\n[model_providers.third-party]\nbase_url = "https://provider.example/v1"\nwire_api = "responses"\nexperimental_bearer_token = "fixture-token"\n');
  const profile = createDefaultProfileConfig({ agentKind: 'codex', accounts: { app: { id: 'cli_app', secret: 'fixture', tenant: 'feishu' } }, codex: { binaryPath: 'codex', codexHome: dir } });
  profile.preferences.model = 'openai/gpt-6-astra';
  const provider = await loadAnalysisProvider(profile);
  expect(provider).toMatchObject({ model: 'openai/gpt-6-astra', url: 'https://provider.example/v1/responses', key: 'fixture-token' });
  expect(analysisBody(job(), await loadAnalysisProvider(profile)).model).toBe('openai/gpt-6-astra');
  profile.preferences.model = '';
  expect((await loadAnalysisProvider(profile)).model).toBe('openai/gpt-6-astra');
});
