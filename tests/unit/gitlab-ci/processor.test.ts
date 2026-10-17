import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, expect, it, vi } from 'vitest';
import type { AgentAdapter } from '../../../src/agent/types';
import { processAnalysis } from '../../../src/inbox/processor';
import { GitLabClient, GitLabError, type FailedJob, type Pipeline } from '../../../src/gitlab-ci/client';
import { normalizeGitLabCi } from '../../../src/gitlab-ci/config';
import { analyzeCi } from '../../../src/gitlab-ci/processor';
import { failureId, type CiRun } from '../../../src/gitlab-ci/service';

vi.mock('../../../src/inbox/processor', () => ({ processAnalysis: vi.fn() }));
beforeEach(() => vi.mocked(processAnalysis).mockReset().mockResolvedValue({
  text: JSON.stringify({ replyDraft: '结论', analysis: '已核实日志', missingInfo: '' }), inputTokens: 10, outputTokens: 20,
}));
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
  return { config, run, client, agent: {} as AgentAdapter, signal: new AbortController().signal };
}

it('archives evidence and runs Flash at max effort with read-only investigation instructions', async () => {
  const s = await setup(); const path = await analyzeCi(s.run, s.config, s.client, s.agent, s.signal, { model: 'deepseek-flash', reasoningEffort: 'max' });
  expect(processAnalysis).toHaveBeenCalledWith(s.agent, expect.objectContaining({ model: 'deepseek-flash', reasoningEffort: 'max',
    cwd: join(s.config.outputDir, s.run.id), prompt: expect.stringContaining('不要重试/取消/触发 CI') }), s.signal);
  expect(JSON.parse(await readFile(path!, 'utf8'))).toMatchObject({ runId: s.run.id, analysis: '已核实日志', model: 'deepseek-flash' });
  const evidence = JSON.parse(await readFile(join(s.config.outputDir, s.run.id, 'evidence.json'), 'utf8'));
  expect(evidence.pipeline.sha).toBe('a'.repeat(40));
  expect(evidence.evidence[0].trace.tail).toBe('test failed');
  await analyzeCi(s.run, s.config, s.client, s.agent, s.signal, { model: 'deepseek-flash', reasoningEffort: 'max' });
  expect(processAnalysis).toHaveBeenCalledTimes(1);
});

it.each(['success', 'running', 'canceled'])('skips a failure that is now %s', async status => {
  const s = await setup(); vi.mocked(s.client.pipeline).mockResolvedValue({ ...s.run.pipeline, status });
  expect(await analyzeCi(s.run, s.config, s.client, s.agent, s.signal, { model: 'deepseek-flash', reasoningEffort: 'max' })).toBeUndefined();
  expect(processAnalysis).not.toHaveBeenCalled();
});

it('skips an obsolete failure signature after a retry', async () => {
  const s = await setup(); vi.mocked(s.client.failures).mockResolvedValue([{ ...s.run.failures[0]!, id: 21 }]);
  expect(await analyzeCi(s.run, s.config, s.client, s.agent, s.signal, { model: 'deepseek-flash', reasoningEffort: 'max' })).toBeUndefined();
  expect(processAnalysis).not.toHaveBeenCalled();
});

it('records erased traces as missing evidence and retries transient errors', async () => {
  const s = await setup(); vi.mocked(s.client.trace).mockRejectedValue(new GitLabError('GitLab API HTTP 404'));
  await analyzeCi(s.run, s.config, s.client, s.agent, s.signal, { model: 'deepseek-flash', reasoningEffort: 'max' });
  expect(await readFile(join(s.config.outputDir, s.run.id, 'evidence.json'), 'utf8')).toContain('missingTrace');
  const next = await setup(); vi.mocked(next.client.trace).mockRejectedValue(new GitLabError('GitLab API HTTP 503'));
  await expect(analyzeCi(next.run, next.config, next.client, next.agent, next.signal, { model: 'deepseek-flash', reasoningEffort: 'max' })).rejects.toThrow('503');
  expect(processAnalysis).toHaveBeenCalledTimes(1);
});
