import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildRelease, builtRelease, pruneReleases, resolveGitCommit } from '../../src/deploy/release';
import type { DeploySpec } from '../../src/deploy/spec';

describe.skipIf(process.platform === 'win32')('git releases', () => {
  let root: string;
  let repo: string;
  let spec: DeploySpec;

  const git = (...args: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args],
    { encoding: 'utf8' }).trim();

  async function commit(version: string): Promise<string> {
    await writeFile(join(repo, 'package.json'), JSON.stringify({ name: 'lark-channel-bridge', version, private: true }));
    git('add', '-A');
    git('commit', '-q', '-m', version);
    return git('rev-parse', 'HEAD');
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'deploy-release-'));
    repo = join(root, 'repo');
    await mkdir(join(repo, 'bin'), { recursive: true });
    await mkdir(join(repo, 'dist'), { recursive: true });
    await writeFile(join(repo, 'bin', 'lark-channel-bridge.mjs'), '');
    await writeFile(join(repo, 'dist', 'cli.js'), '');
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    spec = { configPath: join(root, 'config.toml'), source: { kind: 'git', url: repo, ref: 'main' }, profiles: ['a'],
      node: process.execPath, cwd: root, root: join(root, 'deploy'), keep: 1, env: {}, readyTimeoutMs: 10_000 };
  });

  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it('builds each commit once from a mirror and prunes old releases', async () => {
    const say: string[] = [];
    const first = await commit('1.0.0');
    expect(await resolveGitCommit(spec, line => say.push(line))).toBe(first);
    expect(builtRelease(spec.root, first)).toBeUndefined();
    const release = await buildRelease(spec, first, line => say.push(line));
    expect(release).toEqual({ dir: join(spec.root, 'releases', first.slice(0, 12)), label: first.slice(0, 12), commit: first, version: '1.0.0' });
    expect(JSON.parse(readFileSync(join(release.dir, 'release-info.json'), 'utf8'))).toMatchObject({ commit: first, ref: 'main' });
    expect(say.filter(line => line.startsWith('构建'))).toHaveLength(1);
    expect(await buildRelease(spec, first, line => say.push(line))).toEqual(release);
    expect(say.filter(line => line.startsWith('构建'))).toHaveLength(1);

    const second = await commit('2.0.0');
    expect(await resolveGitCommit(spec, () => {})).toBe(second);
    const next = await buildRelease(spec, second, () => {});
    expect(next.version).toBe('2.0.0');
    expect(await pruneReleases(spec.root, 1, [next.dir])).toEqual([release.dir]);
    expect(existsSync(release.dir)).toBe(false);
    expect(existsSync(next.dir)).toBe(true);
  }, 120_000);

  it('leaves no partial release when the build fails', async () => {
    const first = await commit('1.0.0');
    await rm(join(repo, 'dist', 'cli.js'));
    git('commit', '-q', '-am', 'drop cli');
    const broken = git('rev-parse', 'HEAD');
    await resolveGitCommit(spec, () => {});
    await expect(buildRelease(spec, broken, () => {})).rejects.toThrow(/dist\/cli.js/);
    expect(builtRelease(spec.root, broken)).toBeUndefined();
    expect(existsSync(join(spec.root, 'releases', broken.slice(0, 12)))).toBe(false);
    expect((await buildRelease(spec, first, () => {})).commit).toBe(first);
  }, 120_000);
});
