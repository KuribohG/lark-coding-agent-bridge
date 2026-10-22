import type { ChildProcess } from 'node:child_process';
import { spawnProcessSync } from './spawn';

export type ProcessTreeStrategy = 'posix-signals' | 'windows-taskkill';

export interface ProcessTreeController {
  readonly strategy: ProcessTreeStrategy;
  /** False until a native Job Object implementation can survive bridge death. */
  readonly ownsDescendantsAfterBridgeExit: boolean;
  terminate(child: ChildProcess, signal?: NodeJS.Signals): boolean;
}

export function getProcessTreeController(
  platform: NodeJS.Platform = process.platform,
): ProcessTreeController {
  if (platform === 'win32') {
    return {
      strategy: 'windows-taskkill',
      ownsDescendantsAfterBridgeExit: false,
      terminate: terminateWindowsTree,
    };
  }
  return {
    strategy: 'posix-signals',
    ownsDescendantsAfterBridgeExit: false,
    terminate: (child, signal = 'SIGTERM') => child.kill(signal),
  };
}

/** On Windows child.kill() can terminate only the cmd shim, leaving its agent alive. */
export function terminateChild(child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM'): boolean {
  return getProcessTreeController().terminate(child, signal);
}

function terminateWindowsTree(child: ChildProcess): boolean {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return false;
  // Windows has no POSIX graceful signal here. Kill the tree before its root
  // exits, while taskkill can still discover descendants by their parent PID.
  const result = spawnProcessSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
    stdio: 'ignore', windowsHide: true, timeout: 5000,
  });
  return result.status === 0;
}
