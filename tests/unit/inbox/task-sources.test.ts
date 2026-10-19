import { executeSourceCommand } from '../../../src/inbox/workbench';
import { createWorkItemSource } from '../../../src/host/work-item-runtime';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { normalizeInbox } from '../../../src/inbox/config';
import { InboxService } from '../../../src/inbox/service';
import { InboxStore } from '../../../src/inbox/store';
import { InboxAnalysisQueue, type InboxTaskEvent } from '../../../src/inbox/task-source';
import type { InboxIO } from '../../../src/inbox/types';
import { guiContent, guiSummary } from '../../../src/inbox/presentation';
import { InboxTaskSources } from '../../../src/inbox/task-sources';

const services: InboxService[] = [];
const sources: InboxTaskSources[] = [];
afterEach(async () => { await Promise.all(services.splice(0).map(s => s.close())); await Promise.all(sources.splice(0).map(s => s.close())); });
const event: InboxTaskEvent = { key: 'pipeline-10-jobs-20', title: 'repo CI #10', reason: 'CI 失败', url: 'https://gitlab.test/ci/10', time: 1,
  data: { pipeline: 10 }, evidenceDir: '/private/ci/10' };
const result = { text: JSON.stringify({ replyDraft: '结论', analysis: '核对过日志', missingInfo: '' }), inputTokens: 1, outputTokens: 2 };
async function setup(overrides: Partial<InboxIO> = {}, enabled = true, queue?: InboxAnalysisQueue) {
  let now = 1000;
  const io: InboxIO = { checkOwner: vi.fn(async () => {}), collect: vi.fn(async () => []), context: vi.fn(async () => []),
    source: vi.fn(async () => ({ name: 'unused', type: 'group' as const })), deliver: vi.fn(async () => {}), analyze: vi.fn(async () => result),
    taskSource: { id: 'gitlab-ci', accepts: () => true }, ...overrides };
  const store = new InboxStore(join(await mkdtemp(join(tmpdir(), 'inbox-source-')), 'state.json'));
  const config = normalizeInbox({ enabled, ownerOpenId: 'ou_owner', executorProfile: 'codex', watchPrivate: false, watchMentions: false });
  const service = new InboxService(store, config, io, () => now, queue); services.push(service); await service.start();
  return { service, store, io, config, advance: () => { now += 300_000; } };
}

it('accepts an idempotent watcher event into the ordinary draft lifecycle without chat screening', async () => {
  const s = await setup(); const job = await s.service.submitTask(event);
  expect((await s.service.submitTask(event)).id).toBe(job.id);
  await s.service.tick(); await vi.waitFor(() => expect(s.service.get(job.id)?.state).toBe('ready'));
  await s.service.tick();
  expect(s.service.get(job.id)).toMatchObject({ state: 'done', replyDraft: '结论', handlingState: 'open' });
  expect(s.io.collect).not.toHaveBeenCalled(); expect(s.io.context).not.toHaveBeenCalled(); expect(s.io.analyze).toHaveBeenCalledTimes(1);
  expect(s.io.deliver).not.toHaveBeenCalled();
  expect((await s.service.submitTask(event)).state).toBe('done');
  expect(guiSummary(s.service.get(job.id)!)).toMatchObject({ sourceKind: 'gitlab-ci', executorProfile: 'codex' });
  expect(guiContent(s.service.get(job.id)!)).toMatchObject({ sourceUrl: event.url, evidenceDir: event.evidenceDir });
});

it('persists before acknowledging an event and does not accept a failed save', async () => {
  const s = await setup(); const save = vi.spyOn(s.store, 'save').mockRejectedValueOnce(Error('disk full'));
  await expect(s.service.submitTask(event)).rejects.toThrow('disk full'); expect(s.service.list()).toHaveLength(0);
  save.mockRestore(); await s.service.submitTask(event);
  expect(JSON.parse(await readFile(s.store.path, 'utf8')).jobs).toHaveLength(1);
});

it('uses the same bounded notification retries and never reruns a completed analysis', async () => {
  const topic = { chatId: 'oc_result', threadId: 'omt_result', replyTo: 'om_result' };
  const s = await setup({ beginAnalysis: vi.fn(async () => topic), deliver: vi.fn(async () => { throw Error('lost response'); }) });
  const job = await s.service.submitTask(event); await s.service.tick();
  await vi.waitFor(() => expect(s.service.get(job.id)?.state).toBe('ready'));
  await s.service.tick(); s.advance(); await s.service.tick();
  expect(s.io.analyze).toHaveBeenCalledTimes(1); expect(s.io.beginAnalysis).toHaveBeenCalledTimes(1);
  expect(s.service.get(job.id)?.error).toContain('投递未确认');
});

it('limits automatic analysis attempts but keeps explicit retries under user control', async () => {
  const s = await setup({ analyze: vi.fn(async () => { throw Error('private upstream failure'); }) });
  const job = await s.service.submitTask(event);
  for (let i = 0; i < 3; i++) {
    await s.service.tick(); await vi.waitFor(() => expect(s.service.get(job.id)?.state).toBe(i === 2 ? 'failed' : 'queued')); s.advance();
  }
  await s.service.tick(); expect(s.io.analyze).toHaveBeenCalledTimes(3);
  expect(await readFile(s.store.path, 'utf8')).not.toContain('private upstream');
  await s.service.decide(job.id, 'process', 'ou_owner'); await s.service.tick();
  await vi.waitFor(() => expect(s.service.get(job.id)?.state).toBe('failed'));
  s.advance(); await s.service.tick(); expect(s.io.analyze).toHaveBeenCalledTimes(4);
});

it('does not overwrite a human draft with a late analysis, and restoring an ignored event does not screen it', async () => {
  let finish!: (value: typeof result) => void;
  const s = await setup({ analyze: vi.fn(() => new Promise<typeof result>(resolve => { finish = resolve; })) });
  const job = await s.service.submitTask(event); await s.service.tick(); await vi.waitFor(() => expect(finish).toBeDefined());
  await s.service.review({ id: job.id, revision: s.service.get(job.id)!.revision, replyDraft: '人工草稿', handlingState: 'ignored' }, 'ou_owner', 'edit');
  finish(result); await vi.waitFor(() => expect(s.service.get(job.id)?.replyDraft).toBe('人工草稿'));
  const current = s.service.get(job.id)!;
  const restored = await s.service.review({ id: job.id, revision: current.revision, handlingState: 'open' }, 'ou_owner', 'restore');
  expect(restored).toMatchObject({ attention: { state: 'needed' }, analysisRequested: false, replyDraft: '人工草稿' });
});

it('retries an analysis after a long attempt without repeating or expiring its confirmed announcement', async () => {
  const topic = { chatId: 'oc_result', threadId: 'omt_result', replyTo: 'om_result' };
  const analyze = vi.fn<InboxIO['analyze']>().mockRejectedValueOnce(Error('transient')).mockResolvedValue(result);
  const s = await setup({ analyze, beginAnalysis: vi.fn(async () => topic) });
  const job = await s.service.submitTask(event); await s.service.tick();
  await vi.waitFor(() => expect(s.service.get(job.id)?.state).toBe('queued'));
  s.advance(); await s.service.tick(); await vi.waitFor(() => expect(s.service.get(job.id)?.state).toBe('ready'));
  expect(s.io.beginAnalysis).toHaveBeenCalledTimes(1); expect(analyze).toHaveBeenCalledTimes(2);
});

it('keeps pending events on source disable and completed imports never run again', async () => {
  const s = await setup({}, false); const job = await s.service.submitTask(event); await s.service.tick();
  expect(s.io.analyze).not.toHaveBeenCalled(); expect(s.service.get(job.id)?.state).toBe('queued');
  await s.service.setMode('on'); await s.service.tick(); await vi.waitFor(() => expect(s.io.analyze).toHaveBeenCalledTimes(1));
  const imported = await s.service.submitTask({ ...event, key: 'historic', initial: { state: 'done', analysis: '旧结论', replyDraft: '旧草稿' } });
  await s.service.tick(); expect(s.service.get(imported.id)?.analysis).toBe('旧结论'); expect(s.io.analyze).toHaveBeenCalledTimes(1);
});

it('serializes sources with one shared queue and cancellation cannot hold the next task', async () => {
  const queue = new InboxAnalysisQueue(); let finish!: (value: typeof result) => void;
  const first = await setup({ analyze: vi.fn(() => new Promise<typeof result>(resolve => { finish = resolve; })) }, true, queue);
  const second = await setup({}, true, queue); const third = await setup({}, true, queue);
  await first.service.submitTask(event); const b = await second.service.submitTask(event); await third.service.submitTask(event);
  await first.service.tick(); await vi.waitFor(() => expect(finish).toBeDefined()); await second.service.tick(); await third.service.tick();
  expect(second.io.analyze).not.toHaveBeenCalled(); expect(third.io.analyze).not.toHaveBeenCalled();
  await second.service.decide(b.id, 'ignore', 'ou_owner'); finish(result);
  await vi.waitFor(() => expect(third.io.analyze).toHaveBeenCalledTimes(1)); expect(second.io.analyze).not.toHaveBeenCalled();
});

it('lets the workbench inspect disabled source history, rejects mixed batch actions and hides driver payloads', async () => {
  const path = join(await mkdtemp(join(tmpdir(), 'inbox-source-registry-')), 'config.json');
  const registry = new InboxTaskSources(path); sources.push(registry);
  const driver = { accepts: () => true, prepare: vi.fn() };
  const a = await registry.connect(createWorkItemSource({ id: 'gitlab-ci', label: 'CI', profile: 'codex', enabled: false, executor: () => undefined, driver }, path));
  const b = await registry.connect(createWorkItemSource({ id: 'another-watch', label: 'Other', profile: 'claude', enabled: false, executor: () => undefined, driver }, path));
  const x = await a.submit(event); const y = await b.submit(event);
  const response = await executeSourceCommand(registry, { id: '00000000-0000-0000-0000-000000000000', action: 'detail', target: x.id });
  expect(response.handled).toBe(true); expect(JSON.stringify(response.result)).not.toContain('pipeline":10');
  await expect(executeSourceCommand(registry, { id: '00000000-0000-0000-0000-000000000000', action: 'detail', target: x.id },
    { owner: 'ou_other', profile: 'codex' })).rejects.toThrow('不属于当前工作台');
  await expect(executeSourceCommand(registry, { id: '00000000-0000-0000-0000-000000000001', action: 'batch',
    target: JSON.stringify({ items: [{ id: x.id, revision: x.revision }, { id: y.id, revision: y.revision }], handlingState: 'handled' }) })).rejects.toThrow('本次未修改');
  expect(registry.list().every(j => j.handlingState === 'open')).toBe(true);
});
