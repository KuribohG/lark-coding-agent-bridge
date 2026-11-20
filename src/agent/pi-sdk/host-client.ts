import { connect as connectSocket, type Socket } from 'node:net';
import type { Readable, Writable } from 'node:stream';
import { log } from '../../core/logger';
import { mergeProcessEnv, spawnProcess, type SpawnedProcessByStdio } from '../../platform/spawn';
import { terminateChild } from '../../platform/terminate';
import { readJsonLines } from '../jsonl';
import { remoteHostSpawn, sweepRemoteEnvFiles, type PiRemoteTarget } from './remote';
import { piHostSpawnCommand, type PiHostSandbox } from './sandbox';

export type PiHostChild = SpawnedProcessByStdio<Writable, Readable, Readable>;

export interface PiHostLaunch {
  nodePath: string;
  hostScript: string;
  sdkPath: string;
  agentDir: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  idleTtlMs?: number;
  maxSessions?: number;
  sessionPersistence?: 'file' | 'memory';
  /** Profile-scoped Landlock domain applied to this long-lived host. */
  sandbox?: PiHostSandbox;
  /** Run the host on another machine over ssh instead of locally. */
  remote?: PiRemoteTarget;
  /**
   * Reach an already-running host over a forwarded TCP port instead of
   * spawning one. The host serves the same frames on the socket.
   */
  connection?: { kind: 'tcp'; host: string; port: number };
  /** Milliseconds to wait for the host ready frame. */
  readyTimeoutMs?: number;
}

export interface PiHostReady {
  pid: number;
  nodeVersion: string;
  piVersion: string;
  agentDir: string;
  idleTtlMs: number;
  maxSessions: number;
  sessionPersistence: 'file' | 'memory';
}

export interface PiHostFrame {
  type: string;
  [key: string]: unknown;
}

export interface PiHostSessionInfo {
  sessionId: string;
  sessionFile: string | null;
  model: string | null;
}

export interface PiHostRunAck {
  sessionId: string;
  runId: string;
}

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  command: string;
};

/** How the bridge reaches a host: a child's stdio or a forwarded TCP socket. */
interface HostChannel {
  readonly pid: number | undefined;
  readonly closed: boolean;
  write(line: string, callback?: (error?: Error | null) => void): void;
  lines(): AsyncIterable<Buffer | string>;
  close(): Promise<void>;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Bridge side of the pi-host transport: one long-lived host speaking
 * newline-delimited JSON, over a child's stdio or a forwarded TCP socket.
 * Requests are correlated by numeric id; everything without an id is a stream
 * frame delivered to subscribers.
 */
export class PiHostClient {
  private channel: HostChannel | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly listeners = new Set<(frame: PiHostFrame) => void>();
  private ready: Promise<PiHostReady> | undefined;
  private closed: Error | undefined;
  private disposed = false;

  constructor(private readonly launch: PiHostLaunch) {}

  get isClosed(): boolean {
    return this.closed !== undefined;
  }

  get exitError(): Error | undefined {
    return this.closed;
  }

  async start(): Promise<PiHostReady> {
    if (this.closed) throw this.closed;
    if (!this.ready) {
      this.ready = this.spawn().catch((error) => {
        this.ready = undefined;
        throw error;
      });
    }
    return this.ready;
  }

  /** Write one frame without a request id (answers to `ipc.request`, for example). */
  send(frame: Record<string, unknown>): void {
    const channel = this.channel;
    if (!channel || channel.closed) return;
    channel.write(`${JSON.stringify(frame)}\n`);
  }

  onFrame(listener: (frame: PiHostFrame) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async request<T = unknown>(
    cmd: string,
    params: Record<string, unknown> = {},
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<T> {
    const channel = await this.ensureChannel();
    const id = this.nextId++;
    const frame = JSON.stringify({ id, cmd, params });
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`pi sdk host request ${cmd} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
        command: cmd,
      });
      channel.write(`${frame}\n`, (error) => {
        if (!error) return;
        this.settle(id, undefined, error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const channel = this.channel;
    if (!channel) return;
    try {
      await this.request('shutdown', {}, 2000);
    } catch {
      // Host already gone or not responding; fall through to teardown.
    }
    await channel.close();
    this.fail(new Error('pi sdk host disposed'));
  }

  private async ensureChannel(): Promise<HostChannel> {
    await this.start();
    if (!this.channel) throw this.closed ?? new Error('pi sdk host is not running');
    if (this.channel.closed) throw new Error('pi sdk host channel is closed');
    return this.channel;
  }

  private async spawn(): Promise<PiHostReady> {
    // The channel first: a connection failure must reject this call, not a
    // promise nobody awaits.
    if (!this.launch.connection) {
      this.channel = this.spawnStdio();
      const ready = this.readySignal();
      void this.readFrames(this.channel);
      return ready;
    }
    // A forwarded port accepts a connection before the host inside is
    // listening, and a slow unit may need a few seconds of retries.
    const attempts = 6;
    let lastError: Error = new Error('pi sdk host did not accept a connection');
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        this.channel = await this.connectTcp(this.launch.connection);
        const ready = this.readySignal();
        void this.readFrames(this.channel);
        return await ready;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        this.readyResolve = undefined;
        this.readyReject = undefined;
        if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
      }
    }
    throw new Error(`pi sdk host is unreachable at ${this.launch.connection.host}:${this.launch.connection.port} after ${attempts} attempts: ${lastError.message}`);
  }

  /** The host announces itself on every new connection, so reconnects reuse this. */
  private readySignal(): Promise<PiHostReady> {
    const launch = this.launch;
    return new Promise<PiHostReady>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`pi sdk host did not become ready within ${launch.readyTimeoutMs ?? 30_000}ms`));
      }, launch.readyTimeoutMs ?? 30_000);
      timer.unref?.();
      this.readyResolve = (value) => {
        clearTimeout(timer);
        resolve(value);
      };
      this.readyReject = (error) => {
        clearTimeout(timer);
        reject(error);
      };
    });
  }

  private async connectTcp(connection: { host: string; port: number }): Promise<HostChannel> {
    const socket: Socket = await new Promise((resolve, reject) => {
      const attempt = connectSocket({ host: connection.host, port: connection.port });
      const timer = setTimeout(() => {
        attempt.destroy();
        reject(new Error(`pi sdk host did not accept a connection at ${connection.host}:${connection.port}`));
      }, this.launch.readyTimeoutMs ?? 30_000);
      timer.unref?.();
      attempt.once('connect', () => {
        clearTimeout(timer);
        resolve(attempt);
      });
      attempt.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    socket.setEncoding('utf8');
    log.info('agent', 'pi-sdk-host-tcp-connect', { host: connection.host, port: connection.port });
    // A dropped connection is not a dead host: the sessions stay and the next
    // connection resumes them, so only report it as an error to in-flight work.
    socket.on('close', () => this.fail(new Error('pi sdk host connection closed')));
    return {
      pid: undefined,
      closed: false,
      write(line, callback) {
        if (socket.destroyed) { callback?.(new Error('pi sdk host connection is closed')); return; }
        socket.write(line, (error) => callback?.(error ?? undefined));
      },
      lines: () => socket,
      close: async () => {
        socket.end();
        socket.destroy();
      },
    };
  }

  private spawnStdio(): HostChannel {
    const { launch } = this;
    const args = [
      launch.hostScript,
      '--sdk', launch.sdkPath,
      '--agent-dir', launch.agentDir,
      ...(launch.idleTtlMs !== undefined ? ['--idle-ttl-ms', String(launch.idleTtlMs)] : []),
      ...(launch.maxSessions !== undefined ? ['--max-sessions', String(launch.maxSessions)] : []),
      ...(launch.sessionPersistence ? ['--session-persistence', launch.sessionPersistence] : []),
    ];
    const hostEnv = {
      ...launch.env,
      PI_SKIP_VERSION_CHECK: '1',
      PI_TELEMETRY: '0',
    };
    const env = mergeProcessEnv(process.env, hostEnv);
    const local = launch.remote
      ? undefined
      : piHostSpawnCommand(launch.nodePath, args, launch.sandbox, env);
    const remote = launch.remote
      ? remoteHostSpawn(launch.remote, {
        nodePath: launch.nodePath,
        hostScript: launch.hostScript,
        args: args.slice(1),
        ...(launch.cwd ? { cwd: launch.cwd } : {}),
        env: hostEnv,
      })
      : undefined;
    if (remote) sweepRemoteEnvFiles(launch.remote!.stateDir);
    let child: PiHostChild;
    try {
      child = spawnProcess(local?.command ?? remote!.command, local?.args ?? remote!.args, {
        // The remote shell does the cd; a local cwd on ssh would be meaningless.
        ...(local ? { cwd: launch.cwd } : {}),
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      }) as PiHostChild;
    } catch (error) {
      remote?.cleanup();
      throw error;
    }
    child.once('exit', () => remote?.cleanup());
    child.once('error', () => remote?.cleanup());
    log.info('agent', 'pi-sdk-host-spawn', {
      pid: child.pid ?? null,
      nodePath: launch.nodePath,
      sdkPath: launch.sdkPath,
      agentDir: launch.agentDir,
      sandboxed: local?.sandboxed ?? false,
      ...(local?.sandboxed && launch.sandbox ? { sandboxRoots: launch.sandbox.roots } : {}),
      ...(launch.remote ? { remote: launch.remote.destination, envFile: remote?.envFile } : {}),
    });

    let stderrBuffer = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBuffer += chunk.toString('utf8');
      for (;;) {
        const newline = stderrBuffer.indexOf('\n');
        if (newline === -1) break;
        const line = stderrBuffer.slice(0, newline);
        stderrBuffer = stderrBuffer.slice(newline + 1);
        if (line.trim()) log.info('agent', 'pi-sdk-host-stderr', { line });
      }
    });
    child.stdin.on('error', (error) => {
      log.warn('agent', 'pi-sdk-host-stdin-error', { message: error.message });
    });
    child.on('exit', (code, signal) => {
      log.info('agent', 'pi-sdk-host-exit', { pid: child.pid ?? null, code, signal });
      const error = new Error(
        `pi sdk host exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})` +
        (stderrBuffer.trim() ? `: ${stderrBuffer.trim().slice(0, 500)}` : ''),
      );
      this.fail(error);
    });

    let closed = false;
    child.once('exit', () => { closed = true; });
    return {
      pid: child.pid,
      get closed() { return closed; },
      write(line, callback) {
        if (!child.stdin.writable) { callback?.(new Error('pi sdk host stdin is closed')); return; }
        child.stdin.write(line, (error) => callback?.(error ?? undefined));
      },
      lines: () => child.stdout,
      close: async () => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        terminateChild(child, 'SIGTERM');
        const exited = await waitForExit(child, 2000);
        if (!exited) terminateChild(child, 'SIGKILL');
      },
    };
  }

  private readyResolve: ((value: PiHostReady) => void) | undefined;
  private readyReject: ((error: Error) => void) | undefined;

  private async readFrames(channel: HostChannel): Promise<void> {
    try {
      for await (const line of readJsonLines(channel.lines())) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let frame: unknown;
        try {
          frame = JSON.parse(trimmed);
        } catch {
          log.warn('agent', 'pi-sdk-host-bad-frame', { line: trimmed.slice(0, 300) });
          continue;
        }
        if (!frame || typeof frame !== 'object') continue;
        this.handleFrame(frame as PiHostFrame);
      }
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private handleFrame(frame: PiHostFrame): void {
    if (typeof frame.id === 'number') {
      const ok = frame.ok === true;
      const payload = ok ? frame.data : frame.error;
      this.settle(frame.id, ok ? payload : undefined, ok ? undefined : new Error(frameErrorText(payload)));
      return;
    }
    if (frame.type === 'host.ready') {
      this.readyResolve?.(frame.data as PiHostReady);
      this.readyResolve = undefined;
      this.readyReject = undefined;
      return;
    }
    if (frame.type === 'host.fatal') {
      const error = new Error(`pi sdk host failed: ${frameErrorText(frame.error)}`);
      this.readyReject?.(error);
      this.readyResolve = undefined;
      this.readyReject = undefined;
      this.fail(error);
      return;
    }
    for (const listener of [...this.listeners]) {
      try {
        listener(frame);
      } catch (error) {
        log.warn('agent', 'pi-sdk-host-listener-failed', { error: String(error) });
      }
    }
  }

  private settle(id: number, value: unknown, error: Error | undefined): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (error) pending.reject(error);
    else pending.resolve(value);
  }

  private fail(error: Error): void {
    if (!this.closed) this.closed = error;
    this.readyReject?.(error);
    this.readyResolve = undefined;
    this.readyReject = undefined;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`pi sdk host unavailable while waiting for ${pending.command}: ${error.message}`));
      this.pending.delete(id);
    }
    for (const listener of [...this.listeners]) {
      try {
        listener({ type: 'host.exit', error: error.message });
      } catch {
        // Listener failures must not mask the host failure.
      }
    }
  }
}

function frameErrorText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const record = value as { message?: unknown; error?: unknown };
    if (typeof record.message === 'string') return record.message;
    if (typeof record.error === 'string') return record.error;
  }
  return JSON.stringify(value) ?? 'unknown error';
}

function waitForExit(child: PiHostChild, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit);
      resolve(false);
    }, timeoutMs);
    const onExit = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once('exit', onExit);
  });
}
