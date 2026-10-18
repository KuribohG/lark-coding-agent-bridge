import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { GitLabClient, loadGitLabToken, parseCredentials } from '../../../src/monitoring/sources/gitlab-ci/client';
import { normalizeGitLabCi } from '../../../src/monitoring/sources/gitlab-ci/config';

const signal = new AbortController().signal;
it('paginates pipelines and keeps the exact time window and encoded project', async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('[{"id":1}]', { headers: { 'x-next-page': '2' } }))
    .mockResolvedValueOnce(new Response('[{"id":2}]', { headers: { 'x-next-page': '' } }));
  const client = new GitLabClient('https://gitlab.test', 'fixture-token', request);
  expect(await client.pipelines('a/b', 1000, 2000, signal)).toEqual([{ id: 1 }, { id: 2 }]);
  const url = new URL(request.mock.calls[1]![0] as string);
  expect(url.pathname).toBe('/api/v4/projects/a%2Fb/pipelines');
  expect(url.searchParams.get('updated_after')).toBe('1970-01-01T00:00:01.000Z');
  expect(url.searchParams.get('page')).toBe('2');
  expect(request.mock.calls[0]![1]).toMatchObject({ redirect: 'error', headers: { 'PRIVATE-TOKEN': 'fixture-token' } });
});

it('includes failed downstream bridges but excludes allowed failures and manual jobs', async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify([
    { id: 1, status: 'failed', allow_failure: false }, { id: 2, status: 'failed', allow_failure: true },
  ]))).mockResolvedValueOnce(new Response(JSON.stringify([
    { id: 3, status: 'failed', allow_failure: false, downstream_pipeline: { id: 4 } }, { id: 5, status: 'manual' },
  ])));
  const result = await new GitLabClient('https://gitlab.test', 'secret', request).failures('a/b', 10, signal);
  expect(result).toMatchObject([{ id: 1, kind: 'job' }, { id: 3, kind: 'bridge' }]);
});

it('redacts transport errors and exposes only HTTP status', async () => {
  const request = vi.fn<typeof fetch>().mockRejectedValueOnce(Error('secret token'))
    .mockResolvedValueOnce(new Response('secret response', { status: 401 }));
  const client = new GitLabClient('https://gitlab.test', 'secret', request);
  await expect(client.pipeline('a/b', 1, signal)).rejects.toThrow('request failed');
  await expect(client.pipeline('a/b', 1, signal)).rejects.toThrow('HTTP 401');
});

it('caps archived traces and marks truncation explicitly', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'ci-trace-'));
  const request = vi.fn<typeof fetch>().mockResolvedValue(new Response('1234567890'));
  const trace = await new GitLabClient('https://gitlab.test', 'secret', request).trace('a/b', 2, join(folder, 'job.log'), signal, 5);
  expect(trace).toMatchObject({ bytes: 5, truncated: true, tail: '12345' });
  expect(await readFile(trace.path, 'utf8')).toBe('12345');
});

it('loads literal env credentials without executing shell expansions and refuses a different server', async () => {
  expect(parseCredentials("export GITLAB_TOKEN='fixture'\nGITLAB_URL=https://gitlab.test # comment")).toEqual({ GITLAB_TOKEN: 'fixture', GITLAB_URL: 'https://gitlab.test' });
  expect(() => parseCredentials('GITLAB_TOKEN=$(command)')).toThrow('literal');
  const dir = await mkdtemp(join(tmpdir(), 'ci-credentials-'));
  const file = join(dir, 'credentials'); await writeFile(file, 'GITLAB_TOKEN=fixture\nGITLAB_URL=https://gitlab.test');
  const c = normalizeGitLabCi({ url: 'https://gitlab.test', credentialsFile: file });
  expect(await loadGitLabToken(c, {})).toBe('fixture');
  await expect(loadGitLabToken({ ...c, url: 'https://wrong.test' }, {})).rejects.toThrow('does not match');
});
