import { fileURLToPath } from 'node:url';
import type { SpawnOptions } from 'node:child_process';
import { spawnProcess } from '../platform/spawn';

export function spawnWithDeadline(command: string, args: string[], options: SpawnOptions, stopAt?: number) {
  // Lead a process group on POSIX so terminateChild also reaches the agent's descendants.
  const detached = process.platform !== 'win32';
  if (stopAt === undefined) return spawnProcess(command, args, { ...options, detached });
  const guarded = deadlineGuardCommand(command, args, stopAt);
  return spawnProcess(guarded.command, guarded.args, { ...options, detached });
}

/** The command line that runs `command` under the independent deadline watchdog. */
export function deadlineGuardCommand(command: string, args: readonly string[], stopAt: number) {
  if (!Number.isSafeInteger(stopAt) || stopAt <= Date.now()) throw new Error('任务停止时间已过。');
  const guard = fileURLToPath(new URL(
    import.meta.url.endsWith('.ts') ? '../../bin/deadline-guard.mjs' : '../bin/deadline-guard.mjs', import.meta.url,
  ));
  return { command: process.execPath, args: [guard, String(stopAt), command, ...args] };
}
