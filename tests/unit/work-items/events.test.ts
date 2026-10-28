import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { normalizeInbox } from '../../../src/inbox/config';
import { WorkItemService } from '../../../src/work-items/service';
import { WorkItemStore } from '../../../src/work-items/store';
import { EventSource } from '../../../src/work-items/event-source';
import type { AnalysisResult, RuleAssessmentPolicy, SourceContext, WorkItemRuntime } from '../../../src/work-items/contracts';
import type { WorkItemEvent } from '../../../src/work-items/events';
import { workItemTarget } from '../../../src/inbox/lark-target';

const services: WorkItemService[] = [];
afterEach(async () => { await Promise.all(services.splice(0).map(service => service.close())); });
const event: WorkItemEvent = { key: 'issue-1', eventId: 'observation-1', revision: 1, title: 'CI failure',
  reason: 'failed', time: 1, url: 'https://gitlab.test/pipeline/1', data: { status: 'failed' } };
const report = (text = 'current'): AnalysisResult => ({
  text: JSON.stringify({ replyDraft: text, analysis: `${text} evidence`, missingInfo: '' }), inputTokens: 1, outputTokens: 2,
});
const update = (revision: number, extra: Partial<WorkItemEvent> = {}): WorkItemEvent =>
  ({ ...event, eventId: `observation-${revision}`, revision, ...extra });

async function setup(options: { runtime?: Partial<WorkItemRuntime>; enabled?: boolean; policy?: RuleAssessmentPolicy; owner?: string } = {}) {
  const folder = await mkdtemp(join(tmpdir(), 'work-items-'));
  const config = normalizeInbox({ enabled: options.enabled ?? true, recipientKey: options.owner ?? 'ou_owner', executorProfile: 'codex',
    target: workItemTarget({ chatId: 'oc_result', threadId: 'omt_result', replyTo: 'om_result' }) });
  const runtime: WorkItemRuntime = { source: new EventSource('test-source', () => true, options.policy),
    checkAccess: vi.fn(async () => {}), deliver: vi.fn(async () => {}), investigate: vi.fn(async () => report()), ...options.runtime };
  const store = new WorkItemStore(join(folder, 'state.json'));
  const service = new WorkItemService(store, config, runtime, () => 1000);
  services.push(service); await service.start();
  return { service, store, config, runtime };
}

it('supports a source without chat IO, and analysis completion leaves the source issue open', async () => {
  const s = await setup(); const item = await s.service.observe(event);
  expect(item).toMatchObject({ origin: { sourceId: 'test-source', key: event.key }, sourceRef: { kind: 'external' }, messages: [], evidenceVersion: 1 });
  await s.service.tick(); await vi.waitFor(() => expect(s.service.get(item.id)?.state).toBe('ready'));
  expect(s.service.get(item.id)).toMatchObject({ businessState: 'open', handlingState: 'open', analyzedVersion: 1 });
  expect(s.runtime.investigate).toHaveBeenCalledTimes(1);
});

it('uses the source rule before queueing and records a quiet observation without analysis', async () => {
  const policy: RuleAssessmentPolicy = { kind: 'rule', evaluate: vi.fn<RuleAssessmentPolicy['evaluate']>(e =>
    ({ state: (e.data as { status: string }).status === 'failed' ? 'needed' : 'quiet', reason: e.reason })) };
  const s = await setup({ policy });
  const quiet = await s.service.observe({ ...event, data: { status: 'success' } });
  await s.service.tick(); expect(s.runtime.investigate).not.toHaveBeenCalled();
  expect(quiet).toMatchObject({ attention: { state: 'quiet' }, analysisRequested: false });
  await s.service.observe(update(2)); await s.service.tick();
  await vi.waitFor(() => expect(s.runtime.investigate).toHaveBeenCalledTimes(1));
  expect(policy.evaluate).toHaveBeenCalledTimes(2);
});

it('deduplicates revisions, ignores older input and rejects a conflicting same-version observation', async () => {
  const s = await setup({ enabled: false }); const first = await s.service.observe(event);
  const second = await s.service.observe(update(2, { reason: 'new evidence' }));
  expect(second.id).toBe(first.id); expect(second.evidenceVersion).toBe(2);
  expect(await s.service.observe(update(2, { reason: 'new evidence' }))).toEqual(second);
  expect(await s.service.observe(event)).toEqual(second);
  await expect(s.service.observe(update(2, { reason: 'conflicting evidence' }))).rejects.toThrow('版本冲突');
  await expect(s.service.observe(update(3, { eventId: 'observation-2' }))).rejects.toThrow('不可复用');
  expect(s.service.get(first.id)).toEqual(second);
});

it('accepts the same observation after persistence with reordered JSON fields', async () => {
  const s = await setup({ enabled: false });
  const input = { ...event, data: { status: 'failed', nodes: [{ id: 'node-1', error: 'timeout' }] } };
  const first = await s.service.observe(input);
  await s.service.close();
  const store = new WorkItemStore(s.store.path);
  const restarted = new WorkItemService(store, s.config, s.runtime, () => 1000);
  services.push(restarted); await restarted.start();
  const reordered = Object.fromEntries(Object.entries({ ...input,
    data: { nodes: [{ error: 'timeout', id: 'node-1' }], status: 'failed' },
  }).reverse()) as unknown as WorkItemEvent;
  expect(await restarted.observe(reordered)).toEqual(first);
  expect(restarted.list()).toHaveLength(1);
});

it('records an initial recovery without analysis and reopens on a later failure', async () => {
  const s = await setup();
  const item = await s.service.observe({ ...event, operation: 'resolve' });
  await s.service.tick();
  expect(s.service.get(item.id)).toMatchObject({ businessState: 'resolved', state: 'done', analysisRequested: false });
  expect(s.runtime.investigate).not.toHaveBeenCalled();
  await s.service.observe(update(2)); await s.service.tick();
  await vi.waitFor(() => expect(s.service.get(item.id)?.state).toBe('ready'));
  expect(s.service.get(item.id)).toMatchObject({ businessState: 'open', analyzedVersion: 2 });
  expect(s.runtime.investigate).toHaveBeenCalledTimes(1);
});

it.each([{ revision: 0 }, { revision: 1.5 }, { eventId: '' }, { operation: 'resolve', revision: undefined }])(
  'rejects an invalid observation envelope %j', async invalid => {
    const s = await setup();
    await expect(s.service.observe({ ...event, ...invalid } as WorkItemEvent)).rejects.toThrow('无效盯盘事项');
    expect(s.service.list()).toHaveLength(0);
  });

it('rolls back a failed update save so replay can still apply the same observation', async () => {
  const s = await setup({ enabled: false }); const first = await s.service.observe(event);
  const save = vi.spyOn(s.store, 'save').mockRejectedValueOnce(Error('disk full'));
  await expect(s.service.observe(update(2))).rejects.toThrow('disk full');
  expect(s.service.get(first.id)).toEqual(first);
  save.mockRestore(); await s.service.observe(update(2));
  const persisted = JSON.parse(await readFile(s.store.path, 'utf8'));
  expect(persisted.jobs[0]).toMatchObject({ observation: { revision: 2 }, evidenceVersion: 2 });
});

it('does not cancel a running investigation when persisting its replacement failed', async () => {
  let finish!: (result: AnalysisResult) => void;
  let signal!: AbortSignal;
  const s = await setup({ runtime: { investigate: vi.fn<WorkItemRuntime['investigate']>((_item, currentSignal) => {
    signal = currentSignal; return new Promise(resolve => { finish = resolve; });
  }) } });
  const item = await s.service.observe(event); await s.service.tick(); await vi.waitFor(() => expect(finish).toBeDefined());
  vi.spyOn(s.store, 'save').mockRejectedValueOnce(Error('disk full'));
  await expect(s.service.observe(update(2))).rejects.toThrow('disk full');
  expect(signal.aborted).toBe(false);
  finish(report()); await vi.waitFor(() => expect(s.service.get(item.id)?.state).toBe('ready'));
  expect(s.service.get(item.id)?.analyzedVersion).toBe(1);
});

it('discards a superseded result and investigates the new evidence in the same item and topic', async () => {
  let finish!: (result: AnalysisResult) => void;
  const investigate = vi.fn<WorkItemRuntime['investigate']>()
    .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValue(report('new'));
  const topic = workItemTarget({ chatId: 'oc_result', threadId: 'omt_result', replyTo: 'om_result' });
  const s = await setup({ runtime: { investigate, beginAnalysis: vi.fn(async () => topic) } });
  const item = await s.service.observe(event); await s.service.tick(); await vi.waitFor(() => expect(finish).toBeDefined());
  await s.service.observe(update(2));
  expect(investigate.mock.calls[0]![1].aborted).toBe(true);
  finish(report('old'));
  await vi.waitFor(() => expect(s.service.get(item.id)?.replyDraft).toBe('new'));
  expect(s.service.list()).toHaveLength(1);
  expect(s.service.get(item.id)).toMatchObject({ analyzedVersion: 2, evidenceVersion: 2, analysisTarget: topic, businessState: 'open' });
  expect(s.runtime.beginAnalysis).toHaveBeenCalledTimes(1);
});

it('records recovery separately from human handling and blocks a late active-incident report', async () => {
  let finish!: (result: AnalysisResult) => void;
  const s = await setup({ runtime: { investigate: vi.fn<WorkItemRuntime['investigate']>(() => new Promise(resolve => { finish = resolve; })) } });
  const item = await s.service.observe(event); await s.service.tick(); await vi.waitFor(() => expect(finish).toBeDefined());
  await s.service.observe(update(2, { operation: 'resolve', reason: 'recovered' })); finish(report('old'));
  await s.service.tick();
  await vi.waitFor(() => expect(s.service.get(item.id)?.analysisRequested).toBe(false));
  expect(s.service.get(item.id)).toMatchObject({ businessState: 'resolved', handlingState: 'open', attention: { state: 'quiet' } });
  expect(s.service.get(item.id)?.replyDraft).toBeUndefined();
  expect(s.runtime.investigate).toHaveBeenCalledTimes(1); expect(s.runtime.deliver).not.toHaveBeenCalled();
});

it('replaces only the affected parallel investigation and waits for its old attempt to settle', async () => {
  const runs: { id: string; signal: AbortSignal; finish: (result: AnalysisResult) => void }[] = [];
  const s = await setup({ runtime: { investigate: vi.fn<WorkItemRuntime['investigate']>((item, signal) =>
    new Promise(resolve => { runs.push({ id: item.id, signal, finish: resolve }); })) } });
  const item = await s.service.observe(event);
  const other = await s.service.observe({ ...event, key: 'unrelated' });
  try {
    await s.service.tick(); await vi.waitFor(() => expect(runs).toHaveLength(2));
    await s.service.observe(update(2)); await s.service.tick();
    expect(runs).toHaveLength(2);
    expect(runs[0]!.signal.aborted).toBe(true); expect(runs[1]!.signal.aborted).toBe(false);
    runs[0]!.finish(report('stale'));
    await vi.waitFor(() => expect(runs).toHaveLength(3), { timeout: 3000 });
    expect(runs[2]!.id).toBe(item.id); expect(s.service.get(item.id)?.replyDraft).toBeUndefined();
    runs[2]!.finish(report('updated')); runs[1]!.finish(report('unrelated'));
    await vi.waitFor(() => expect(s.service.get(item.id)?.replyDraft).toBe('updated'));
    await vi.waitFor(() => expect(s.service.get(other.id)?.replyDraft).toBe('unrelated'));
  } finally { runs.forEach(run => run.finish(report())); }
});

it.each(['open', 'ignored', 'handled'] as const)('updates evidence without reviving a manually controlled %s item', async handlingState => {
  const s = await setup(); const item = await s.service.observe(event);
  await s.service.review({ id: item.id, revision: item.revision, handlingState, replyDraft: 'human draft' }, 'ou_owner', 'review-1');
  await s.service.observe(update(2)); await s.service.tick();
  expect(s.service.get(item.id)).toMatchObject({ evidenceVersion: 2, replyDraft: 'human draft', handlingState, analysisPaused: true, analysisRequested: false });
  expect(s.runtime.investigate).not.toHaveBeenCalled();
});

it('resets unsupported version-1 state instead of migrating removed Lark fields', async () => {
  const s = await setup({ enabled: false }); const item = await s.service.observe(event);
  await writeFile(s.store.path, JSON.stringify({ ...s.store.data, version: 1, jobs: [item] }));
  const loaded = new WorkItemStore(s.store.path); await loaded.load();
  expect(loaded.data).toMatchObject({ version: 2, jobs: [], cursors: {}, seen: {}, autoUsage: {} });
  expect(JSON.parse(await readFile(s.store.path, 'utf8')).version).toBe(2);
});

it('retains create-only semantics for old collectors and scopes the same key by owner', async () => {
  const a = await setup({ enabled: false }); const b = await setup({ enabled: false, owner: 'ou_other' });
  const legacy = { ...event, revision: undefined, eventId: undefined };
  const item = await a.service.observe(legacy);
  expect(await a.service.observe({ ...legacy, reason: 'ignored duplicate' })).toEqual(item);
  expect((await b.service.observe(legacy)).id).not.toBe(item.id);
});

it('closes a source once and rejects input after shutdown', async () => {
  const close = vi.fn();
  const source = Object.assign(new EventSource('test-source', () => true), { close });
  const s = await setup({ runtime: { source } });
  await Promise.all([s.service.close(), s.service.close()]);
  expect(close).toHaveBeenCalledTimes(1);
  await expect(s.service.observe(event)).rejects.toThrow('来源已关闭');
});

it('runs a new polling source through the same durable observation and investigation lifecycle', async () => {
  let context!: SourceContext;
  const source = Object.assign(new EventSource('custom-poll', () => true), {
    attach: (host: SourceContext) => { context = host; },
    poll: async () => { await context.observe(event); },
  });
  const s = await setup({ runtime: { source } });
  await s.service.tick();
  await vi.waitFor(() => expect(s.service.list()[0]?.state).toBe('ready'));
  await s.service.tick();
  expect(s.service.list()).toHaveLength(1);
  expect(s.service.list()[0]).toMatchObject({ origin: { sourceId: 'custom-poll' }, replyDraft: 'current' });
  expect(s.runtime.investigate).toHaveBeenCalledTimes(1);
});
