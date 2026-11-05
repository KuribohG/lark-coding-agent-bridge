import { expect, it } from 'vitest';
import { normalizeGitLabCi } from '../../../src/monitoring/sources/gitlab-ci/config';
import { ciTaskEvent } from '../../../src/monitoring/sources/gitlab-ci/inbox-source';
import type { CiRun } from '../../../src/monitoring/sources/gitlab-ci/service';

function fixture() {
  const config = normalizeGitLabCi({ executorProfile: 'codex', url: 'https://gitlab.test', outputDir: '/private/ci' });
  const run: CiRun = { id: 'a'.repeat(32), url: config.url, executorProfile: 'codex', createdAt: 1, updatedAt: 1,
    repository: { project: 'group/repo', refs: [], sourceDir: '' }, failures: [],
    pipeline: { id: 1, ref: 'dev', sha: 'a'.repeat(40), web_url: 'https://gitlab.test/group/repo/-/pipelines/1', status: 'failed', updated_at: '' },
    state: 'queued', retryAt: 0 };
  return { config, run };
}

it('maps a failed pipeline to a fresh investigation event', () => {
  const { config, run } = fixture();
  expect(ciTaskEvent(run, config)).toMatchObject({ key: run.id, title: 'group/repo · CI #1', url: run.pipeline.web_url,
    evidenceDir: `/private/ci/${run.id}`, maxAttempts: 3, data: run });
});

it('rejects invalid IDs and does not expose an off-site pipeline URL', () => {
  const { config, run } = fixture();
  run.pipeline.web_url = 'javascript:alert(1)';
  expect(ciTaskEvent(run, config).url).toBe('');
  run.pipeline.web_url = 'https://other.test/pipelines/1';
  expect(ciTaskEvent(run, config).url).toBe('');
  expect(() => ciTaskEvent({ ...run, id: '../x' }, config)).toThrow('Invalid CI failure ID');
});
