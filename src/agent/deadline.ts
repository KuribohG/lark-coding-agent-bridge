import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { SpawnOptions } from 'node:child_process';
import { buildExecSandboxCommand, type ExecSandboxSettings } from '../platform/exec-sandbox';
import { buildSignalCellCommand, type SignalCell } from '../platform/signal-cell';
import { spawnProcess } from '../platform/spawn';

// A self-contained host bundle carries its own guard in bin/ beside it; source
// runs and the package build use the repository's bin/.
function guardPath() {
  if (import.meta.url.endsWith('.ts')) return fileURLToPath(new URL('../../bin/deadline-guard.mjs', import.meta.url));
  const bundled = fileURLToPath(new URL('./bin/deadline-guard.mjs', import.meta.url));
  return existsSync(bundled) ? bundled : fileURLToPath(new URL('../bin/deadline-guard.mjs', import.meta.url));
}

/** What an agent process and everything it starts is held to by the kernel. */
export interface RunConfinement {
  /** Landlock write allowlist; see platform/exec-sandbox. */
  execSandbox?: ExecSandboxSettings | undefined;
  /** Backend id, used to pick the harness state directory that stays writable. */
  agent?: string | undefined;
  /** The run's signals stay among the runs of this cell; see platform/signal-cell. */
  signalCell?: SignalCell | undefined;
}

/**
 * The command line that starts an agent, from the inside out: the agent in its write sandbox, the watchdog that ends
 * it at `deadlineAt`, and the signal cell. The cell is outermost so that the watchdog's kills are the cell's own and
 * a detached job the run leaves behind is adopted by the cell instead of by the watchdog's cleanup.
 */
export function agentLaunchCommand(command: string, args: readonly string[], input: {
  cwd?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  deadlineAt?: number | undefined;
  confinement?: RunConfinement | undefined;
}): { command: string; args: string[] } {
  const sandboxed = buildExecSandboxCommand(command, args, {
    settings: input.confinement?.execSandbox,
    agent: input.confinement?.agent,
    cwd: input.cwd,
    env: input.env ?? process.env,
  });
  const guarded = input.deadlineAt === undefined ? sandboxed : deadlineGuardCommand(sandboxed.command, sandboxed.args, input.deadlineAt);
  return buildSignalCellCommand(guarded.command, guarded.args, { cell: input.confinement?.signalCell });
}

export function spawnWithDeadline(
  command: string,
  args: string[],
  options: SpawnOptions,
  stopAt?: number,
  confinement?: RunConfinement,
) {
  // Lead a process group on POSIX so terminateChild also reaches the agent's descendants.
  const detached = process.platform !== 'win32';
  const target = agentLaunchCommand(command, args, {
    cwd: typeof options.cwd === 'string' ? options.cwd : undefined,
    env: options.env,
    deadlineAt: stopAt,
    confinement,
  });
  return spawnProcess(target.command, target.args, { ...options, detached });
}

/** The command line that runs `command` under the independent deadline watchdog. */
function deadlineGuardCommand(command: string, args: readonly string[], stopAt: number) {
  if (!Number.isSafeInteger(stopAt) || stopAt <= Date.now()) throw new Error('任务停止时间已过。');
  return { command: process.execPath, args: [guardPath(), String(stopAt), command, ...args] };
}
