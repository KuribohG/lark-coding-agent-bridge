import type { ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnProcessSync } from '../../../src/platform/spawn';
import { terminateChild } from '../../../src/platform/terminate';

vi.mock('../../../src/platform/spawn', () => ({ spawnProcessSync: vi.fn() }));
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

function child(exitCode: number | null = null) {
  return { pid: 12345, exitCode, signalCode: null, kill: vi.fn(() => true) } as unknown as ChildProcess;
}

describe('child process termination', () => {
  it('kills the Windows tree before the cmd shim can exit', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    vi.mocked(spawnProcessSync).mockReturnValue({ status: 0 } as ReturnType<typeof spawnProcessSync>);
    const proc = child();
    expect(terminateChild(proc)).toBe(true);
    expect(spawnProcessSync).toHaveBeenCalledWith('taskkill.exe', ['/PID', '12345', '/T', '/F'],
      expect.objectContaining({ timeout: 5000, windowsHide: true }));
    expect(proc.kill).not.toHaveBeenCalled();
  });

  it('does not kill a stale PID or claim a failed taskkill succeeded', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    expect(terminateChild(child(0))).toBe(false);
    expect(spawnProcessSync).not.toHaveBeenCalled();
    vi.mocked(spawnProcessSync).mockReturnValue({ status: 1 } as ReturnType<typeof spawnProcessSync>);
    expect(terminateChild(child())).toBe(false);
  });

  it('preserves POSIX signal delivery', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    const proc = child();
    expect(terminateChild(proc, 'SIGTERM')).toBe(true);
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    expect(spawnProcessSync).not.toHaveBeenCalled();
  });
});
