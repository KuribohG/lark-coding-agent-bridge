import { readFileSync, readlinkSync } from 'node:fs';
import { mkdir, open, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { resolveAppPaths } from '../config/app-paths';
import { checkRuntimeLock } from '../runtime/locks';
import { spawnProcess } from '../platform/spawn';

/** Enough to restart a process the way it was started. */
export interface LaunchCommand {
  argv: string[];
  cwd: string;
  env?: Record<string, string>;
}

export interface RunningBridge {
  pid: number;
  /** Start time on Linux, so a reused PID is never mistaken for the bridge. */
  identity: string;
  profiles: string[];
  launch?: LaunchCommand;
}

export function processIdentity(pid: number): string | undefined {
  if (process.platform === 'linux') {
    try {
      const fields = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ').at(-1)!.split(' ');
      return fields[0] === 'Z' ? undefined : fields[19];
    } catch { return undefined; }
  }
  try { process.kill(pid, 0); return 'alive'; } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM' ? 'alive' : undefined;
  }
}

/** How a running process was started; Linux only. */
export function readLaunch(pid: number): LaunchCommand | undefined {
  if (process.platform !== 'linux') return undefined;
  try {
    const split = (file: string) => readFileSync(`/proc/${pid}/${file}`).toString('utf8').split('\0').filter(Boolean);
    const env: Record<string, string> = {};
    for (const item of split('environ')) {
      const at = item.indexOf('=');
      if (at > 0) env[item.slice(0, at)] = item.slice(at + 1);
    }
    return { argv: split('cmdline'), cwd: readlinkSync(`/proc/${pid}/cwd`), env };
  } catch { return undefined; }
}

/** Bridges holding the profile runtime locks of `profiles`, grouped by process. */
export async function findRunningBridges(configPath: string, profiles: readonly string[]): Promise<RunningBridge[]> {
  const rootDir = dirname(configPath);
  const byPid = new Map<number, RunningBridge>();
  for (const profile of profiles) {
    const lock = await checkRuntimeLock(resolveAppPaths({ rootDir, profile }).profileLockFile);
    const pid = lock.meta?.pid;
    if (!lock.locked || !pid) continue;
    const identity = processIdentity(pid);
    if (!identity) continue;
    const found = byPid.get(pid) ?? { pid, identity, profiles: [], ...(readLaunch(pid) ? { launch: readLaunch(pid)! } : {}) };
    found.profiles.push(profile);
    byPid.set(pid, found);
  }
  return [...byPid.values()];
}

/** SIGTERM, then wait for a graceful exit; false when the process outlives the timeout. */
export async function stopBridge(bridge: Pick<RunningBridge, 'pid' | 'identity'>, timeoutMs: number): Promise<boolean> {
  if (processIdentity(bridge.pid) !== bridge.identity) return true;
  try { process.kill(bridge.pid, 'SIGTERM'); } catch { return processIdentity(bridge.pid) !== bridge.identity; }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (processIdentity(bridge.pid) !== bridge.identity) return true;
    await delay(250);
  }
  return processIdentity(bridge.pid) !== bridge.identity;
}

/** Starts a bridge in its own session, logging to `log`; it outlives the caller. */
export async function startBridge(launch: LaunchCommand, log: string): Promise<{ pid: number; identity: string }> {
  await mkdir(dirname(log), { recursive: true, mode: 0o700 });
  const file = await open(log, 'a', 0o600);
  try {
    const [command, ...args] = launch.argv;
    const child = spawnProcess(command!, args, {
      cwd: launch.cwd, env: launch.env, detached: true, stdio: ['ignore', file.fd, file.fd],
    });
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    child.unref();
    const pid = child.pid!;
    return { pid, identity: processIdentity(pid) ?? 'alive' };
  } finally {
    await file.close();
  }
}

/**
 * Every profile announced itself online in the log, and the process stayed up
 * for `stableMs` afterwards.
 */
export async function waitForBridge(bridge: { pid: number; identity: string }, log: string, profiles: readonly string[],
  options: { timeoutMs: number; stableMs: number }): Promise<'ready' | 'exited' | 'timeout'> {
  const markers = profiles.map(profile => `profile「${profile}」已上线`);
  const deadline = Date.now() + options.timeoutMs;
  let onlineAt: number | undefined;
  while (Date.now() < deadline) {
    if (processIdentity(bridge.pid) !== bridge.identity) return 'exited';
    const text = await readFile(log, 'utf8').catch(() => '');
    if (markers.every(marker => text.includes(marker))) {
      onlineAt ??= Date.now();
      if (Date.now() - onlineAt >= options.stableMs) return 'ready';
    }
    await delay(500);
  }
  return 'timeout';
}
