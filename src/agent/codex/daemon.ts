import type { ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentRun } from '../types';
import { writeFileAtomic } from '../../platform/atomic-write';
import { log } from '../../core/logger';
import { spawnProcess } from '../../platform/spawn';
import { terminateChild } from '../../platform/terminate';
import { liveRunHosts } from '../run-host';

const COMMAND_TIMEOUT_MS = 30_000;
const OUTPUT_LIMIT = 32_000;

export interface CodexAppServerDaemonStatus {
  status: 'running' | 'started';
  /** A required restart was postponed because runs are still attached. */
  restartDeferred?: boolean;
  backend?: string;
  pid?: number;
  managedCodexPath?: string;
  managedCodexVersion?: string;
  socketPath?: string;
  cliVersion?: string;
  appServerVersion?: string;
}

interface DaemonCommandResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

const inFlight = new Map<string, Promise<CodexAppServerDaemonStatus>>();
/** Runs attached to each daemon in this process; an env change restarts the daemon only at zero. */
const attached = new Map<string, number>();
const deferredLogged = new Set<string>();
const idleListeners = new Set<() => void>();

/** Runs currently attached to the daemon for this binary and Codex home. */
export function attachedDaemonRuns(binary: string, codexHome: string | undefined): number {
  return attached.get(daemonKey({ binary, env: { CODEX_HOME: codexHome } })) ?? 0;
}

/** Notified whenever a daemon's last attached run finishes. */
export function onDaemonIdle(listener: () => void): () => void {
  idleListeners.add(listener);
  return () => { idleListeners.delete(listener); };
}
/** Records the launch environment the running daemon was started with. */
const FINGERPRINT_FILE = '.bridge-app-server-env';

function daemonKey(input: { binary: string; env: NodeJS.ProcessEnv }): string {
  return `${input.binary}\0${input.env.CODEX_HOME ?? '<default-codex-home>'}`;
}

/** Tags hosted runs connected to this daemon, which outlive the bridge process that counted them. */
export function codexDaemonHostTag(input: { binary: string; env: NodeJS.ProcessEnv }): string {
  return `codex-daemon:${createHash('sha256').update(daemonKey(input)).digest('hex').slice(0, 32)}`;
}

/** Stable digest of the environment a config edit can change (launch env, provider env, CODEX_HOME). */
export function daemonEnvironmentFingerprint(env: Readonly<NodeJS.ProcessEnv>): string {
  const entries = Object.entries(env).filter(([, value]) => value !== undefined).sort(([a], [b]) => a.localeCompare(b));
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}

/**
 * Count a daemon-attached run until its event stream ends, so an environment
 * change never restarts the daemon underneath active runs.
 */
export function trackDaemonRun(input: { binary: string; env: NodeJS.ProcessEnv }, run: AgentRun): AgentRun {
  const key = daemonKey(input);
  attached.set(key, (attached.get(key) ?? 0) + 1);
  let released = false;
  // Released when the stream ends, the run is stopped, or the process has exited,
  // so an unconsumed stream cannot pin the daemon forever.
  const release = () => {
    if (released) return;
    released = true;
    const left = (attached.get(key) ?? 1) - 1;
    if (left > 0) { attached.set(key, left); return; }
    attached.delete(key);
    for (const listener of [...idleListeners]) {
      try { listener(); } catch (error) { log.warn('codex', 'daemon-idle-listener-failed', { err: String(error) }); }
    }
  };
  const events = (async function* () {
    try { for await (const event of run.events) yield event; }
    finally { release(); }
  })();
  const stop: AgentRun['stop'] = async (reason) => {
    try { await run.stop(reason); } finally { release(); }
  };
  const waitForExit: AgentRun['waitForExit'] = async (timeoutMs) => {
    const exited = await run.waitForExit(timeoutMs);
    if (exited) release();
    return exited;
  };
  return new Proxy(run, {
    get(target, property) {
      if (property === 'events') return events;
      if (property === 'stop') return stop;
      if (property === 'waitForExit') return waitForExit;
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/**
 * Ensure the official Codex app-server daemon is alive. The daemon owns
 * background memory work; individual Bridge runs attach through a proxy.
 */
export function ensureCodexAppServerDaemon(input: {
  binary: string;
  env: NodeJS.ProcessEnv;
  cwd?: string;
  timeoutMs?: number;
  restart?: boolean;
  /** Digest of the launch environment; see {@link daemonEnvironmentFingerprint}. */
  fingerprint?: string;
}): Promise<CodexAppServerDaemonStatus> {
  const key = daemonKey(input);
  const existing = inFlight.get(key);
  if (existing) return existing;

  const pending = checkOrStart(input).finally(() => {
    if (inFlight.get(key) === pending) inFlight.delete(key);
  });
  inFlight.set(key, pending);
  return pending;
}

async function checkOrStart(input: {
  binary: string;
  env: NodeJS.ProcessEnv;
  cwd?: string;
  timeoutMs?: number;
  restart?: boolean;
  fingerprint?: string;
}): Promise<CodexAppServerDaemonStatus> {
  const timeoutMs = input.timeoutMs ?? COMMAND_TIMEOUT_MS;
  const current = await runDaemonCommand(input, ['app-server', 'daemon', 'version'], timeoutMs);
  const recorded = await readFingerprint(input.env);
  if (current.exitCode === 0) {
    const status = parseDaemonStatus(current.stdout, current.stderr);
    // A daemon started before fingerprints existed is adopted as-is.
    const stale = Boolean(input.fingerprint && recorded && recorded !== input.fingerprint);
    const key = daemonKey(input);
    const busy = (attached.get(key) ?? 0) > 0
      || ((stale || Boolean(input.restart)) && await liveRunHosts(codexDaemonHostTag(input)) > 0);
    // Restarting the shared daemon would end every attached run, whatever the reason.
    if (status && (stale || input.restart) && busy) {
      if (!deferredLogged.has(`${key}\0${input.fingerprint}\0${input.restart}`)) {
        deferredLogged.add(`${key}\0${input.fingerprint}\0${input.restart}`);
        log.warn('codex', 'app-server-daemon-restart-deferred', { attachedRuns: attached.get(key),
          reason: input.restart ? 'provider' : 'environment', action: 'restart-when-idle' });
      }
      return { ...status, restartDeferred: true };
    }
    if (status && !stale && !input.restart) {
      if (!recorded && input.fingerprint) await writeFingerprint(input.env, input.fingerprint);
      return status;
    }
    if (stale) log.info('codex', 'app-server-daemon-env-changed', { action: 'restart' });
    if (status && (input.restart || stale)) {
      const stopped = await runDaemonCommand(input, ['app-server', 'daemon', 'stop'], timeoutMs);
      if (stopped.exitCode !== 0) throw new Error(`Codex app-server daemon failed to stop${formatCommandFailure(stopped)}`);
    }
  }

  const started = await runDaemonCommand(input, ['app-server', 'daemon', 'start'], timeoutMs);
  if (started.exitCode !== 0) {
    throw new Error(
      `Codex app-server daemon failed to start${formatCommandFailure(started)}`,
    );
  }

  const verified = await runDaemonCommand(input, ['app-server', 'daemon', 'version'], timeoutMs);
  if (verified.exitCode !== 0) {
    throw new Error(
      `Codex app-server daemon did not become ready${formatCommandFailure(verified)}`,
    );
  }
  const status = parseDaemonStatus(verified.stdout, verified.stderr);
  if (!status) {
    throw new Error('Codex app-server daemon returned no readable running status');
  }

  if (input.fingerprint) await writeFingerprint(input.env, input.fingerprint);
  log.info('codex', 'app-server-daemon-started', {
    pid: status.pid,
    socketPath: status.socketPath,
    cliVersion: status.cliVersion,
    appServerVersion: status.appServerVersion,
    managedCodexVersion: status.managedCodexVersion,
  });
  return status;
}

async function readFingerprint(env: NodeJS.ProcessEnv): Promise<string | undefined> {
  if (!env.CODEX_HOME) return undefined;
  return (await readFile(join(env.CODEX_HOME, FINGERPRINT_FILE), 'utf8').catch(() => '')).trim() || undefined;
}

async function writeFingerprint(env: NodeJS.ProcessEnv, fingerprint: string): Promise<void> {
  if (!env.CODEX_HOME) return;
  await writeFileAtomic(join(env.CODEX_HOME, FINGERPRINT_FILE), `${fingerprint}\n`, { mode: 0o600 })
    .catch((error) => log.warn('codex', 'app-server-daemon-fingerprint-write-failed', { err: String(error) }));
}

function parseDaemonStatus(stdout: string, stderr: string): CodexAppServerDaemonStatus | undefined {
  for (const output of [stdout, stderr]) {
    const lines = output.trim().split(/\r?\n/).reverse();
    for (const line of lines) {
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        continue;
      }
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const record = value as Record<string, unknown>;
      if (record.status !== 'running' && record.status !== 'started') continue;
      return {
        status: record.status,
        ...(typeof record.backend === 'string' ? { backend: record.backend } : {}),
        ...(typeof record.pid === 'number' ? { pid: record.pid } : {}),
        ...(typeof record.managedCodexPath === 'string' ? { managedCodexPath: record.managedCodexPath } : {}),
        ...(typeof record.managedCodexVersion === 'string' ? { managedCodexVersion: record.managedCodexVersion } : {}),
        ...(typeof record.socketPath === 'string' ? { socketPath: record.socketPath } : {}),
        ...(typeof record.cliVersion === 'string' ? { cliVersion: record.cliVersion } : {}),
        ...(typeof record.appServerVersion === 'string' ? { appServerVersion: record.appServerVersion } : {}),
      };
    }
  }
  return undefined;
}

function runDaemonCommand(input: {
  binary: string;
  env: NodeJS.ProcessEnv;
  cwd?: string;
}, args: string[], timeoutMs: number): Promise<DaemonCommandResult> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawnProcess(input.binary, args, {
        ...(input.cwd ? { cwd: input.cwd } : {}),
        env: input.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      reject(new Error(`failed to spawn ${input.binary}: ${errorMessage(error)}`));
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      fn();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminateChild(child, 'SIGTERM');
      killTimer = setTimeout(() => {
        terminateChild(child, 'SIGKILL');
        finish(() => reject(new Error(
          `codex app-server daemon command timed out after ${timeoutMs}ms${formatOutputSuffix(stdout, stderr)}`,
        )));
      }, 1000);
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout = appendLimited(stdout, chunk.toString('utf8'));
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = appendLimited(stderr, chunk.toString('utf8'));
    });
    child.once('error', (error) => {
      finish(() => reject(new Error(`codex app-server daemon command failed: ${error.message}`)));
    });
    child.once('close', (exitCode, signal) => {
      finish(() => {
        if (timedOut) {
          reject(new Error(
            `codex app-server daemon command timed out after ${timeoutMs}ms${formatOutputSuffix(stdout, stderr)}`,
          ));
          return;
        }
        resolve({ exitCode, signal, stdout, stderr });
      });
    });
  });
}

function appendLimited(current: string, chunk: string): string {
  const combined = current + chunk;
  return combined.length > OUTPUT_LIMIT ? combined.slice(-OUTPUT_LIMIT) : combined;
}

function formatCommandFailure(result: DaemonCommandResult): string {
  if (result.signal) return ` (signal ${result.signal})${formatOutputSuffix(result.stdout, result.stderr)}`;
  return ` (exit ${result.exitCode ?? 'unknown'})${formatOutputSuffix(result.stdout, result.stderr)}`;
}

function formatOutputSuffix(stdout: string, stderr: string): string {
  const output = (stderr.trim() || stdout.trim()).replace(/\s+/g, ' ').slice(-1000);
  return output ? `: ${output}` : '';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
