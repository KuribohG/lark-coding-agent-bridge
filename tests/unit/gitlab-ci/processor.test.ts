import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { GitLabClient, GitLabError, type FailedJob, type Pipeline } from '../../../src/monitoring/sources/gitlab-ci/client';
import { normalizeGitLabCi } from '../../../src/monitoring/sources/gitlab-ci/config';
import { prepareCi } from '../../../src/monitoring/sources/gitlab-ci/processor';
import { failureId, type CiRun } from '../../../src/monitoring/sources/gitlab-ci/service';

async function setup() {
  const outputDir = await mkdtemp(join(tmpdir(), 'ci-analysis-'));
  const config = normalizeGitLabCi({ url: 'https://gitlab.test', outputDir, executorProfile: 'codex' });
  const pipeline: Pipeline = { id: 10, status: 'failed', sha: 'a'.repeat(40), ref: 'main', web_url: '', updated_at: '' };
  const failures: FailedJob[] = [{ id: 20, name: 'test', stage: 'test', status: 'failed', kind: 'job', allow_failure: false, web_url: '' }];
  const run: CiRun = { id: failureId(config.url, 'group/project', 10, failures), url: config.url, executorProfile: 'codex',
    repository: { project: 'group/project', refs: [], sourceDir: '/code/project' }, pipeline, failures,
    createdAt: 1, updatedAt: 1, state: 'running', attempts: 1, retryAt: 0 };
  const client = new GitLabClient(config.url, 'fixture', vi.fn());
  vi.spyOn(client, 'pipeline').mockResolvedValue(pipeline);
  vi.spyOn(client, 'failures').mockResolvedValue(failures);
  vi.spyOn(client, 'trace').mockResolvedValue({ path: 'job.log', bytes: 10, tail: 'test failed', truncated: false });
  return { config, run, client, signal: new AbortController().signal };
}

it('archives exact evidence and prepares a read-only inbox task without executing an agent', async () => {
  const s = await setup(); const task = await prepareCi(s.run, s.config, s.client, s.signal);
  expect(task.cwd).toBe(join(s.config.outputDir, s.run.id));
  expect(task.prompt).toContain('不要重试/取消/触发 CI');
  const evidence = JSON.parse(await readFile(join(task.cwd, 'evidence.json'), 'utf8'));
  expect(evidence.pipeline.sha).toBe('a'.repeat(40));
  expect(evidence.evidence[0].trace.tail).toBe('test failed');
  await writeFile(join(task.cwd, 'result.json'), JSON.stringify({ runId: s.run.id, replyDraft: '结论', analysis: '已核实日志', missingInfo: '' }));
  const cached = await prepareCi(s.run, s.config, s.client, s.signal);
  expect(cached.cached?.text).toContain('已核实日志');
  expect(s.client.pipeline).toHaveBeenCalledTimes(1);
  await prepareCi(s.run, s.config, s.client, s.signal, false);
  expect(s.client.pipeline).toHaveBeenCalledTimes(2);
});

it.each(['success', 'running', 'canceled'])('skips a failure that is now %s', async status => {
  const s = await setup(); vi.mocked(s.client.pipeline).mockResolvedValue({ ...s.run.pipeline, status });
  expect((await prepareCi(s.run, s.config, s.client, s.signal)).cached?.text).toContain('失败已过期');
});

it('skips an obsolete failure signature after a retry', async () => {
  const s = await setup(); vi.mocked(s.client.failures).mockResolvedValue([{ ...s.run.failures[0]!, id: 21 }]);
  expect((await prepareCi(s.run, s.config, s.client, s.signal)).cached?.text).toContain('失败已过期');
});

it('records erased traces as missing evidence and retries transient errors', async () => {
  const s = await setup(); vi.mocked(s.client.trace).mockRejectedValue(new GitLabError('GitLab API HTTP 404'));
  await prepareCi(s.run, s.config, s.client, s.signal);
  expect(await readFile(join(s.config.outputDir, s.run.id, 'evidence.json'), 'utf8')).toContain('missingTrace');
  const next = await setup(); vi.mocked(next.client.trace).mockRejectedValue(new GitLabError('GitLab API HTTP 503'));
  await expect(prepareCi(next.run, next.config, next.client, next.signal)).rejects.toThrow('503');
});
