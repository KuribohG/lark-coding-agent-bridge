import { appendFile, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runLogs, tailLines } from '../../../src/cli/commands/logs.js';
import { paths } from '../../../src/config/paths.js';
import { daemonLogDir, daemonStderrPath, daemonStdoutPath } from '../../../src/daemon/paths.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()));
});

describe('native service logs', () => {
  it('tails the requested number of lines without platform shell commands', () => {
    expect(tailLines('one\r\ntwo\nthree\n', 2)).toBe('two\nthree');
  });

  it('prints stdout and stderr tails for a profile', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bridge-logs-'));
    const previousRoot = paths.rootDir;
    paths.rootDir = root;
    cleanups.push(async () => {
      paths.rootDir = previousRoot;
      await rm(root, { recursive: true, force: true });
    });
    await mkdir(daemonLogDir('work'), { recursive: true });
    await writeFile(daemonStdoutPath('work'), 'old\nstdout-new\n');
    await writeFile(daemonStderrPath('work'), 'old\nerr-new\n');
    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => output.push(line));

    await runLogs({ profile: 'work', lines: 1 });

    const text = output.join('\n');
    expect(text).toContain('stdout-new');
    expect(text).toContain('err-new');
    expect(text).not.toContain('tail -f');
    expect(text).not.toContain('Get-Content');
  });

  it('follows append-only logs without a platform shell command', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bridge-logs-follow-'));
    const previousRoot = paths.rootDir;
    paths.rootDir = root;
    cleanups.push(async () => {
      paths.rootDir = previousRoot;
      await rm(root, { recursive: true, force: true });
    });
    await mkdir(daemonLogDir('work'), { recursive: true });
    await writeFile(daemonStdoutPath('work'), 'initial\n');
    await writeFile(daemonStderrPath('work'), '');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const writes: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });

    const following = runLogs({ profile: 'work', follow: true, lines: 1 });
    try {
      await vi.waitFor(() => expect(console.log).toHaveBeenCalled());
      await appendFile(daemonStdoutPath('work'), 'appended\n');
      await vi.waitFor(() => expect(writes).toContain('appended\n'), { timeout: 2_000 });
    } finally {
      process.emit('SIGINT');
      await following;
    }
  });
});
