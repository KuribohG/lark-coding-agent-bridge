import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

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

  it('fails with 125 when --require is set and the kernel has no Landlock', () => {
    if (abi !== 0) return; // Only meaningful on kernels without Landlock.
    const result = run(['--ro', '/', '--require'], ['/bin/true']);
    expect(result.status).toBe(125);
  });
});
