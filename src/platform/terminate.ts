import type { ChildProcess } from 'node:child_process';
import { spawnProcessSync } from './spawn';

/** On Windows child.kill() can terminate only the cmd shim, leaving its agent alive. */
export function terminateChild(child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM'): boolean {
  if (process.platform !== 'win32') return child.kill(signal);
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return false;
  // Windows has no POSIX graceful signal here. Kill the tree before its root
  // exits, while taskkill can still discover descendants by their parent PID.
  const result = spawnProcessSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
    stdio: 'ignore', windowsHide: true, timeout: 5000,
  });
  return result.status === 0;
}
