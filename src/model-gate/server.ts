import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, unlinkSync } from 'node:fs';
import type { Socket } from 'node:net';
import { log } from '../core/logger';
import { bucketFor, type ModelGateConfig } from './config';
import { GateBucket, type GateBucketStats, type GatePermit } from './limiter';

/**
 * The bridge-wide model gate: one HTTP server on a Unix socket (a named pipe on
 * Windows) that every agent process asks for a permit before it calls its model
 * provider.
 *
 * It lives beside the supervisors, not inside a workflow: a provider quota is
 * shared by every run of every profile, so the counter must be shared too. Two
 * bridge processes on one machine find the same socket; the first owns it and
 * the second logs in to the same buckets, which is the behaviour a shared quota
 * wants.
 */

interface ModelGateServerOptions {
  socketPath: string;
  config: ModelGateConfig;
  /** Injected clock; tests drive it together with {@link ModelGateServer.pump}. */
  now?: () => number;
  /** How often the queue is re-examined while someone waits; 0 disables the timer (tests). */
  tickMs?: number;
  /** Providers kept as separate buckets; past this they share one overflow bucket. */
  maxBuckets?: number;
}

const BODY_LIMIT_BYTES = 4096;
const MAX_BUCKETS = 64;
const STATUS_INTERVAL_MS = 60_000;

export class ModelGateServer {
  private readonly buckets = new Map<string, GateBucket>();
  private readonly permits = new Map<string, string>();
  private server?: Server;
  private timer?: NodeJS.Timeout;
  private sweeper?: NodeJS.Timeout;
  private statusAt = 0;
  private readonly now: () => number;
  private readonly tickMs: number;
  private readonly maxBuckets: number;
  private config: ModelGateConfig;
  private closed = false;
  /** False when another bridge already served this socket; this instance only borrows it. */
  ownsSocket = false;

  constructor(private readonly options: ModelGateServerOptions) {
    this.config = options.config;
    this.now = options.now ?? Date.now;
    this.tickMs = options.tickMs ?? 25;
    this.maxBuckets = options.maxBuckets ?? MAX_BUCKETS;
    this.ensureBucket('unknown');
  }

  async start(): Promise<void> {
    if (this.server) return;
    if (await socketAlive(this.options.socketPath)) {
      // Another bridge owns the quota; share its buckets rather than splitting them.
      this.ownsSocket = false;
      log.info('model-gate', 'reuse-existing', { socket: this.options.socketPath });
      return;
    }
    unlinkQuietly(this.options.socketPath);
    const server = createServer((req, res) => { void this.handle(req, res); });
    server.on('error', err => log.warn('model-gate', 'server-error', { err: String(err) }));
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error): void => { server.off('listening', onListening); reject(err); };
        const onListening = (): void => { server.off('error', onError); resolve(); };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(this.options.socketPath);
      });
    } catch (error) {
      server.close();
      throw error;
    }
    this.server = server;
    this.ownsSocket = true;
    this.sweeper = setInterval(() => this.sweep(), 1000);
    this.sweeper.unref?.();
    log.info('model-gate', 'started', { socket: this.options.socketPath, providers: Object.keys(this.config.providers) });
  }

  async stop(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = undefined;
    for (const bucket of this.buckets.values()) bucket.close();
    this.buckets.clear();
    this.permits.clear();
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (this.ownsSocket) unlinkQuietly(this.options.socketPath);
    log.info('model-gate', 'stopped', { socket: this.options.socketPath });
  }

  /** Apply a changed config without dropping in-flight permits. */
  updateConfig(config: ModelGateConfig): void {
    this.config = config;
    for (const [provider, bucket] of this.buckets) bucket.configure(bucketFor(config, provider));
    this.ensurePumpTimer();
  }

  /** Every bucket's state, for `/status` and the periodic log line. */
  stats(): GateBucketStats[] {
    return [...this.buckets.values()].map(bucket => bucket.stats());
  }

  /** Re-examine every queue; the timer calls this, and tests call it directly. */
  pump(): void {
    for (const bucket of this.buckets.values()) bucket.pump();
  }

  private ensureBucket(provider: string): GateBucket {
    const existing = this.buckets.get(provider);
    if (existing) return existing;
    // Bound the map: a buggy client must not create buckets forever. Past the
    // cap, unknown providers share one bucket sized by the defaults.
    const key = this.buckets.size >= this.maxBuckets && !this.config.providers[provider] ? 'overflow' : provider;
    const reused = this.buckets.get(key);
    if (reused) return reused;
    const bucket = new GateBucket(key, bucketFor(this.config, key === 'overflow' ? key : provider), this.now);
    this.buckets.set(key, bucket);
    return bucket;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = req.url ?? '/';
      if (req.method === 'GET' && url === '/status') {
        this.writeJson(res, 200, { enabled: true, buckets: this.stats() });
        return;
      }
      if (req.method !== 'POST' || (url !== '/acquire' && url !== '/release')) {
        this.writeJson(res, 404, { error: 'not found' });
        return;
      }
      const body = await readJson(req);
      if (url === '/acquire') await this.acquire(body, res);
      else this.release(body, res);
    } catch (error) {
      if (!res.writableEnded) this.writeJson(res, 400, { error: String((error as Error)?.message ?? error) });
    }
  }

  private async acquire(body: Record<string, unknown>, res: ServerResponse): Promise<void> {
    const provider = typeof body.provider === 'string' && body.provider.trim() ? body.provider.trim().slice(0, 100) : 'unknown';
    const priority = typeof body.priority === 'number' && Number.isFinite(body.priority) ? Math.max(0, Math.min(9, body.priority)) : 0;
    const bucket = this.ensureBucket(provider);
    const controller = new AbortController();
    // The extension destroys the request when the run is aborted; that must also
    // remove the waiter, or a cancelled run would keep its place in the queue.
    res.on('close', () => { if (!res.writableEnded) controller.abort(new Error('client disconnected')); });
    const pending = bucket.acquire({
      priority,
      leaseMs: this.config.leaseSeconds * 1000,
      signal: controller.signal,
    });
    this.ensurePumpTimer();
    let permit: GatePermit;
    try {
      permit = await pending;
    } catch (error) {
      if (!res.destroyed) this.writeJson(res, 499, { error: String((error as Error)?.message ?? error) });
      return;
    }
    if (res.destroyed) {
      // Granted for a client that has already gone; do not hold the slot until the lease runs out.
      this.releasePermit(permit.id);
      return;
    }
    this.permits.set(permit.id, permit.provider);
    this.ensurePumpTimer();
    this.report();
    this.writeJson(res, 200, { permit: permit.id, provider: permit.provider, expiresAt: permit.expiresAt });
  }

  private release(body: Record<string, unknown>, res: ServerResponse): void {
    const id = typeof body.permit === 'string' ? body.permit : '';
    // Idempotent: a retried or duplicated release is not an error.
    this.writeJson(res, 200, { ok: true, released: id ? this.releasePermit(id) : false });
  }

  private releasePermit(id: string): boolean {
    const provider = this.permits.get(id);
    if (!provider) return false;
    this.permits.delete(id);
    this.buckets.get(provider)?.release(id);
    this.ensurePumpTimer();
    return true;
  }

  /** Reclaim permits of runs that died without releasing. */
  private sweep(): void {
    let expired = 0;
    for (const bucket of this.buckets.values()) expired += bucket.expire();
    if (expired > 0) {
      log.warn('model-gate', 'permit-expired', { count: expired, leaseSeconds: this.config.leaseSeconds });
      this.report(true);
      this.ensurePumpTimer();
    }
  }

  private ensurePumpTimer(): void {
    const queued = [...this.buckets.values()].some(bucket => bucket.needsPump());
    if (!queued || this.tickMs <= 0 || this.closed) {
      if (this.timer) clearInterval(this.timer);
      this.timer = undefined;
      return;
    }
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.pump();
      if (![...this.buckets.values()].some(bucket => bucket.needsPump())) {
        if (this.timer) clearInterval(this.timer);
        this.timer = undefined;
      }
    }, this.tickMs);
    this.timer.unref?.();
  }

  private report(force = false): void {
    const now = this.now();
    if (!force && now - this.statusAt < STATUS_INTERVAL_MS) return;
    this.statusAt = now;
    const stats = this.stats().filter(item => item.inflight > 0 || item.queued > 0);
    if (stats.length > 0) this.ensurePumpTimer();
    if (stats.length > 0) log.info('model-gate', 'status', { buckets: stats });
  }

  private writeJson(res: ServerResponse, status: number, payload: unknown): void {
    if (res.writableEnded || res.destroyed) return;
    const text = JSON.stringify(payload);
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
    res.end(text);
  }
}

/** True when something already listens on the socket. */
async function socketAlive(path: string): Promise<boolean> {
  if (process.platform !== 'win32' && !existsSync(path)) return false;
  const net = await import('node:net');
  return new Promise<boolean>(resolve => {
    const socket: Socket = net.connect(path);
    const done = (alive: boolean): void => { socket.destroy(); resolve(alive); };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

function unlinkQuietly(path: string): void {
  if (process.platform === 'win32') return;
  try { unlinkSync(path); } catch { /* absent or not ours */ }
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > BODY_LIMIT_BYTES) throw new Error('request body too large');
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('expected a JSON object');
  return parsed as Record<string, unknown>;
}
