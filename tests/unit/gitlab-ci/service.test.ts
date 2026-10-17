import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { normalizeGitLabCi } from '../../../src/gitlab-ci/config';
import { GitLabCiService, type CiIO } from '../../../src/gitlab-ci/service';
import { GitLabError, type FailedJob, type Pipeline } from '../../../src/gitlab-ci/client';

const pipeline: Pipeline = { id: 10, status: 'failed', ref: 'main', sha: 'a'.repeat(40), web_url: 'https://gitlab.test/pipelines/10', updated_at: '2026-10-17T10:00:00Z' };
const failure: FailedJob = { id: 20, name: 'test', stage: 'test', status: 'failed', allow_failure: false, web_url: '', kind: 'job' };
const services: GitLabCiService[] = [];
afterEach(async () => { for (const service of services.splice(0)) await service.close(); });
async function setup(overrides: Partial<CiIO> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'ci-watch-'));
  const config = normalizeGitLabCi({ enabled: true, executorProfile: 'codex', url: 'https://gitlab.test', outputDir: dir,
    repositories: [{ project: 'group/project' }] });
  let now = Date.parse('2026-10-17T10:00:00Z');
  const io: CiIO = { pipelines: vi.fn(async () => [pipeline]), failures: vi.fn(async () => [failure]),
    analyze: vi.fn(async () => join(dir, 'result.json')), ...overrides };
  const create = () => { const s = new GitLabCiService(join(dir, 'state.json'), config, io, () => now); services.push(s); return s; };
  const service = create(); await service.start(false);
  return { service, config, io, create, advance: (ms = 180_000) => { now += ms; } };
}

it('starts at an activation baseline and keeps the cursor on API failure', async () => {
  const s = await setup({ pipelines: vi.fn(async () => { throw new GitLabError('GitLab API HTTP 503'); }) });
  const baseline = Object.values(s.service.data.repositories)[0]!;
  const cursor = baseline.cursor;
  s.advance(); await s.service.tick(); await s.service.idle();
  expect(Object.values(s.service.data.repositories)[0]).toEqual({ since: cursor, cursor });
  expect(s.service.data.lastError).toContain('503');
  expect(s.io.analyze).not.toHaveBeenCalled();
  expect(JSON.parse(await readFile(s.service.path, 'utf8')).repositories).toEqual(s.service.data.repositories);
});

it('deduplicates overlapping polls and completed runs after restart', async () => {
  const s = await setup(); await s.service.tick(); await s.service.idle();
  await s.service.tick(); await s.service.idle();
  expect(s.io.analyze).toHaveBeenCalledTimes(1);
  expect(s.service.data.runs[0]?.state).toBe('done');
  await s.service.close();
  const restarted = s.create(); await restarted.start(false); await restarted.tick(); await restarted.idle();
  expect(s.io.analyze).toHaveBeenCalledTimes(1);
});

it('analyzes a new failed retry in the same pipeline once', async () => {
  const s = await setup(); await s.service.tick(); await s.service.idle();
  vi.mocked(s.io.failures).mockResolvedValue([{ ...failure, id: 21 }]);
  await s.service.tick(); await s.service.idle();
  expect(s.io.analyze).toHaveBeenCalledTimes(2);
});

it.each(['canceled', 'skipped', 'manual', 'running', 'success'])('does not analyze %s pipelines', async status => {
  const s = await setup({ pipelines: vi.fn(async () => [{ ...pipeline, status }]) });
  await s.service.tick(); await s.service.idle();
  expect(s.io.analyze).not.toHaveBeenCalled();
});

it('respects exact ref filters', async () => {
  const s = await setup(); s.config.repositories[0]!.refs = ['dev'];
  await s.service.tick(); await s.service.idle(); expect(s.io.analyze).not.toHaveBeenCalled();
});

it('bounds analysis retries, persists failures, and does not leak raw errors', async () => {
  const s = await setup({ analyze: vi.fn(async () => { throw Error('secret upstream diagnostic'); }) });
  for (let i = 0; i < 5; i++) { await s.service.tick(); await s.service.idle(); s.advance(); }
  expect(s.io.analyze).toHaveBeenCalledTimes(3);
  expect(s.service.data.runs[0]).toMatchObject({ state: 'failed', attempts: 3 });
  expect(await readFile(s.service.path, 'utf8')).not.toContain('secret upstream');
});

it('keeps polling during analysis and runs only one analysis at a time', async () => {
  let finish!: (value: string) => void;
  const analyze = vi.fn<CiIO['analyze']>().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValue('result.json');
  const s = await setup({ analyze });
  await s.service.tick(); await vi.waitFor(() => expect(finish).toBeDefined());
  vi.mocked(s.io.pipelines).mockResolvedValue([pipeline, { ...pipeline, id: 11 }]);
  await s.service.tick(); expect(analyze).toHaveBeenCalledTimes(1);
  expect(s.service.data.runs).toHaveLength(2);
  finish('result.json'); await s.service.idle(); expect(analyze).toHaveBeenCalledTimes(2);
});

it('continues other repositories when one repository is unavailable', async () => {
  const s = await setup({ pipelines: vi.fn(async project => {
    if (project === 'group/project') throw new GitLabError('GitLab API HTTP 403');
    return [pipeline];
  }) });
  s.config.repositories.push({ project: 'group/second', sourceDir: '', refs: [] });
  await s.service.close(); const restarted = s.create(); await restarted.start(false); await restarted.tick(); await restarted.idle();
  expect(s.io.analyze).toHaveBeenCalledTimes(1);
  expect(restarted.data.runs[0]?.repository.project).toBe('group/second');
});

it('aborts in-flight work on shutdown and recovers with a bounded retry', async () => {
  const analyze = vi.fn<CiIO['analyze']>().mockImplementationOnce((_run, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(Error('aborted')), { once: true });
  })).mockResolvedValue('result.json');
  const s = await setup({ analyze }); await s.service.tick(); await vi.waitFor(() => expect(analyze).toHaveBeenCalledTimes(1));
  await s.service.close(); s.advance();
  const restarted = s.create(); await restarted.start(false); await restarted.tick(); await restarted.idle();
  expect(analyze).toHaveBeenCalledTimes(2); expect(restarted.data.runs[0]?.state).toBe('done');
});

it('persists the topic before analysis and retries delivery without rerunning the model', async () => {
  const topic = { chatId: 'oc_result', threadId: 'omt_result', replyTo: 'om_result' };
  const s = await setup({ announce: vi.fn(async () => topic), deliver: vi.fn(async () => { throw Error('lost response'); }) });
  await s.service.tick(); await s.service.idle();
  expect(s.service.data.runs[0]).toMatchObject({ state: 'ready', topic, deliveryAttempts: 1 });
  await s.service.close(); s.advance();
  const restarted = s.create(); await restarted.start(false);
  vi.mocked(s.io.deliver!).mockResolvedValue();
  await restarted.tick(); await restarted.idle();
  expect(s.io.announce).toHaveBeenCalledTimes(1); expect(s.io.analyze).toHaveBeenCalledTimes(1);
  expect(s.io.deliver).toHaveBeenCalledTimes(2); expect(restarted.data.runs[0]?.state).toBe('done');
});

it('does not start analysis if topic creation fails', async () => {
  const s = await setup({ announce: vi.fn(async () => { throw Error('send failed'); }) });
  await s.service.tick(); await s.service.idle(); expect(s.io.analyze).not.toHaveBeenCalled();
});

it('closes an obsolete failure topic without running another analysis', async () => {
  const s = await setup({ announce: vi.fn(async () => ({ chatId: 'oc_result', threadId: 'omt_result', replyTo: 'om_result' })),
    analyze: vi.fn(async () => undefined), deliver: vi.fn(async () => {}) });
  await s.service.tick(); await s.service.idle();
  expect(s.io.deliver).toHaveBeenCalledTimes(1);
  expect(s.service.data.runs[0]).toMatchObject({ state: 'obsolete', deliveryAttempts: 1 });
  await s.service.tick(); await s.service.idle(); expect(s.io.analyze).toHaveBeenCalledTimes(1);
});

it('bounds delivery failures without rerunning analysis', async () => {
  const s = await setup({ announce: vi.fn(async () => ({ chatId: 'oc_result', threadId: 'omt_result', replyTo: 'om_result' })),
    deliver: vi.fn(async () => { throw Error('delivery failed'); }) });
  for (let i = 0; i < 5; i++) { await s.service.tick(); await s.service.idle(); s.advance(); }
  expect(s.io.analyze).toHaveBeenCalledTimes(1); expect(s.io.deliver).toHaveBeenCalledTimes(3);
  expect(s.service.data.runs[0]).toMatchObject({ state: 'ready', deliveryAttempts: 3 });
});
