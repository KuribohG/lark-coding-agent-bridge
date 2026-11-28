import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildExecSandboxCommand } from '../../src/platform/exec-sandbox';
import { gitWritePaths } from '../../src/workflows/bridge/runtime';

const launcher = fileURLToPath(new URL('../../bin/landlock-exec', import.meta.url));
const buildScript = fileURLToPath(new URL('../../native/build.mjs', import.meta.url));

/** Build on demand so `pnpm test` works on a fresh clone. */
function landlockAbi(): number {
  if (process.platform !== 'linux') return -1;
  if (!existsSync(launcher)) {
    try {
      execFileSync(process.execPath, [buildScript], { stdio: 'ignore' });
    } catch {
      return -1;
    }
  }
  if (!existsSync(launcher)) return -1;
  const result = spawnSync(launcher, ['--print-abi'], { encoding: 'utf8' });
  return result.status === 0 ? Number.parseInt(result.stdout.trim(), 10) : -1;
}

const abi = landlockAbi();

function run(rules: string[], command: string[]): ReturnType<typeof spawnSync> {
  return spawnSync(launcher, [...rules, '--', ...command], { encoding: 'utf8' });
}

describe.skipIf(process.platform !== 'linux')('landlock-exec', () => {
  it('reports the kernel Landlock ABI', () => {
    expect(abi).toBeGreaterThanOrEqual(0);
  });

  it.skipIf(abi < 1)('allows writes under --rw and denies them elsewhere', () => {
    const writable = mkdtempSync(join(tmpdir(), 'll-rw-'));
    const denied = mkdtempSync(join(tmpdir(), 'll-deny-'));
    try {
      const allowed = run(['--ro', '/', '--rw', writable, '--rw', '/dev'],
        ['/bin/sh', '-c', `printf ok > ${writable}/file && cat ${writable}/file`]);
      expect(allowed.status).toBe(0);
      expect(readFileSync(join(writable, 'file'), 'utf8')).toBe('ok');

      const blocked = run(['--ro', '/', '--rw', writable, '--rw', '/dev'],
        ['/bin/sh', '-c', `printf no > ${denied}/file`]);
      expect(blocked.status).not.toBe(0);
      expect(existsSync(join(denied, 'file'))).toBe(false);
    } finally {
      rmSync(writable, { recursive: true, force: true });
      rmSync(denied, { recursive: true, force: true });
    }
  });

  it.skipIf(abi < 1)('denies TCP only when --no-tcp is set', () => {
    const script = [
      'import socket',
      's = socket.socket(); s.settimeout(1)',
      'try:',
      '    s.connect(("127.0.0.1", 1))',
      '    print("connected")',
      'except OSError as error:',
      '    print(type(error).__name__)',
    ].join('\n');
    const python = ['/usr/bin/env', 'python3', '-I', '-c', script];
    expect(run(['--ro', '/', '--rw', '/dev', '--no-tcp'], python).stdout).toContain('PermissionError');
    expect(run(['--ro', '/', '--rw', '/dev'], python).stdout).toContain('ConnectionRefusedError');
  });

  it.skipIf(abi < 1)('passes argv, env and the exit status through', () => {
    const result = spawnSync(launcher, ['--ro', '/', '--rw', '/dev', '--', '/bin/sh', '-c', 'exit 7'], {
      encoding: 'utf8',
      env: { ...process.env, LL_PASSTHROUGH: 'yes' },
    });
    expect(result.status).toBe(7);

    expect(run(['--ro', '/', '--rw', '/dev'], ['/bin/echo', 'a', 'b']).stdout).toBe('a b\n');
    const envRun = spawnSync(launcher, ['--ro', '/', '--rw', '/dev', '--', '/bin/sh', '-c', 'printf "%s" "$LL_PASSTHROUGH"'], {
      encoding: 'utf8',
      env: { ...process.env, LL_PASSTHROUGH: 'yes' },
    });
    expect(envRun.stdout).toBe('yes');
  });

  it.skipIf(abi < 1)('skips rules for paths that do not exist', () => {
    const result = run(['--ro', '/', '--ro', '/nonexistent-rule', '--rw', '/dev'], ['/bin/true']);
    expect(result.status).toBe(0);
  });

  it.skipIf(abi < 1)('lets a confined workflow worker commit in its linked worktree, and write nowhere else of the repository', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'll-git-'));
    try {
      const repo = join(dir, 'repo'), tree = join(dir, 'tree'), other = join(dir, 'other'), scratch = join(dir, 'scratch');
      const identity = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@localhost', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@localhost' };
      const git = (cwd: string, ...argv: string[]) => execFileSync('git', argv, { cwd, encoding: 'utf8', env: { ...process.env, ...identity } }).trim();
      mkdirSync(repo); mkdirSync(scratch);
      git(repo, 'init', '-b', 'main'); writeFileSync(join(repo, 'file'), 'base\n'); git(repo, 'add', '.'); git(repo, 'commit', '-m', 'base');
      git(repo, 'worktree', 'add', '--detach', tree); git(repo, 'worktree', 'add', '--detach', other);
      // What the bridge gives a worker that is not a lead: its worktree, its scratch directory, and what a commit writes.
      const settings = { enabled: true, requireLandlock: true, allowTcp: true, readWrite: await gitWritePaths(tree), readOnly: [] };
      const env = { ...process.env, ...identity, TMPDIR: scratch };
      const inside = (script: string) => {
        const wrapped = buildExecSandboxCommand('/bin/sh', ['-c', script], { settings, cwd: tree, env, home: join(dir, 'home'), launcher });
        expect(wrapped.sandboxed).toBe(true);
        return spawnSync(wrapped.command, wrapped.args, { cwd: tree, env, encoding: 'utf8' });
      };
      expect(inside('echo changed > file && git commit -q -am change && mkdir build && echo o > "$TMPDIR/note"').status).toBe(0);
      expect(git(tree, 'log', '--format=%s', '-1')).toBe('change');
      // The shared config, the refs, the main checkout and another member's worktree stay as they are.
      for (const script of ['git config core.bare true', 'git switch -q -c topic', `echo x > ${repo}/file`, `echo x > ${other}/file`,
        `git -C ${other} commit -q --allow-empty -m theirs`, `echo x > ${dir}/elsewhere`]) {
        expect(inside(script).status, script).not.toBe(0);
      }
      expect(git(repo, 'config', '--get', 'core.bare')).toBe('false');
      expect(readFileSync(join(other, 'file'), 'utf8')).toBe('base\n');
      expect(git(other, 'log', '--format=%s', '-1')).toBe('base');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails with 125 when --require is set and the kernel has no Landlock', () => {
    if (abi !== 0) return; // Only meaningful on kernels without Landlock.
    const result = run(['--ro', '/', '--require'], ['/bin/true']);
    expect(result.status).toBe(125);
  });
});
