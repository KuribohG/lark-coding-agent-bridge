import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { SpawnOptions } from 'node:child_process';
import { spawnProcess } from '../platform/spawn';

// A self-contained host bundle carries its own guard in bin/ beside it; source
// runs and the package build use the repository's bin/.
function guardPath() {
  if (import.meta.url.endsWith('.ts')) return fileURLToPath(new URL('../../bin/deadline-guard.mjs', import.meta.url));
  const bundled = fileURLToPath(new URL('./bin/deadline-guard.mjs', import.meta.url));
  return existsSync(bundled) ? bundled : fileURLToPath(new URL('../bin/deadline-guard.mjs', import.meta.url));
}

export function spawnWithDeadline(command: string, args: string[], options: SpawnOptions, stopAt?: number) {
  if (stopAt === undefined) return spawnProcess(command, args, options);
  if (!Number.isSafeInteger(stopAt) || stopAt <= Date.now()) throw new Error('任务停止时间已过。');
  return spawnProcess(process.execPath, [guardPath(), String(stopAt), command, ...args], {
    ...options, detached: process.platform !== 'win32',
  });
}
