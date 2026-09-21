import { fileURLToPath } from 'node:url';
import type { SpawnOptions } from 'node:child_process';
import { spawnProcess } from '../platform/spawn';

export function spawnWithDeadline(command: string, args: string[], options: SpawnOptions, stopAt?: number) {
  if (stopAt === undefined) return spawnProcess(command, args, options);
  if (!Number.isSafeInteger(stopAt) || stopAt <= Date.now()) throw new Error('任务停止时间已过。');
  const guard = fileURLToPath(new URL(
    import.meta.url.endsWith('.ts') ? '../../bin/deadline-guard.mjs' : '../bin/deadline-guard.mjs', import.meta.url,
  ));
  return spawnProcess(process.execPath, [guard, String(stopAt), command, ...args], {
    ...options, detached: process.platform !== 'win32',
  });
}
