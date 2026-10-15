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

it('routes triage to flash and clicked analysis to the configured default provider model', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'inbox-provider-'));
  await writeFile(join(dir, 'config.toml'), 'model = "openai/gpt-6-astra"\nmodel_provider = "third-party"\n[model_providers.third-party]\nbase_url = "https://provider.example/v1"\nwire_api = "responses"\nexperimental_bearer_token = "fixture-token"\n');
  const profile = createDefaultProfileConfig({ agentKind: 'codex', accounts: { app: { id: 'cli_app', secret: 'fixture', tenant: 'feishu' } }, codex: { binaryPath: 'codex', codexHome: dir } });
  profile.preferences.model = 'openai/gpt-6-astra';
  const provider = await loadAnalysisProvider(profile, 'triage');
  expect(provider).toMatchObject({ model: 'deepseek-flash', url: 'https://provider.example/v1/responses', key: 'fixture-token' });
  expect(analysisBody(job(), await loadAnalysisProvider(profile)).model).toBe('openai/gpt-6-astra');
  profile.preferences.model = '';
  expect((await loadAnalysisProvider(profile)).model).toBe('openai/gpt-6-astra');
});

import { triageBody, triageInbox } from '../../../src/inbox/analyzer';
import { vi } from 'vitest';
it('bounds triage input, ignores raw instructions and validates complete unique output ids', async () => {
  const jobs = [job('a'), job('b')];
  const body = triageBody(jobs, 'CI blockers');
  expect(body.model).toBe('deepseek-flash'); expect(body.tools).toEqual([]);
  expect(body.instructions).toContain('具体动作'); expect(body.input[0]?.content).toContain('CI blockers');
  const request = (items: unknown[]) => vi.fn(async () => Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ items }) }] }] }));
  const answer = (id: string) => ({ id, state: 'needed', reason: '需要确认', priority: 'normal' });
  const provider = { model: 'anything', key: 'fixture', url: 'https://provider.example/responses' };
  await expect(triageInbox(jobs, '', provider, new AbortController().signal, request([answer('a'), answer('a')]))).rejects.toThrow('无效');
  await expect(triageInbox(jobs, '', provider, new AbortController().signal, request([answer('a')]))).rejects.toThrow('不完整');
  await expect(triageInbox(jobs, '', provider, new AbortController().signal, request([answer('a'), answer('b')]))).resolves.toHaveLength(2);
});

it('streams per-item answer prefixes before completion, handling split escapes without exposing reasoning', async () => {
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  const request = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } }), { headers: { 'content-type': 'text/event-stream' } }));
  const progress = vi.fn(); let finished = false;
  const task = triageInbox([job('a'), job('b')], '', { model: 'test', key: 'fixture', url: 'https://model.test' }, new AbortController().signal, request, progress)
    .then(result => { finished = true; return result; });
  const emit = (event: object, newline = true) => {
    const bytes = new TextEncoder().encode('data: ' + JSON.stringify(event) + (newline ? '\n\n' : ''));
    for (let i = 0; i < bytes.length; i += 7) stream.enqueue(bytes.slice(i, i + 7));
  };
  emit({ type: 'response.reasoning_text.delta', delta: 'private-reasoning' });
  emit({ type: 'response.output_text.delta', delta: '{"items":[{"id":"a","state":"needed","reason":"需要\\u786' });
  await vi.waitFor(() => expect(progress).toHaveBeenLastCalledWith([{ id: 'a', text: '需要' }]));
  expect(finished).toBe(false);
  emit({ type: 'response.output_text.delta', delta: 'e认\\"版本{A}\\"","priority":"normal"},{"id":"b","reason":"信息不足' });
  await vi.waitFor(() => expect(progress).toHaveBeenLastCalledWith([{ id: 'a', text: '需要确认"版本{A}"' }, { id: 'b', text: '信息不足' }]));
  const items = [{ id: 'a', state: 'needed', reason: '需要确认"版本{A}"', priority: 'normal' }, { id: 'b', state: 'uncertain', reason: '信息不足', priority: 'normal' }];
  emit({ type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ items }) }] }] } }, false);
  stream.close();
  expect(await task).toEqual(items);
  expect(JSON.stringify(progress.mock.calls)).not.toContain('private-reasoning');
});

it('sends all 50 items with a scaled output budget and rejects oversized calls before requesting', async () => {
  const jobs = Array.from({ length: 50 }, (_, i) => job(String(i)));
  const items = jobs.map(j => ({ id: j.id, state: 'quiet', reason: '无需动作', priority: 'normal' }));
  const request = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    expect(JSON.parse(body.input[0].content).items.map((v: { id: string }) => v.id)).toEqual(jobs.map(j => j.id));
    expect(body.max_output_tokens).toBe(16000); expect(body.model).toBe('deepseek-flash');
    return Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ items }) }] }] });
  });
  const provider = { model: 'test', key: 'fixture', url: 'https://model.test' };
  await expect(triageInbox(jobs, '', provider, new AbortController().signal, request)).resolves.toHaveLength(50);
  await expect(triageInbox([...jobs, job('extra')], '', provider, new AbortController().signal, request)).rejects.toThrow('50');
  expect(request).toHaveBeenCalledTimes(1);
});
