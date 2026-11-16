import { EventEmitter } from 'node:events';
import { connect as connectSocket, type Socket } from 'node:net';
import { PassThrough, Writable } from 'node:stream';
import { log } from '../../core/logger';

/**
 * Bridge side of `bin/cell-host.mjs`: the agent runs in a rented cell and is
 * driven over one framed TCP connection. The child surface mimics a spawned
 * process, because that is what every CLI adapter already talks to.
 */

export interface CellTarget {
  host: string;
  port: number;
  /** Files the agent expects on disk before it starts (prompt, MCP config). */
  files?: readonly { path: string; content: string }[];
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  op: string;
}

const CONNECT_TIMEOUT_MS = 30_000;

export class CellConnection {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Set<(frame: Record<string, unknown>) => void>();
  private closed: Error | undefined;

  private constructor(private readonly socket: Socket) {}

  static async connect(target: CellTarget, timeoutMs = CONNECT_TIMEOUT_MS): Promise<CellConnection> {
    const socket = await new Promise<Socket>((resolve, reject) => {
      const attempt = connectSocket({ host: target.host, port: target.port });
      const timer = setTimeout(() => {
        attempt.destroy();
        reject(new Error(`cell host did not accept a connection at ${target.host}:${target.port}`));
      }, timeoutMs);
      timer.unref?.();
      attempt.once('connect', () => { clearTimeout(timer); resolve(attempt); });
      attempt.once('error', (error) => { clearTimeout(timer); reject(error); });
    });
    socket.setEncoding('utf8');
    const connection = new CellConnection(socket);
    connection.read();
    log.info('agent', 'cell-connected', { host: target.host, port: target.port });
    return connection;
  }

  get isClosed(): boolean {
    return this.closed !== undefined;
  }

  onFrame(listener: (frame: Record<string, unknown>) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  send(frame: Record<string, unknown>): void {
    if (this.socket.destroyed) return;
    this.socket.write(`${JSON.stringify(frame)}\n`);
  }

  async request<T = unknown>(op: string, params: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<T> {
    if (this.closed) throw this.closed;
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`cell host request ${op} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer, op });
      this.socket.write(`${JSON.stringify({ id, op, ...params })}\n`, (error) => {
        if (!error) return;
        this.settle(id, undefined, error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  async close(): Promise<void> {
    if (this.socket.destroyed) return;
    this.socket.end();
    this.socket.destroy();
    this.fail(new Error('cell connection closed'));
  }

  private read(): void {
    let buffer = '';
    this.socket.on('data', (chunk: string) => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf('\n');
        if (newline === -1) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        let frame: Record<string, unknown>;
        try {
          frame = JSON.parse(line) as Record<string, unknown>;
        } catch {
          log.warn('agent', 'cell-bad-frame', { line: line.slice(0, 200) });
          continue;
        }
        this.dispatch(frame);
      }
    });
    this.socket.on('close', () => this.fail(new Error('cell connection closed')));
    this.socket.on('error', (error) => this.fail(error));
  }

  private dispatch(frame: Record<string, unknown>): void {
    if (typeof frame.id === 'number') {
      this.settle(frame.id, frame.ok === true ? frame.data : undefined, frame.ok === true ? undefined : new Error(String(frame.error ?? 'cell request failed')));
      return;
    }
    for (const listener of [...this.listeners]) {
      try {
        listener(frame);
      } catch (error) {
        log.warn('agent', 'cell-listener-failed', { error: String(error) });
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
      pending.reject(new Error(`cell unavailable while waiting for ${pending.op}: ${error.message}`));
      this.pending.delete(id);
    }
  }
}

/**
 * A process living in the cell, exposed with the surface adapters use from a
 * spawned child: `stdin`, `stdout`, `stderr`, `pid`, `kill`, `exit` events.
 */
export class CellChild extends EventEmitter {
  readonly stdin: Writable;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  pid: number | undefined;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  private connection!: Promise<CellConnection>;

  constructor(
    target: CellTarget,
    private readonly spawnArgs: { argv: readonly string[]; cwd?: string; env?: NodeJS.ProcessEnv },
  ) {
    super();
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        this.connection.then((connection) => connection.request('stdin', { data: chunk.toString('utf8') }))
          .then(() => callback(), (error: Error) => callback(error));
      },
      final: (callback) => {
        this.connection.then((connection) => connection.request('close'))
          .then(() => callback(), () => callback());
      },
    });
    this.stdin.on('error', () => {});
    this.open(target);
  }

  /** Programmatic kill, like `child.kill(signal)`. */
  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    void this.connection
      .then((connection) => connection.request(signal === 'SIGKILL' ? 'kill' : 'signal', { signal }))
      .catch((error: unknown) => log.warn('agent', 'cell-kill-failed', { error: String(error) }));
    return true;
  }

  private open(target: CellTarget): void {
    this.connection = CellConnection.connect(target).then(async (connection) => {
      connection.onFrame((frame) => this.onFrame(frame));
      const spawned = await connection.request<{ pid: number | null }>('spawn', {
        argv: [...this.spawnArgs.argv],
        ...(this.spawnArgs.cwd ? { cwd: this.spawnArgs.cwd } : {}),
        ...(this.spawnArgs.env ? { env: this.spawnArgs.env } : {}),
        ...(target.files ? { files: [...target.files] } : {}),
      });
      this.pid = spawned.pid ?? undefined;
      return connection;
    });
    this.connection.catch((error: Error) => {
      log.warn('agent', 'cell-start-failed', { error: error.message });
      this.stderr.write(`${error.message}\n`);
      this.exitCode = 1;
      this.stdout.end();
      this.stderr.end();
      this.emit('exit', 1, null);
    });
  }

  private onFrame(frame: Record<string, unknown>): void {
    switch (frame.type) {
      case 'out':
        this.stdout.write(String(frame.data ?? ''));
        return;
      case 'err':
        this.stderr.write(String(frame.data ?? ''));
        return;
      case 'exit': {
        const code = typeof frame.code === 'number' ? frame.code : null;
        const signal = typeof frame.signal === 'string' ? frame.signal as NodeJS.Signals : null;
        this.exitCode = code;
        this.signalCode = signal;
        this.stdout.end();
        this.stderr.end();
        this.emit('exit', code, signal);
        return;
      }
      default:
        return;
    }
  }
}
