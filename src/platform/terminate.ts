import { ChildProcess } from 'node:child_process';
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
    terminate: terminatePosixGroup,
  };
}

/** On Windows child.kill() can terminate only the cmd shim, leaving its agent alive. */
export function terminateChild(child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM'): boolean {
  return getProcessTreeController().terminate(child, signal);
}

/**
 * Agents are spawned detached, as process-group leaders, so their MCP servers
 * and tool processes share the group and go down with them. A child in the
 * bridge's own group leads no group: kill(-pid) fails with ESRCH (a PID is not
 * reused while a group of that ID exists) and only the child is signalled.
 * Run-host proxies are not ChildProcess instances; their pid is the host's.
 */
function terminatePosixGroup(child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM'): boolean {
  if (child instanceof ChildProcess && child.pid && child.exitCode === null && child.signalCode === null) {
    try {
      process.kill(-child.pid, signal);
      return true;
    } catch { /* not a group leader */ }
  }
  return child.kill(signal);
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
