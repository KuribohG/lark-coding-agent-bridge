import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  daemonLogDir,
  daemonStderrPath,
  daemonStdoutPath,
  windowsTaskName,
  windowsLauncherCmdPath,
} from './paths';
import { paths } from '../config/paths';
import { batchArgument, batchLiteral, BATCH_PREAMBLE } from '../platform/windows-cmd';

export interface LauncherInputs {
  /** Absolute path to node.exe. */
  nodePath: string;
  /** Absolute path to the bridge CLI entry. */
  bridgeEntryPath: string;
  /** PATH for the child process; baked into the .cmd via `set PATH=`. */
  envPath: string;
  /** Service id (profile name, or the reserved supervisor id) — drives the
   * task name and log paths. */
  profile: string;
  /** CLI args after the entry path, e.g. `['run', '--profile', 'claude']` or
   * `['run', '--web-ui']`. */
  runArgs: string[];
  /** Root directory for config/profile state. */
  channelHome: string;
}

/**
 * Generate the .cmd wrapper script that the scheduled task actually invokes.
 *
 * schtasks `/TR` can accept a direct command, but we need stdout/stderr
 * redirection + a PATH override so child tools (lark-cli, claude) resolve
 * correctly when the daemon runs under Task Scheduler. A `.cmd` script
 * is the natural place for both.
 *
 * `@echo off` keeps the script's own commands out of the daemon log.
 * `>>` / `2>>` append (not truncate) so log history is preserved across
 * daemon restarts.
 */
export function buildLauncherCmd(inputs: LauncherInputs): string {
  const runArgs = inputs.runArgs.map(batchArgument).join(' ');
  return [
    ...BATCH_PREAMBLE,
    `set "LARK_CHANNEL_HOME=${batchLiteral(inputs.channelHome)}"`,
    `set "PATH=${batchLiteral(inputs.envPath.replace(/"/g, ''))}"`,
    `${batchArgument(inputs.nodePath)} ${batchArgument(inputs.bridgeEntryPath)} ${runArgs} >> ${batchArgument(daemonStdoutPath(inputs.profile))} 2>> ${batchArgument(daemonStderrPath(inputs.profile))}`,
    '',
  ].join('\r\n');
}

async function writeLauncherCmd(profile: string, runArgs: string[] = ['run']): Promise<void> {
  const bridgeEntryPath = process.argv[1];
  if (!bridgeEntryPath) {
    throw new Error('cannot determine bridge entry path (process.argv[1] is empty)');
  }
  const content = buildLauncherCmd({
    nodePath: process.execPath,
    bridgeEntryPath,
    envPath: process.env.PATH ?? '',
    profile,
    runArgs,
    channelHome: paths.rootDir,
  });
  const cmdPath = windowsLauncherCmdPath(profile);
  await mkdir(dirname(cmdPath), { recursive: true });
  await mkdir(daemonLogDir(profile), { recursive: true });
  await writeFile(cmdPath, content, 'utf8');
}

interface SchtasksResult {
  ok: boolean;
  stderr: string;
  stdout: string;
}

function runSchtasks(args: string[]): SchtasksResult {
  const r = spawnSync('schtasks', args, { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
  return {
    ok: r.status === 0,
    stderr: r.error?.message || r.stderr || '',
    stdout: r.stdout ?? '',
  };
}

function runTaskScript(script: string): SchtasksResult {
  const r = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive',
    '-EncodedCommand', Buffer.from(`$ErrorActionPreference = 'Stop'; ${script}`, 'utf16le').toString('base64')],
  { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
  return { ok: r.status === 0, stdout: r.stdout ?? '', stderr: r.error?.message || r.stderr || '' };
}

function taskScriptPrelude(profile: string): string {
  const taskName = windowsTaskName(profile).replace(/'/g, "''");
  return `$service = New-Object -ComObject 'Schedule.Service'; $service.Connect(); $folder = $service.GetFolder('\\'); $name = '${taskName}'; `;
}

/**
 * Create (or overwrite) the scheduled task. Trigger: ONLOGON.
 * `/RL LIMITED` runs as the current user without admin elevation.
 * `/F` overwrites if the task already exists.
 *
 * The /TR value is the .cmd wrapper path. Schtasks treats /TR as a command
 * line, so wrapping in quotes keeps spaces in the path intact.
 */
export async function installTask(
  profile: string,
  runArgs: string[] = ['run'],
): Promise<SchtasksResult> {
  await writeLauncherCmd(profile, runArgs);
  const created = runSchtasks([
    '/Create',
    '/F',
    '/SC',
    'ONLOGON',
    '/RL',
    'LIMITED',
    '/TN',
    windowsTaskName(profile),
    '/TR',
    `"${windowsLauncherCmdPath(profile)}"`,
  ]);
  if (!created.ok) return created;
  // Task Scheduler defaults stop a task after 72 hours and when switching
  // to battery power. Persist daemon settings before the caller starts it.
  return runTaskScript(taskScriptPrelude(profile) +
    `$task = $folder.GetTask($name).Definition; ` +
    `$task.Settings.ExecutionTimeLimit = 'PT0S'; ` +
    `$task.Settings.DisallowStartIfOnBatteries = $false; ` +
    `$task.Settings.StopIfGoingOnBatteries = $false; ` +
    `$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; ` +
    `$null = $folder.RegisterTaskDefinition($name, $task, 6, $user, $null, 3, $null)`);
}

/** Start the task now (regardless of trigger). */
export function runTask(profile: string): SchtasksResult {
  return runSchtasks(['/Run', '/TN', windowsTaskName(profile)]);
}

/** End the running instance. Task stays registered for next logon. */
export function endTask(profile: string): SchtasksResult {
  return runSchtasks(['/End', '/TN', windowsTaskName(profile)]);
}

/** Disable autostart (task stays registered but ONLOGON trigger won't fire). */
export function disableTask(profile: string): SchtasksResult {
  return runSchtasks(['/Change', '/TN', windowsTaskName(profile), '/Disable']);
}

/** Re-enable autostart. Called from installTask is unnecessary — /Create /F
 * resets the enabled flag. Only needed if you Disabled and want it back. */
export function enableTask(profile: string): SchtasksResult {
  return runSchtasks(['/Change', '/TN', windowsTaskName(profile), '/Enable']);
}

/** End + disable. The cross-platform "stop = stay stopped" semantic. */
export function endAndDisable(profile: string): SchtasksResult {
  const ended = endTask(profile);
  // If the task wasn't running, /End fails; we still want to disable.
  const disabled = disableTask(profile);
  // Surface whichever signal is more informative — disable result wins
  // because the autostart prevention is the user-visible effect.
  return disabled.ok ? disabled : ended.ok ? disabled : ended;
}

/** Schtasks has no native restart — end, wait, run. */
export async function restartTask(profile: string): Promise<SchtasksResult> {
  endTask(profile); // best-effort; ignore if not running
  if (!await waitUntilStopped(profile)) {
    return { ok: false, stderr: 'scheduled task did not stop before restart', stdout: '' };
  }
  return runTask(profile);
}

/**
 * `schtasks /Query` returns 0 iff the task is registered. We toss the
 * output (it's verbose); use describeTask for full state.
 */
export function isTaskRegistered(profile: string): boolean {
  const r = spawnSync('schtasks', ['/Query', '/TN', windowsTaskName(profile)], {
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  return r.status === 0;
}

/**
 * Read TASK_STATE through COM; schtasks display output is localized.
 * Queued tasks also count as active so a restart waits for them to stop.
 */
export function isTaskRunning(profile: string): boolean {
  const r = runTaskScript(taskScriptPrelude(profile) +
    `try { [int]$folder.GetTask($name).State } catch { ` +
    `$cause = $_.Exception; while ($cause.InnerException) { $cause = $cause.InnerException }; ` +
    `if ($cause.HResult -eq -2147024894) { 'missing' } else { throw } }`);
  const state = r.stdout?.trim();
  if (r.ok && state === 'missing') return false;
  if (!r.ok || !/^[0-4]$/.test(state ?? '') || state === '0') {
    throw new Error(`cannot query scheduled task state: ${r.stderr.trim() || state || 'unknown'}`);
  }
  return state === '2' || state === '4';
}

export function describeTask(profile: string): string {
  const r = runSchtasks(['/Query', '/V', '/FO', 'LIST', '/TN', windowsTaskName(profile)]);
  return r.stdout || r.stderr || '';
}

export async function waitUntilStopped(profile: string, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isTaskRunning(profile)) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

export async function deleteTask(profile: string): Promise<SchtasksResult> {
  const r = runSchtasks(['/Delete', '/F', '/TN', windowsTaskName(profile)]);
  // Remove the launcher script too; best-effort.
  if (r.ok && existsSync(windowsLauncherCmdPath(profile))) {
    await rm(windowsLauncherCmdPath(profile), { force: true });
  }
  return r;
}
