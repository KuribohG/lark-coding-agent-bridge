import * as launchd from './launchd';
import { launchAgentPlistPath, systemdUnitPath, windowsTaskName } from './paths';
import * as schtasks from './schtasks';
import * as systemd from './systemd';

export interface ServiceResult {
  ok: boolean;
  stderr: string;
}

export type ServiceState = 'running' | 'stopped' | 'failed' | 'missing' | 'unknown';

export interface ServiceStatus {
  state: ServiceState;
  pid?: number;
  lastExit?: number;
  lastRunAt?: string;
  source: 'launchd' | 'systemd' | 'schtasks';
  trigger: 'login';
}

export interface ServiceCapabilities {
  loginAutostart: boolean;
  bootAutostart: boolean;
  currentUserOnly: boolean;
  nativeRestart: boolean;
}

/** Some platforms' restart is sync (spawnSync), others (schtasks) are
 * naturally async. Adapter methods can return either; callers await. */
export type ServiceResultLike = ServiceResult | Promise<ServiceResult>;

/**
 * Platform-agnostic interface over OS service managers (launchd / systemd /
 * schtasks). All methods are best-effort idempotent — calling stop()
 * on an already-stopped service returns ok=true.
 */
export interface ServiceAdapter {
  /** Display name used in error / status messages. */
  readonly platformName: string;
  readonly capabilities: ServiceCapabilities;

  /** Whether the service file (plist / unit / task) is on disk / registered. */
  fileExists(): boolean;

  /** Structured service state, independent of localized CLI output. */
  status(): Promise<ServiceStatus>;

  /** Path/name to the service definition (for status output). */
  servicePath(): string;

  /** Write or overwrite the service definition. */
  install(): Promise<void>;

  /** Start the service (enables autostart where applicable). */
  start(): ServiceResultLike;

  /** Stop the service. Does NOT disable autostart on its own. */
  stop(): ServiceResultLike;

  /** Stop + disable autostart. Used by `unregister` flow. */
  stopAndDisableAutostart(): ServiceResultLike;

  /**
   * Turn off autostart on an already-stopped service, without trying to stop
   * it again. `stop` needs this: a service that is registered but not running
   * would otherwise keep its login-time autostart and come back by itself.
   */
  disableAutostart(): ServiceResultLike;

  /** Restart the running service in place. */
  restart(): ServiceResultLike;

  /** Poll until the service is no longer running, or timeout. */
  waitUntilStopped(timeoutMs?: number): Promise<boolean>;

  /** Remove the service definition from the OS. */
  deleteFile(): Promise<void>;

}

function makeLaunchdAdapter(profile: string, runArgs: string[]): ServiceAdapter {
  return {
    platformName: 'launchd (macOS)',
    capabilities: {
      loginAutostart: true,
      bootAutostart: false,
      currentUserOnly: true,
      nativeRestart: true,
    },
    fileExists: () => launchd.plistExists(profile),
    status: async () => {
      if (!launchd.plistExists(profile)) {
        return { state: 'missing', source: 'launchd', trigger: 'login' };
      }
      const running = launchd.isLoaded(profile);
      const text = launchd.describeService(profile);
      const pid = numberValue(text.match(/pid\s*=\s*(\d+)/)?.[1]);
      const lastExit = numberValue(text.match(/last exit code\s*=\s*(-?\d+)/i)?.[1]);
      return {
        state: running ? 'running' : 'stopped',
        ...(pid !== undefined ? { pid } : {}),
        ...(lastExit !== undefined && lastExit >= 0 ? { lastExit } : {}),
        source: 'launchd',
        trigger: 'login',
      };
    },
    servicePath: () => launchAgentPlistPath(profile),
    install: () => launchd.writePlist(profile, runArgs),
    // A previous `stop` may have left the job disabled in launchd's override
    // DB, where it would stay dead through bootstrap. Always enable first.
    start: () => {
      launchd.enable(profile);
      return launchd.bootstrap(profile);
    },
    stop: () => launchd.bootout(profile),
    // bootout alone is session-scoped: the plist keeps RunAtLoad=true, so
    // launchd re-bootstraps the job at the next login. Pair it with an
    // explicit `disable` to actually match systemd's `disable --now`.
    stopAndDisableAutostart: () => {
      const out = launchd.bootout(profile);
      const disabled = launchd.disable(profile);
      return out.ok ? disabled : out;
    },
    disableAutostart: () => launchd.disable(profile),
    restart: () => launchd.kickstart(profile),
    waitUntilStopped: (timeoutMs) => launchd.waitUntilUnloaded(profile, timeoutMs),
    deleteFile: () => launchd.deletePlist(profile),
  };
}

function makeSystemdAdapter(profile: string, runArgs: string[]): ServiceAdapter {
  return {
    platformName: 'systemd (Linux user)',
    capabilities: {
      loginAutostart: true,
      bootAutostart: false,
      currentUserOnly: true,
      nativeRestart: true,
    },
    fileExists: () => systemd.unitExists(profile),
    status: async () => {
      if (!systemd.unitExists(profile)) {
        return { state: 'missing', source: 'systemd', trigger: 'login' };
      }
      const status = systemd.readStatus(profile);
      return {
        state: systemdServiceState(status.activeState),
        ...(status.mainPid ? { pid: status.mainPid } : {}),
        ...(status.lastExit !== undefined ? { lastExit: status.lastExit } : {}),
        source: 'systemd',
        trigger: 'login',
      };
    },
    servicePath: () => systemdUnitPath(profile),
    install: async () => {
      await systemd.writeUnit(profile, runArgs);
      // systemd needs daemon-reload after any unit file change.
      systemd.daemonReload();
    },
    start: () => systemd.enableAndStart(profile),
    stop: () => systemd.stop(profile),
    stopAndDisableAutostart: () => systemd.disableAndStop(profile),
    disableAutostart: () => systemd.disable(profile),
    restart: () => systemd.restart(profile),
    waitUntilStopped: (timeoutMs) => systemd.waitUntilInactive(profile, timeoutMs),
    deleteFile: async () => {
      await systemd.deleteUnit(profile);
      systemd.daemonReload();
    },
  };
}

function makeSchtasksAdapter(profile: string, runArgs: string[]): ServiceAdapter {
  return {
    platformName: 'Task Scheduler (Windows)',
    capabilities: {
      loginAutostart: true,
      bootAutostart: false,
      currentUserOnly: true,
      nativeRestart: false,
    },
    fileExists: () => schtasks.isTaskRegistered(profile),
    status: async () => {
      if (!schtasks.isTaskRegistered(profile)) {
        return { state: 'missing', source: 'schtasks', trigger: 'login' };
      }
      const status = schtasks.readTaskStatus(profile);
      return {
        state: status.state,
        ...(status.pid !== undefined ? { pid: status.pid } : {}),
        ...(status.lastExit !== undefined ? { lastExit: status.lastExit } : {}),
        ...(status.lastRunAt ? { lastRunAt: status.lastRunAt } : {}),
        source: 'schtasks',
        trigger: 'login',
      };
    },
    // Windows doesn't have a single "service file" — there's the task
    // registration (queryable via schtasks) and the launcher .cmd we wrote.
    // The task name is what the user would search for in Task Scheduler UI.
    servicePath: () => windowsTaskName(profile),
    install: async () => {
      const r = await schtasks.installTask(profile, runArgs);
      if (!r.ok) throw new Error(r.stderr || 'schtasks /Create failed');
    },
    // Mirror launchd: a previous `stop` disabled the task, and a disabled
    // task refuses to run. Re-enable before starting it.
    start: () => {
      schtasks.enableTask(profile);
      return schtasks.runTask(profile);
    },
    stop: () => schtasks.endTask(profile),
    stopAndDisableAutostart: () => schtasks.endAndDisable(profile),
    disableAutostart: () => schtasks.disableTask(profile),
    // schtasks has no native /Restart — adapter awaits end+wait+run.
    restart: () => schtasks.restartTask(profile),
    waitUntilStopped: (timeoutMs) => schtasks.waitUntilStopped(profile, timeoutMs),
    deleteFile: async () => {
      await schtasks.deleteTask(profile);
    },
  };
}

function numberValue(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function systemdServiceState(activeState: string): ServiceState {
  if (activeState === 'active' || activeState === 'reloading') return 'running';
  if (activeState === 'failed') return 'failed';
  if (activeState === 'inactive') return 'stopped';
  if (!activeState) return 'unknown';
  return 'unknown';
}

/**
 * Return the right adapter for the current platform, or null if this OS
 * isn't supported. Callers should null-check and surface a friendly error.
 *
 * `runArgs` are the CLI args the daemon launches with (e.g.
 * `['run', '--profile', 'claude']` for a classic per-profile service, or
 * `['run', '--web-ui']` for the supervisor service). They only matter for
 * `install()`; stop/status/etc. ignore them.
 */
export function getServiceAdapter(
  profile = 'claude',
  runArgs: string[] = ['run'],
): ServiceAdapter | null {
  if (process.platform === 'darwin') return makeLaunchdAdapter(profile, runArgs);
  if (process.platform === 'linux') return makeSystemdAdapter(profile, runArgs);
  if (process.platform === 'win32') return makeSchtasksAdapter(profile, runArgs);
  return null;
}
