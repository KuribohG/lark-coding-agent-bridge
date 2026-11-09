import { existsSync } from 'node:fs';
import { open, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { resolveAppPaths } from '../../config/app-paths';
import { parseDocument, type ConfigDocument } from '../../config/document';
import { spawnProcess } from '../../platform/spawn';
import { readStatus, runHandover, TERMINAL_PHASES, writePlan, type HandoverPlan } from '../../deploy/handover';
import { findRunningBridges, processIdentity, readLaunch, stopBridge, type RunningBridge } from '../../deploy/process';
import { BRIDGE_ENTRY, buildRelease, builtRelease, resolveGitCommit, run, selfRelease, type Release } from '../../deploy/release';
import { bridgeEnvironment, launchFingerprint, resolveDeploySpec, runArgs, type DeploySpec } from '../../deploy/spec';
import { readState, writeState } from '../../deploy/state';
import { runProfileCreate } from './profile';

export interface UpOptions {
  config?: string;
  /** Print what would happen without changing anything. */
  plan?: boolean;
  /** Replace the running bridge even when nothing changed. */
  restart?: boolean;
  /** Go back to the release that ran before the last successful `up`. */
  rollback?: boolean;
  /** Internal: run a handover plan written by `up`. */
  handover?: string;
}

export interface UpDeps {
  say?: (line: string) => void;
  /** Starts `up --handover <plan>` outside this process tree. */
  spawnHandover?: (planPath: string, dir: string) => Promise<void>;
  resolveRelease?: (spec: DeploySpec) => Promise<Release>;
  stableMs?: number;
  stopTimeoutMs?: number;
  pollMs?: number;
}

const STOP_TIMEOUT_MS = 90_000;
const STABLE_MS = 10_000;

/**
 * Brings the bridge described by the config file's `[deploy]` table up:
 * resolves and builds the release, then starts it or hands over from the
 * running bridge, rolling back when the new one does not come online.
 */
export async function runUp(opts: UpOptions, deps: UpDeps = {}): Promise<void> {
  if (opts.handover) {
    const status = await runHandover(opts.handover);
    if (status.phase !== 'complete') process.exitCode = 1;
    return;
  }
  supportedPlatform();
  const say = deps.say ?? ((line: string) => console.log(line));
  const configPath = opts.config ?? resolveAppPaths().configFile;
  const doc = await loadDeployDocument(configPath, say);
  const spec = resolveDeploySpec(doc, configPath);
  if (!spec.profiles.length) throw new Error('没有要启动的 profile：在 [deploy] profiles 或 [bridge] autostart_profiles 中指定');
  const state = readState(spec.root);
  const running = await runningBridges(spec, [...spec.profiles, ...state.current?.profiles ?? []]);

  let target: { release: Release; profiles: string[]; fingerprint: string; argv: string[]; cwd: string };
  if (opts.rollback) {
    const previous = state.previous;
    if (!previous) throw new Error('没有可回滚的上一个版本');
    if (!existsSync(join(previous.release, BRIDGE_ENTRY))) throw new Error(`上一个版本已不存在：${previous.release}`);
    target = { release: { dir: previous.release, label: previous.label, version: previous.version ?? '',
      ...(previous.commit ? { commit: previous.commit } : {}) }, profiles: previous.profiles,
    fingerprint: previous.fingerprint ?? '', argv: previous.launch.argv, cwd: previous.launch.cwd };
  } else {
    const release = deps.resolveRelease ? await deps.resolveRelease(spec) : await resolveRelease(spec, Boolean(opts.plan), say);
    target = { release, profiles: spec.profiles, fingerprint: launchFingerprint(spec), cwd: spec.cwd,
      argv: [spec.node, join(release.dir, BRIDGE_ENTRY), ...runArgs(configPath, spec.profiles)] };
  }

  const current = state.current;
  const unchanged = !opts.restart && !opts.rollback && running.length === 1 && current !== undefined
    && running[0]!.pid === current.pid && running[0]!.identity === current.identity
    && current.release === target.release.dir && current.version === target.release.version
    && current.commit === target.release.commit && current.fingerprint === target.fingerprint;
  for (const bridge of running) say(`运行中：pid ${bridge.pid}（${bridge.profiles.join(', ')}）${bridge.launch ? ` ${bridge.launch.argv.slice(1, 2).join('')}` : ''}`);
  say(`目标：${describe(target.release)}，${target.profiles.join(' + ')}`);
  if (unchanged) {
    say('已是最新，无需重启；配置文件里的其他改动由运行中的 bridge 自动加载。');
    return;
  }
  say(`动作：${opts.rollback ? '回滚并替换运行中的 bridge' : running.length ? '替换运行中的 bridge' : '启动 bridge'}`);
  if (opts.plan) return;

  // An agent of the running bridge carries its run bindings and agent state
  // directories; the bridge's own environment is the faithful base there.
  const inherited = process.env.LARK_CHANNEL === '1' ? running.find(bridge => bridge.launch?.env)?.launch?.env : undefined;
  const env = bridgeEnvironment(spec, inherited ?? process.env);
  say('用目标版本校验配置');
  await run(target.argv[0]!, [target.argv[1]!, 'config', 'check', '--config', configPath], { env })
    .catch((err: Error) => { throw new Error(`目标版本无法使用当前配置，未做任何改动：${err.message}`); });

  const dir = join(spec.root, 'handover', `${Date.now()}-${process.pid}`);
  const plan: HandoverPlan = {
    root: spec.root, dir, keep: spec.keep,
    target: { release: target.release, profiles: target.profiles, fingerprint: target.fingerprint,
      launch: { argv: target.argv, cwd: target.cwd, env } },
    stop: running,
    stopTimeoutMs: deps.stopTimeoutMs ?? STOP_TIMEOUT_MS,
    readyTimeoutMs: spec.readyTimeoutMs,
    stableMs: deps.stableMs ?? STABLE_MS,
  };
  const planPath = await writePlan(plan);
  await (deps.spawnHandover ?? spawnHandover)(planPath, dir);
  await follow(plan, say, deps.pollMs ?? 500);
}

/** Stops every bridge serving this config's profiles. */
export async function runDown(opts: { config?: string }, deps: Pick<UpDeps, 'say' | 'stopTimeoutMs'> = {}): Promise<void> {
  supportedPlatform();
  const say = deps.say ?? ((line: string) => console.log(line));
  const configPath = opts.config ?? resolveAppPaths().configFile;
  const doc = parseDocument(await readFile(configPath, 'utf8'));
  const spec = resolveDeploySpec(doc, configPath);
  const state = readState(spec.root);
  const running = await runningBridges(spec, [...Object.keys(doc.profiles), ...state.current?.profiles ?? []]);
  if (!running.length) {
    say('没有运行中的 bridge');
    return;
  }
  let failed = false;
  for (const bridge of running) {
    const stopped = await stopBridge(bridge, deps.stopTimeoutMs ?? STOP_TIMEOUT_MS);
    say(stopped ? `已停止 pid ${bridge.pid}（${bridge.profiles.join(', ')}）` : `pid ${bridge.pid} 没有在规定时间内退出`);
    failed ||= !stopped;
  }
  if (state.current) await writeState(spec.root, { previous: state.current });
  if (failed) process.exitCode = 1;
}

function supportedPlatform(): void {
  if (process.platform === 'win32') throw new Error('up / down 目前只支持 macOS 和 Linux；Windows 请用 start / stop');
}

/** The config, creating a first profile interactively when there is none yet. */
async function loadDeployDocument(configPath: string, say: (line: string) => void): Promise<ConfigDocument> {
  const read = async () => existsSync(configPath) ? parseDocument(await readFile(configPath, 'utf8')) : undefined;
  const doc = await read();
  if (doc && Object.keys(doc.profiles).length) return doc;
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(`${configPath} 里还没有飞书应用：先在终端运行 lark-channel-bridge up（或 profile create <名字>）扫码创建`);
  }
  say('还没有飞书应用，先扫码创建一个（profile 名 default）');
  await runProfileCreate('default', { rootDir: dirname(configPath) });
  const created = await read();
  if (!created || !Object.keys(created.profiles).length) throw new Error('没有创建出 profile');
  return created;
}

async function resolveRelease(spec: DeploySpec, planOnly: boolean, say: (line: string) => void): Promise<Release> {
  if (spec.source.kind === 'self') return selfRelease();
  const commit = await resolveGitCommit(spec, say);
  if (planOnly) {
    return builtRelease(spec.root, commit)
      ?? { dir: join(spec.root, 'releases', commit.slice(0, 12)), label: commit.slice(0, 12), commit, version: '（需构建）' };
  }
  return buildRelease(spec, commit, say);
}

async function runningBridges(spec: DeploySpec, profiles: readonly string[]): Promise<RunningBridge[]> {
  const running = await findRunningBridges(spec.configPath, [...new Set(profiles)]);
  const current = readState(spec.root).current;
  if (!current || processIdentity(current.pid) !== current.identity) return running;
  // Without /proc, the recorded command line is what a rollback can restart.
  const launch = readLaunch(current.pid) ?? current.launch;
  const found = running.find(bridge => bridge.pid === current.pid);
  if (!found) running.push({ pid: current.pid, identity: current.identity, profiles: current.profiles, launch });
  else found.launch ??= launch;
  return running;
}

function describe(release: Release): string {
  const version = release.version ? ` ${release.version}` : '';
  return release.label === 'self' ? `当前安装${version}（${release.dir}）` : `${release.label}${version}`;
}

async function spawnHandover(planPath: string, dir: string): Promise<void> {
  const entry = process.argv[1];
  if (!entry) throw new Error('无法定位 CLI 入口');
  const log = await open(join(dir, 'handover.log'), 'a', 0o600);
  try {
    const child = spawnProcess(process.execPath, [entry, 'up', '--handover', planPath], {
      detached: true, stdio: ['ignore', log.fd, log.fd],
    });
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    child.unref();
  } finally {
    await log.close();
  }
}

async function follow(plan: HandoverPlan, say: (line: string) => void, pollMs: number): Promise<void> {
  const deadline = Date.now() + plan.stopTimeoutMs * Math.max(1, plan.stop.length) + 2 * plan.readyTimeoutMs + 60_000;
  let last = '';
  while (Date.now() < deadline) {
    const status = readStatus(plan.dir);
    if (status && status.message !== last) {
      last = status.message;
      say(status.message);
    }
    if (status && TERMINAL_PHASES.has(status.phase)) {
      if (status.phase === 'complete') say(`日志：${join(plan.root, 'bridge.log')}`);
      else process.exitCode = 1;
      return;
    }
    await delay(pollMs);
  }
  say(`交接仍在进行，进度见 ${join(plan.dir, 'status.json')}`);
}
