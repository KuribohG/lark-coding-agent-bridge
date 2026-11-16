import type { Readable, Writable } from 'node:stream';
import { log } from '../../core/logger';
import { mergeProcessEnv, spawnProcess, type SpawnedProcessByStdio } from '../../platform/spawn';
import { terminateChild } from '../../platform/terminate';
import { readJsonLines } from '../jsonl';
import { parseSshWorkcell, SshWorkcellProvider } from './workcell-ssh';

/**
 * Bridge side of the workcell provider protocol.
 *
 * A provider is an executable that rents isolated execution units: the bridge
 * starts it once per pool and drives it with newline-delimited JSON. The
 * repository defines only this protocol; which infrastructure fulfils it is the
 * provider's business.
 *
 *   bridge -> provider  { id, op, ...params }
 *   provider -> bridge  { id, ok: true, data } | { id, ok: false, error }
 *                       { type: 'log', workcell?, line }
 *                       { type: 'exit', workcell?, code }
 */

export type WorkcellOp =
  | 'create'
  | 'push'
  | 'pull'
  | 'exec'
  | 'forward'
  | 'ttl'
  | 'stop';

export interface WorkcellCreateParams {
  image?: string;
  cpu?: number;
  memoryGb?: number;
  ttlSeconds?: number;
  network?: readonly ('lan' | 'www')[];
  /** Free-form labels the provider may use for naming or accounting. */
  labels?: Record<string, string>;
}

export interface WorkcellPushParams {
  workcell: string;
  local: string;
  remote: string;
  exclude?: readonly string[];
}

export interface WorkcellPullParams {
  workcell: string;
  remote: string;
  local: string;
}

export interface WorkcellExecParams {
  workcell: string;
  /** Shell script; providers run it through `bash` unless documented otherwise. */
  script: string;
  env?: Readonly<Record<string, string>>;
  detach?: boolean;
  cwd?: string;
  /** Seconds for a non-detached command; providers apply their own default. */
  timeout?: number;
}

export interface WorkcellForwardParams {
  workcell: string;
  /** Port the bridge wants to reach inside the workcell. */
  remotePort: number;
}

export interface WorkcellProviderFrame {
  type: string;
  workcell?: string;
  [key: string]: unknown;
}

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  op: string;
};

const CONNECT_TIMEOUT_MS = 30_000;
/** Uploads and pulls move whole trees; they may take minutes on a slow link. */
const TRANSFER_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_TIMEOUT_MS: Partial<Record<WorkcellOp, number>> = {
  create: 5 * 60_000,
  push: TRANSFER_TIMEOUT_MS,
  pull: TRANSFER_TIMEOUT_MS,
  exec: 5 * 60_000,
  forward: CONNECT_TIMEOUT_MS,
  ttl: 60_000,
  stop: 180_000,
};

/**
 * What the pool needs from a provider, whether it is an external program or a
 * builtin (`ssh://`, `local://`). Ops and params are the protocol above.
 */
export interface WorkcellProvider {
  readonly isClosed: boolean;
  request<T = unknown>(op: WorkcellOp, params?: Record<string, unknown>, timeoutMs?: number): Promise<T>;
  close(): Promise<void>;
}

class WorkcellProviderClient implements WorkcellProvider {
  private child: SpawnedProcessByStdio<Writable, Readable, Readable> | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Set<(frame: WorkcellProviderFrame) => void>();
  private closed: Error | undefined;
  private disposed = false;
  private starting: Promise<void> | undefined;

  constructor(private readonly options: {
    /** Provider executable. */
    command: string;
    args?: readonly string[];
    env?: NodeJS.ProcessEnv;
    /** Prefix for frames the provider streams without a request id. */
    onFrame?: (frame: WorkcellProviderFrame) => void;
  }) {
    if (options.onFrame) this.listeners.add(options.onFrame);
  }

  get isClosed(): boolean {
    return this.closed !== undefined;
  }

  async request<T = unknown>(op: WorkcellOp, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
    await this.start();
    const child = this.child!;
    const id = this.nextId++;
    const timeout = timeoutMs ?? DEFAULT_TIMEOUT_MS[op] ?? 60_000;
    const frame = JSON.stringify({ id, op, ...params });
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`workcell provider ${op} timed out after ${timeout}ms`));
      }, timeout);
      timer.unref?.();
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer, op });
      child.stdin.write(`${frame}\n`, (error) => {
        if (!error) return;
        this.settle(id, undefined, error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  async close(): Promise<void> {
    return this.dispose();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const child = this.child;
    if (!child) return;
    if (child.exitCode === null && child.signalCode === null) {
      terminateChild(child, 'SIGTERM');
    }
    this.fail(new Error('workcell provider disposed'));
  }

  private start(): Promise<void> {
    if (this.closed) return Promise.reject(this.closed);
    this.starting ??= this.spawn().catch((error) => {
      this.starting = undefined;
      throw error;
    });
    return this.starting;
  }

  private async spawn(): Promise<void> {
    const env = mergeProcessEnv(process.env, this.options.env);
    log.info('agent', 'workcell-provider-spawn', { command: this.options.command });
    const child = spawnProcess(this.options.command, [...(this.options.args ?? [])], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as SpawnedProcessByStdio<Writable, Readable, Readable>;
    this.child = child;
    child.stdin.on('error', (error) => {
      log.warn('agent', 'workcell-provider-stdin-error', { message: error.message });
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-4000);
      for (const line of chunk.split('\n')) {
        if (line.trim()) log.info('agent', 'workcell-provider-stderr', { line });
      }
    });
    child.on('exit', (code, signal) => {
      this.fail(new Error(
        `workcell provider exited (code=${String(code)}, signal=${String(signal)})` +
        (stderr.trim() ? `: ${stderr.trim().slice(-500)}` : ''),
      ));
    });
    void this.readFrames(child);
  }

  private async readFrames(child: SpawnedProcessByStdio<Writable, Readable, Readable>): Promise<void> {
    try {
      for await (const line of readJsonLines(child.stdout)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let frame: WorkcellProviderFrame;
        try {
          frame = JSON.parse(trimmed) as WorkcellProviderFrame;
        } catch {
          log.warn('agent', 'workcell-provider-bad-frame', { line: trimmed.slice(0, 300) });
          continue;
        }
        this.handleFrame(frame);
      }
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private handleFrame(frame: WorkcellProviderFrame): void {
    if (typeof frame.id === 'number') {
      const ok = frame.ok === true;
      this.settle(frame.id, ok ? frame.data : undefined, ok ? undefined : new Error(frameError(frame.error)));
      return;
    }
    if (frame.type === 'log') {
      log.info('agent', 'workcell-log', { workcell: frame.workcell, line: frame.line });
      return;
    }
    if (frame.type === 'exit') {
      log.info('agent', 'workcell-exit', { workcell: frame.workcell, code: frame.code });
    }
    for (const listener of [...this.listeners]) {
      try {
        listener(frame);
      } catch (error) {
        log.warn('agent', 'workcell-provider-listener-failed', { error: String(error) });
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
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`workcell provider unavailable while waiting for ${pending.op}: ${error.message}`));
      this.pending.delete(id);
    }
  }
}

/**
 * Choose the provider behind `pi.workcell.provider`: a builtin scheme, or an
 * executable that speaks the protocol above.
 */
export function createWorkcellProvider(provider: string, env?: NodeJS.ProcessEnv): WorkcellProvider {
  const ssh = parseSshWorkcell(provider);
  if (ssh) return new SshWorkcellProvider(ssh);
  if (provider.includes('://')) {
    throw new Error(`pi.workcell.provider: unknown scheme in ${provider} (supported: ssh://, or a provider executable)`);
  }
  return new WorkcellProviderClient({ command: provider, ...(env ? { env } : {}) });
}

function frameError(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const record = value as { message?: unknown; error?: unknown };
    if (typeof record.message === 'string') return record.message;
    if (typeof record.error === 'string') return record.error;
  }
  return JSON.stringify(value) ?? 'workcell provider request failed';
}
