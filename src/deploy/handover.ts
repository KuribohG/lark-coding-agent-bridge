import { readFileSync } from 'node:fs';
import { mkdir, rm, symlink, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import * as lockfile from 'proper-lockfile';
import { writeFileAtomic } from '../platform/atomic-write';
import { processIdentity, startBridge, stopBridge, waitForBridge, type LaunchCommand, type RunningBridge } from './process';
import { pruneReleases, type Release } from './release';
import { readState, writeState, type Instance } from './state';

/**
 * Everything the detached handover needs. It holds the bridge environment
 * (credentials included), so it lives in a private directory and is deleted
 * once the handover ends.
 */
export interface HandoverPlan {
  root: string;
  dir: string;
  target: { release: Release; profiles: string[]; fingerprint: string; launch: LaunchCommand };
  /** Running bridges to replace; restarted from their own command lines if the target fails. */
  stop: RunningBridge[];
  keep: number;
  stopTimeoutMs: number;
  readyTimeoutMs: number;
  stableMs: number;
}

export type HandoverPhase = 'stopping' | 'starting' | 'complete' | 'rolled-back' | 'failed';

export interface HandoverStatus {
  phase: HandoverPhase;
  message: string;
  pid?: number;
  log?: string;
  updatedAt: string;
}

export const TERMINAL_PHASES: ReadonlySet<HandoverPhase> = new Set(['complete', 'rolled-back', 'failed']);

export async function writePlan(plan: HandoverPlan): Promise<string> {
  await mkdir(plan.dir, { recursive: true, mode: 0o700 });
  const path = join(plan.dir, 'plan.json');
  await writeFileAtomic(path, JSON.stringify(plan), { mode: 0o600 });
  return path;
}

export function readStatus(dir: string): HandoverStatus | undefined {
  try { return JSON.parse(readFileSync(join(dir, 'status.json'), 'utf8')) as HandoverStatus; } catch { return undefined; }
}

/**
 * Replaces the running bridges with the target. Runs detached from `up`: the
 * process that asked for the deployment may itself be a run of the bridge
 * being stopped.
 */
export async function runHandover(planPath: string): Promise<HandoverStatus> {
  const plan = JSON.parse(readFileSync(planPath, 'utf8')) as HandoverPlan;
  const report = async (phase: HandoverPhase, message: string, extra: Partial<HandoverStatus> = {}) => {
    const status: HandoverStatus = { phase, message, ...extra, updatedAt: new Date().toISOString() };
    await writeFileAtomic(join(plan.dir, 'status.json'), `${JSON.stringify(status, null, 2)}\n`, { mode: 0o600 });
    return status;
  };
  const lockTarget = join(plan.root, 'deploy.lock');
  await writeFile(lockTarget, '', { flag: 'a', mode: 0o600 });
  let release: (() => Promise<void>) | undefined;
  try {
    release = await lockfile.lock(lockTarget, { realpath: false, stale: 30_000, update: 10_000 });
  } catch {
    await rm(planPath, { force: true });
    return report('failed', '另一个部署正在进行，本次未做任何改动');
  }
  try {
    for (const bridge of plan.stop) {
      await report('stopping', `停止旧进程 ${bridge.pid}（${bridge.profiles.join(', ')}）`);
      if (!await stopBridge(bridge, plan.stopTimeoutMs)) {
        return report('failed', `旧进程 ${bridge.pid} 在 ${Math.round(plan.stopTimeoutMs / 1000)} 秒内没有退出，未启动新版本`);
      }
    }
    const { target } = plan;
    const log = logPath(plan.root, 'bridge');
    await report('starting', `启动 ${target.release.label}（${target.profiles.join(', ')}）`, { log });
    let started: { pid: number; identity: string } | undefined;
    let failure: string;
    try {
      started = await startBridge(target.launch, log);
      const outcome = await waitForBridge(started, log, target.profiles, { timeoutMs: plan.readyTimeoutMs, stableMs: plan.stableMs });
      if (outcome === 'ready') {
        await recordSuccess(plan, started, log);
        return report('complete', `${target.release.label} 已上线：pid ${started.pid}，${target.profiles.join(' + ')}`, { pid: started.pid, log });
      }
      failure = outcome === 'exited' ? '新版本启动后退出了' : `新版本没有在 ${Math.round(plan.readyTimeoutMs / 1000)} 秒内全部上线`;
    } catch (err) {
      failure = `新版本无法启动：${err instanceof Error ? err.message : String(err)}`;
    }
    if (started) await forceStop(started);
    return rollback(plan, `${failure}（日志 ${log}）`, report);
  } finally {
    await rm(planPath, { force: true });
    await release().catch(() => {});
  }
}

async function rollback(plan: HandoverPlan, reason: string,
  report: (phase: HandoverPhase, message: string, extra?: Partial<HandoverStatus>) => Promise<HandoverStatus>): Promise<HandoverStatus> {
  const restorable = plan.stop.filter(bridge => bridge.launch);
  if (!restorable.length) return report('failed', `${reason}；之前没有可恢复的进程`);
  const restored: number[] = [];
  for (const bridge of restorable) {
    const log = logPath(plan.root, 'rollback');
    try {
      const started = await startBridge(bridge.launch!, log);
      if (await waitForBridge(started, log, bridge.profiles, { timeoutMs: plan.readyTimeoutMs, stableMs: plan.stableMs }) === 'ready') {
        restored.push(started.pid);
        const state = readState(plan.root);
        if (state.current?.pid === bridge.pid) {
          await writeState(plan.root, { ...state, current: { ...state.current, ...started, log, startedAt: new Date().toISOString() } });
        }
      }
    } catch { /* reported below */ }
  }
  return restored.length === restorable.length
    ? report('rolled-back', `${reason}；已恢复旧进程（pid ${restored.join(', ')}）`)
    : report('failed', `${reason}；恢复旧进程也失败，bridge 当前未运行`);
}

async function recordSuccess(plan: HandoverPlan, started: { pid: number; identity: string }, log: string): Promise<void> {
  const state = readState(plan.root);
  const { release, profiles, fingerprint, launch } = plan.target;
  const current: Instance = {
    pid: started.pid, identity: started.identity, release: release.dir, label: release.label,
    ...(release.commit ? { commit: release.commit } : {}), version: release.version,
    profiles, fingerprint, launch: { argv: launch.argv, cwd: launch.cwd }, log, startedAt: new Date().toISOString(),
  };
  const replaced = plan.stop.find(bridge => bridge.pid === state.current?.pid) ? state.current : adopted(plan.stop[0]);
  await writeState(plan.root, { current, ...(replaced ? { previous: replaced } : state.previous ? { previous: state.previous } : {}) });
  await pointAt(join(plan.root, 'current'), release.dir);
  await pointAt(join(plan.root, 'bridge.log'), log);
  await pruneReleases(plan.root, plan.keep, [current.release, ...(replaced ? [replaced.release] : [])]).catch(() => []);
}

/** A bridge `up` did not start, described well enough to roll back to. */
function adopted(bridge: RunningBridge | undefined): Instance | undefined {
  const entry = bridge?.launch?.argv[1];
  if (!bridge?.launch || !entry) return undefined;
  const release = dirname(dirname(entry));
  return { pid: bridge.pid, identity: bridge.identity, release, label: basename(release), profiles: bridge.profiles,
    launch: { argv: bridge.launch.argv, cwd: bridge.launch.cwd }, startedAt: new Date().toISOString() };
}

async function forceStop(bridge: { pid: number; identity: string }): Promise<void> {
  if (await stopBridge(bridge, 30_000)) return;
  if (processIdentity(bridge.pid) === bridge.identity) {
    try { process.kill(-bridge.pid, 'SIGKILL'); } catch { /* already gone */ }
  }
}

async function pointAt(link: string, target: string): Promise<void> {
  const tmp = `${link}.tmp-${process.pid}`;
  await rm(tmp, { force: true });
  await symlink(target, tmp);
  await rename(tmp, link);
}

function logPath(root: string, kind: string): string {
  return join(root, 'logs', `${kind}-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
}
