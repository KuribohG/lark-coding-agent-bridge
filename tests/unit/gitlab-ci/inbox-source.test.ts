import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { normalizeGitLabCi } from '../../../src/monitoring/sources/gitlab-ci/config';
import { ciTaskEvent } from '../../../src/monitoring/sources/gitlab-ci/inbox-source';
import type { CiRun } from '../../../src/monitoring/sources/gitlab-ci/service';

async function fixture() {
  const outputDir = await mkdtemp(join(tmpdir(), 'ci-import-'));
  const config = normalizeGitLabCi({ executorProfile: 'codex', url: 'https://gitlab.test', outputDir,
    notification: { ownerOpenId: 'ou_owner', destination: { chatId: 'oc_result', threadId: 'omt_result', replyTo: 'om_result' } } });
  const run: CiRun = { id: 'a'.repeat(32), url: config.url, executorProfile: 'codex', createdAt: 1, updatedAt: 1,
    repository: { project: 'group/repo', refs: [], sourceDir: '' }, failures: [],
    pipeline: { id: 1, ref: 'dev', sha: 'a'.repeat(40), web_url: 'https://gitlab.test/group/repo/-/pipelines/1', status: 'failed', updated_at: '' },
    state: 'ready', attempts: 1, retryAt: 0, resultPath: join(outputDir, 'a'.repeat(32), 'result.json'), topic: config.notification!.destination };
  await mkdir(join(outputDir, run.id));
  await writeFile(run.resultPath!, JSON.stringify({ runId: run.id, replyDraft: '旧结论', analysis: '旧证据', missingInfo: '' }));
  return { config, run };
}

it.each([0, 1, 3])('imports previous delivery attempt count %s without an ambiguous resend', async deliveryAttempts => {
  const { config, run } = await fixture(); run.deliveryAttempts = deliveryAttempts;
  const event = await ciTaskEvent(run, config);
  expect(event.initial).toMatchObject({ state: deliveryAttempts ? 'done' : 'ready', replyDraft: '旧结论', analysisTopic: run.topic });
  if (deliveryAttempts) expect(event.initial?.error).toContain('不再自动发送');
});

it('imports delivered results, and never reruns a missing or interrupted old result automatically', async () => {
  const { config, run } = await fixture(); run.deliveredAt = 100;
  expect((await ciTaskEvent(run, config)).initial).toMatchObject({ state: 'done', deliveredAt: 100 });
  run.id = 'b'.repeat(32);
  expect((await ciTaskEvent(run, config)).initial).toMatchObject({ state: 'failed' });
  delete run.resultPath; run.state = 'running';
  expect((await ciTaskEvent(run, config)).initial?.error).toContain('手动重试');
});

it('rejects arbitrary result paths and does not expose an off-site pipeline URL', async () => {
  const { config, run } = await fixture(); run.resultPath = '/untrusted/file';
  run.pipeline.web_url = 'javascript:alert(1)';
  const event = await ciTaskEvent(run, config);
  expect(event.url).toBe(''); expect(event.initial?.analysis).toBe('旧证据');
});

it('does not attach a valid report belonging to a different failure', async () => {
  const { config, run } = await fixture();
  await writeFile(run.resultPath!, JSON.stringify({ runId: 'b'.repeat(32), replyDraft: 'other draft', analysis: 'other evidence', missingInfo: '' }));
  expect((await ciTaskEvent(run, config)).initial).toMatchObject({ state: 'failed' });
  expect((await ciTaskEvent(run, config)).initial?.analysis).toBeUndefined();
});
