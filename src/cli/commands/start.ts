import dns from 'node:dns';
import os from 'node:os';
import { createInterface } from 'node:readline';
import pkg from '../../../package.json';
import { resolveAppPaths, type AppPaths } from '../../config/app-paths';
import { getAutostartProfiles, loadRootConfig } from '../../config/profile-store';
import type { RootConfig } from '../../config/profile-schema';
import { configureLogger, gcOldLogs, log, reportError } from '../../core/logger';
import { loadTelemetryAdapter, telemetry } from '../../core/telemetry';
import { startUiServer } from '../../ui/server';
import { readUiSidecar, removeUiSidecar, writeUiSidecar } from '../../ui/sidecar';
import type { UiServerHandle } from '../../ui/types';
import { Supervisor } from '../../runtime/supervisor';
import { acquireHostLock } from '../../runtime/host-lock';
import { stopProcessEntry, type StopProcessEntryResult } from './ps';
import { cleanupTmpFiles } from '../../runtime/registry';
import {
  RuntimeLockConflictError,
  type RuntimeLockMeta,
} from '../../runtime/locks';
import { resolveProfileRuntime } from '../../runtime/profile-runtime';
import { createBuiltinPlugins } from '../../plugins/defaults';

// Prefer IPv4 — Node 20+ defaults to "verbatim" which respects whatever
// the resolver returns first; in IPv6-broken networks (WSL2, certain VPNs,
// some hotel WiFi) this lands on a dead v6 route and stalls. Explicitly
// prefer v4 avoids that whole class of issue.
dns.setDefaultResultOrder('ipv4first');

// Process-level safety net: never let a stray SDK call / axios timeout
// take the whole bot down. Most outbound calls (channel.send / rawClient.*)
// are async; if any callsite misses a try/catch (or fires an update after
// its enclosing scope returned), the rejection bubbles to here. Log and
// keep the bot alive — losing a single reply is better than crashing.
process.on('unhandledRejection', (reason) => {
  log.fail('process', reason, { kind: 'unhandledRejection' });
  reportError(reason, { kind: 'unhandledRejection' });
});
process.on('uncaughtException', (err) => {
  log.fail('process', err, { kind: 'uncaughtException' });
  reportError(err, { kind: 'uncaughtException' });
});

export interface StartOptions {
  config?: string;
  profile?: string;
  agent?: string;
  workspace?: string;
  appId?: string;
  appSecret?: string;
  tenant?: string;
  skipCheckLarkCli?: boolean;
  /** Start the machine-wide supervisor + web console instead of a single
   * profile in the foreground. Default false → classic headless run. */
  webUi?: boolean;
  confirmStopRuntimeLockProcess?: (err: RuntimeLockConflictError) => boolean | Promise<boolean>;
  stopRuntimeLockProcess?: (meta: RuntimeLockMeta) => StopProcessEntryResult | Promise<StopProcessEntryResult>;
}

/**
 * Foreground bridge entry.
 *
 *  - `run` / `run --profile X` → **classic**: one profile in the foreground,
 *    no web console, headless-safe (works on servers without a browser).
 *  - `run --web-ui` → **supervisor console**: one machine-wide process hosting
 *    all profiles + a local web console to start/stop/configure them.
 */
export async function runStart(opts: StartOptions): Promise<void> {
  if (opts.webUi) {
    await runSupervisorConsole(opts);
    return;
  }
  await runClassic(opts);
}


/**
 * Classic single-profile foreground run (the pre-supervisor default). Uses the
 * Supervisor internally to host exactly one profile — no host lock (so multiple
 * classic runs coexist in separate terminals) and no web console. Fails loudly
 * if the profile can't come online.
 */
async function runClassic(opts: StartOptions): Promise<void> {
  const runtime = await resolveProfileRuntime({
    ...opts,
    allowBootstrap: true,
  });
  const { cfg, configPath, appPaths } = runtime;
  configureLogger({ logsDir: appPaths.logsDir });
  await loadTelemetryAdapter({
    version: pkg.version,
    appId: cfg.accounts.app.id,
    tenant: cfg.accounts.app.tenant,
    hostname: os.hostname(),
  });
  await gcOldLogs();

  const supervisor = new Supervisor({
    configPath,
    rootDir: appPaths.rootDir,
    plugins: createBuiltinPlugins(),
  });

  // Retry loop: on a profile/app runtime-lock conflict, offer to stop the
  // holder and try again (same UX as older single-profile `run`).
  for (;;) {
    try {
      await supervisor.startProfile(appPaths.profile);
      break;
    } catch (err) {
      const action = await handleRuntimeLockConflict(err, opts);
      if (action === 'retry') continue;
      if (action === 'cancel') {
        process.exit(0);
      }
      throw err; // unhandled → surfaced to the CLI top-level handler (exit 1)
    }
  }
  console.log(`✓ profile「${appPaths.profile}」已上线（前台运行，Ctrl-C 退出）`);

  await parkWithShutdown(supervisor, appPaths, undefined, undefined);
}

/**
 * Supervisor console mode: one process per machine hosting every profile, with
 * a local web console. A second `run --web-ui` / `start --web-ui` detects the
 * running control plane and prints its URL instead of launching a duplicate.
 */
async function runSupervisorConsole(opts: StartOptions): Promise<void> {
  const initialPaths = resolveAppPaths();
  const root = await loadRootConfig(opts.config ?? initialPaths.configFile);
  // An empty install must reach the web wizard without terminal prompts.
  const runtime = root || opts.appId ? await resolveProfileRuntime({
    ...opts,
    allowBootstrap: true,
  }) : undefined;
  const configPath = runtime?.configPath ?? opts.config ?? initialPaths.configFile;
  const appPaths = runtime?.appPaths ?? initialPaths;
  configureLogger({ logsDir: appPaths.hostLogsDir });

  // One supervisor per machine. If one is already running, print its console
  // URL and exit instead of launching a duplicate.
  const hostLock = await acquireHostLock(appPaths.hostLockFile);
  if (!hostLock) {
    const sidecar = await readUiSidecar(appPaths.hostUiFile);
    console.log(
      sidecar
        ? `控制面已在运行：${sidecar.url}`
        : '控制面已在运行（另一个 supervisor 进程持有锁）。',
    );
    return;
  }

  await loadTelemetryAdapter({
    version: pkg.version,
    appId: runtime?.cfg.accounts.app.id ?? '',
    tenant: runtime?.cfg.accounts.app.tenant ?? 'feishu',
    hostname: os.hostname(),
  });
  await gcOldLogs();

  const supervisor = new Supervisor({
    configPath,
    rootDir: appPaths.rootDir,
    plugins: createBuiltinPlugins(),
  });

  // Single web console (host sidecar), backed by the supervisor.
  let uiServer: UiServerHandle | undefined;
  try {
    uiServer = await startUiServer({ supervisor, version: pkg.version, rootDir: appPaths.rootDir,
      requestShutdown: () => process.emit('SIGTERM', 'SIGTERM') });
    await writeUiSidecar(appPaths.hostUiFile, uiServer, new Date().toISOString());
    console.log(`✓ 控制台：${uiServer.url}`);
  } catch (err) {
    log.warn('ui', 'server-start-failed', { err: String(err) });
  }

  // Register shutdown before starting a channel (which may wait on the network).
  const parked = parkWithShutdown(supervisor, appPaths, uiServer, hostLock);
  // An explicit --profile is a one-run override. Otherwise start the persisted
  // supervisor boot set; missing config still falls back to the active profile.
  const bootProfiles = resolveSupervisorBootProfiles({
    root,
    resolvedProfile: runtime?.profile,
    explicitProfile: opts.profile,
  });
  for (const profile of bootProfiles) {
    try {
      await supervisor.startProfile(profile);
      console.log(`✓ profile「${profile}」已上线`);
    } catch (err) {
      console.warn(
        `⚠️ profile「${profile}」启动失败：${err instanceof Error ? err.message : String(err)}`,
      );
      log.warn('supervisor', 'profile-start-failed', { profile, err: String(err) });
    }
  }

  await parked;
}

export function resolveSupervisorBootProfiles(input: {
  root?: RootConfig;
  resolvedProfile?: string;
  explicitProfile?: string;
}): string[] {
  if (input.explicitProfile) return input.resolvedProfile ? [input.resolvedProfile] : [];
  if (input.root?.autostartProfiles !== undefined) return getAutostartProfiles(input.root);
  if (input.resolvedProfile && input.root?.profiles[input.resolvedProfile]) return [input.resolvedProfile];
  if (input.root) return getAutostartProfiles(input.root);
  return input.resolvedProfile ? [input.resolvedProfile] : [];
}

/**
 * Install the one-time signal / exit handlers and park the process forever
 * (until a signal triggers shutdown). Shared by both modes; console mode passes
 * a `uiServer` + `hostLock` to also tear those down, classic mode passes
 * neither. Returns a promise that never resolves so the caller stays parked.
 */
function parkWithShutdown(
  supervisor: Supervisor,
  appPaths: AppPaths,
  uiServer: UiServerHandle | undefined,
  hostLock: { release(): Promise<void> } | undefined,
): Promise<void> {
  let shuttingDown = false;
  const shutdown = async (sig: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n收到 ${sig}，正在关闭...`);
    if (uiServer) {
      await uiServer.close().catch(() => {});
      await removeUiSidecar(appPaths.hostUiFile);
    }
    await supervisor.shutdown();
    if (hostLock) await hostLock.release().catch(() => {});
    await flushTelemetry();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('beforeExit', () => {
    void flushTelemetry();
  });
  process.on('exit', () => {
    supervisor.unregisterAllSync();
    cleanupTmpFiles(appPaths.userRegistryFile);
  });

  return new Promise<void>(() => {});
}


type RuntimeLockConflictAction = 'retry' | 'cancel' | 'unhandled';

async function handleRuntimeLockConflict(
  err: unknown,
  opts: StartOptions,
): Promise<RuntimeLockConflictAction> {
  if (!(err instanceof RuntimeLockConflictError)) return 'unhandled';
  console.error(`✗ 当前 ${err.kind === 'profile' ? 'profile' : 'app'} 已有 bridge 进程占用。`);
  if (err.meta) {
    const app = err.meta.appId ? ` app=${err.meta.appId}` : '';
    console.error(
      `  holder: profile=${err.meta.profile}${app} agent=${err.meta.agentKind} pid=${err.meta.pid} startedAt=${err.meta.startedAt}`,
    );
  } else {
    console.error(`  lock: ${err.target}`);
    return 'unhandled';
  }

  const confirmed = opts.confirmStopRuntimeLockProcess
    ? await opts.confirmStopRuntimeLockProcess(err)
    : await confirmStopRuntimeLockProcess(err);
  if (!confirmed) {
    console.log('已取消启动。');
    return 'cancel';
  }

  const result = opts.stopRuntimeLockProcess
    ? await opts.stopRuntimeLockProcess(err.meta)
    : await stopProcessEntry({ pid: err.meta.pid });
  if (result === 'killed') {
    console.log(`✓ 已强制停止 pid ${err.meta.pid}`);
  } else {
    console.log(`✓ 已停止 pid ${err.meta.pid}`);
  }
  return 'retry';
}

async function confirmStopRuntimeLockProcess(err: RuntimeLockConflictError): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      `当前 ${err.kind === 'profile' ? 'profile' : 'app'} 已有 bridge 进程占用；` +
        '非交互模式无法确认停止，请先用 `lark-channel-bridge ps` 查看并用 `lark-channel-bridge kill <bot id>` 停止后重试',
    );
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await new Promise<string>((resolve) =>
      rl.question('是否停止旧进程并重新启动? [y/N]: ', resolve),
    ))
      .trim()
      .toLowerCase();
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

async function flushTelemetry(timeoutMs = 2000): Promise<void> {
  try {
    await telemetry().flush?.(timeoutMs);
  } catch {
    /* best effort during shutdown */
  }
}
