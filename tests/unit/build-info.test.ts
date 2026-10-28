import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  detectReleasePath,
  formatBuildVersion,
  getBuildInfo,
} from '../../src/build-info';

const dirs: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('build information', () => {
  it('uses build metadata from the active release', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bridge-build-info-'));
    dirs.push(root);
    const release = join(root, 'releases', 'abcdef123456');
    const entrypoint = join(release, 'bin', 'lark-channel-bridge.mjs');
    await mkdir(join(release, 'bin'), { recursive: true });
    await writeFile(entrypoint, '');
    await writeFile(join(release, 'release-info.json'), JSON.stringify({
      commit: 'abcdef1234567890',
      createdAt: '2026-10-28T08:00:00.000Z',
    }));

    const info = getBuildInfo(entrypoint);

    expect(info).toMatchObject({
      version: '0.7.1',
      commit: 'abcdef1234567890',
      builtAt: '2026-10-28T08:00:00.000Z',
      entrypoint: await realpath(entrypoint),
      release,
      releaseId: 'abcdef123456',
      nodeVersion: process.version,
    });
    expect(detectReleasePath(await realpath(entrypoint))).toBe(release);
    expect(formatBuildVersion(info)).toBe('0.7.1 (abcdef123456)');
  });

  it('gives build-time environment metadata precedence over release metadata', async () => {
    vi.stubEnv('LARK_BUILD_COMMIT', 'fedcba9876543210');
    vi.stubEnv('LARK_BUILD_TIME', '2026-10-28T09:00:00.000Z');
    vi.stubEnv('LARK_BUILD_DIRTY', 'true');
    const info = getBuildInfo('/path/outside/a/release.js');

    expect(info.commit).toBe('fedcba9876543210');
    expect(info.builtAt).toBe('2026-10-28T09:00:00.000Z');
    expect(info.dirty).toBe(true);
    expect(formatBuildVersion(info)).toBe('0.7.1 (fedcba987654-dirty)');
    expect(info.release).toBeUndefined();
  });
});
