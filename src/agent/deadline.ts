import { fileURLToPath } from 'node:url';
import type { SpawnOptions } from 'node:child_process';
import { buildExecSandboxCommand, type ExecSandboxSettings } from '../platform/exec-sandbox';
import { spawnProcess } from '../platform/spawn';

export interface ExecSandboxSpawnOptions {
  settings?: ExecSandboxSettings | undefined;
  /** Backend id, used to pick the harness state directory that stays writable. */
  agent?: string | undefined;
}

export function spawnWithDeadline(
  command: string,
  args: string[],
  options: SpawnOptions,
  stopAt?: number,
  execSandbox?: ExecSandboxSpawnOptions,
) {
  // Lead a process group on POSIX so terminateChild also reaches the agent's descendants.
  const detached = process.platform !== 'win32';
  // The sandbox wraps the command before the watchdog does, so the watchdog and
  // the agent it guards share one Landlock domain.
  const target = buildExecSandboxCommand(command, args, {
    settings: execSandbox?.settings,
    agent: execSandbox?.agent,
    cwd: typeof options.cwd === 'string' ? options.cwd : undefined,
    env: options.env ?? process.env,
  });
  if (stopAt === undefined) return spawnProcess(target.command, target.args, { ...options, detached });
  const guarded = deadlineGuardCommand(target.command, target.args, stopAt);
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
