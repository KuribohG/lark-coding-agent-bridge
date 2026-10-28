import type { ChildProcess } from 'node:child_process';
import { log } from '../../core/logger';
import { spawnProcess } from '../../platform/spawn';
import { terminateChild } from '../../platform/terminate';

const COMMAND_TIMEOUT_MS = 30_000;
const OUTPUT_LIMIT = 32_000;

export interface CodexAppServerDaemonStatus {
  status: 'running' | 'started';
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

/**
 * Ensure the official Codex app-server daemon is alive. The daemon owns
 * background memory work; individual Bridge runs attach through a proxy.
 */
export function ensureCodexAppServerDaemon(input: {
  binary: string;
  env: NodeJS.ProcessEnv;
  cwd?: string;
  timeoutMs?: number;
}): Promise<CodexAppServerDaemonStatus> {
  const key = `${input.binary}\0${input.env.CODEX_HOME ?? '<default-codex-home>'}`;
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
}): Promise<CodexAppServerDaemonStatus> {
  const timeoutMs = input.timeoutMs ?? COMMAND_TIMEOUT_MS;
  const current = await runDaemonCommand(input, ['app-server', 'daemon', 'version'], timeoutMs);
  if (current.exitCode === 0) {
    const status = parseDaemonStatus(current.stdout, current.stderr);
    if (status) return status;
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

  log.info('codex', 'app-server-daemon-started', {
    pid: status.pid,
    socketPath: status.socketPath,
    cliVersion: status.cliVersion,
    appServerVersion: status.appServerVersion,
    managedCodexVersion: status.managedCodexVersion,
  });
  return status;
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
