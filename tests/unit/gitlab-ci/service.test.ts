import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { normalizeGitLabCi } from '../../../src/monitoring/sources/gitlab-ci/config';
import { failureId, GitLabCiService, type CiIO, type CiState } from '../../../src/monitoring/sources/gitlab-ci/service';
import { GitLabError, type FailedJob, type Pipeline } from '../../../src/monitoring/sources/gitlab-ci/client';
import { memoryJournal } from '../../helpers/journal';

const pipeline: Pipeline = { id: 10, status: 'failed', ref: 'main', sha: 'a'.repeat(40), web_url: 'https://gitlab.test/pipelines/10', updated_at: '2026-10-17T10:00:00Z' };
const failure: FailedJob = { id: 20, name: 'test', stage: 'test', status: 'failed', allow_failure: false, web_url: '', kind: 'job' };
const services: GitLabCiService[] = [];
afterEach(async () => { for (const service of services.splice(0)) await service.close(); });
async function setup(overrides: Partial<CiIO> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'ci-watch-'));
  const config = normalizeGitLabCi({ enabled: true, executorProfile: 'codex', url: 'https://gitlab.test', outputDir: dir,
    repositories: [{ project: 'group/project' }] });
  let now = Date.parse('2026-10-17T10:00:00Z');
  const io: CiIO = { pipelines: vi.fn(async () => [pipeline]), failures: vi.fn(async () => [failure]), ...overrides };
  const journal = memoryJournal<CiState>();
  const create = () => { const s = new GitLabCiService(config, io, journal, () => now); services.push(s); return s; };
  const service = create(); await service.start(false);
  return { service, config, io, journal, create, advance: (ms = 180_000) => { now += ms; } };
}
const cursors = (state: CiState | undefined) => Object.values(state?.repositories ?? {});

it('commits an activation baseline and keeps the cursor on API failure', async () => {
  const s = await setup({ pipelines: vi.fn(async () => { throw new GitLabError('GitLab API HTTP 503'); }) });
  const baseline = cursors(s.journal.state())[0]!;
  expect(baseline.since).toBe(baseline.cursor);
  s.advance(); await s.service.tick(); await s.service.idle();
  expect(cursors(s.journal.state())).toEqual([baseline]);
  expect(s.service.lastError).toContain('503');
  expect(s.journal.events()).toEqual([]);
});

it('commits each failure with the cursor that found it and keeps a stable key across overlapping polls', async () => {
  const s = await setup(); s.advance(); await s.service.tick(); await s.service.idle();
  const [first] = s.journal.events();
  expect(first).toMatchObject({ key: failureId(s.config.url, 'group/project', 10, [failure]), title: 'group/project · CI #10' });
  expect(cursors(s.journal.state())[0]!.cursor).toBe(Date.parse('2026-10-17T10:03:00Z'));
  await s.service.tick(); await s.service.idle();
  // The engine deduplicates the overlap by key; the collector does not track submissions.
  expect(new Set(s.journal.events().map(event => event.key))).toEqual(new Set([first!.key]));
});

it('publishes a new failed retry in the same pipeline under a new key', async () => {
  const s = await setup(); await s.service.tick(); await s.service.idle();
  vi.mocked(s.io.failures).mockResolvedValue([{ ...failure, id: 21 }]);
  await s.service.tick(); await s.service.idle();
  expect(new Set(s.journal.events().map(event => event.key)).size).toBe(2);
});

it.each(['canceled', 'skipped', 'manual', 'running', 'success'])('does not publish %s pipelines', async status => {
  const s = await setup({ pipelines: vi.fn(async () => [{ ...pipeline, status }]) });
  await s.service.tick(); await s.service.idle();
  expect(s.journal.events()).toEqual([]);
});

it('respects exact ref filters', async () => {
  const s = await setup(); s.config.repositories[0]!.refs = ['dev'];
  await s.service.tick(); await s.service.idle(); expect(s.journal.events()).toEqual([]);
});

it('keeps the cursor when a commit fails and finds the failure again without leaking the error', async () => {
  const s = await setup(); const baseline = cursors(s.journal.state())[0]!;
  s.journal.fail(Error('secret upstream diagnostic'));
  s.advance(); await s.service.tick(); await s.service.idle();
  expect(cursors(s.journal.state())).toEqual([baseline]);
  expect(s.service.lastError).not.toContain('secret');
  s.advance(); await s.service.tick(); await s.service.idle();
  expect(s.journal.events()).toHaveLength(1);
  expect(s.service.lastError).toBeUndefined();
});

it('continues other repositories when one repository is unavailable', async () => {
  const s = await setup({ pipelines: vi.fn(async project => {
    if (project === 'group/project') throw new GitLabError('GitLab API HTTP 403');
    return [pipeline];
  }) });
  s.config.repositories.push({ project: 'group/second', sourceDir: '', refs: [] });
  await s.service.close(); const restarted = s.create(); await restarted.start(false); await restarted.tick(); await restarted.idle();
  expect(s.journal.events().map(event => (event.data as { repository: { project: string } }).repository.project)).toEqual(['group/second']);
  expect(restarted.lastError).toContain('403');
});

it('does not commit work that shutdown interrupted', async () => {
  const pipelines = vi.fn<CiIO['pipelines']>().mockImplementationOnce((_p, _s, _u, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(Error('aborted')), { once: true });
  })).mockResolvedValue([pipeline]);
  const s = await setup({ pipelines }); const tick = s.service.tick(); await vi.waitFor(() => expect(pipelines).toHaveBeenCalledTimes(1));
  await s.service.close(); await tick;
  expect(s.journal.commits).toHaveLength(1);
  s.advance(); const restarted = s.create(); await restarted.start(false); await restarted.tick(); await restarted.idle();
  expect(s.journal.events()).toHaveLength(1);
});
