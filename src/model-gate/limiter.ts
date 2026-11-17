import type { ModelGateBucketConfig } from './config';

/**
 * One provider's limits: a token bucket for request rate and a semaphore for
 * requests in flight.
 *
 * A permit is held only while the provider is answering. The extension that
 * asks for one acquires immediately before the request and releases on the
 * finalized assistant message, so a run executing tools holds nothing and
 * another run can take the slot — which is the whole point of gating here
 * rather than at the worker process.
 *
 * The bucket does not own a timer. Its owner calls {@link GateBucket.pump}
 * after acquire/release and whenever a timer fires; everything else is derived
 * from the injected clock. That keeps the accounting testable without waiting
 * on wall time.
 */

export interface GatePermit {
  id: string;
  provider: string;
  expiresAt: number;
}

export interface GateAcquireOptions {
  /** Lower runs first; 0 = interactive, 1 = workflow worker. FIFO within a class. */
  priority?: number;
  leaseMs: number;
  signal?: AbortSignal;
}

export interface GateBucketStats {
  provider: string;
  rpm: number;
  burst: number;
  concurrency: number;
  /** Tokens available now (fractional: refill is continuous). */
  tokens: number;
  inflight: number;
  queued: number;
  /** Wall-clock age of the oldest queued waiter, 0 when the queue is empty. */
  oldestWaitMs: number;
}

interface Waiter {
  seq: number;
  priority: number;
  leaseMs: number;
  enqueuedAt: number;
  grant(permit: GatePermit): void;
  reject(error: unknown): void;
  signal?: AbortSignal;
}

export class GateBucket {
  private tokens: number;
  private lastRefill: number;
  private seq = 0;
  private readonly inflight = new Map<string, { expiresAt: number; permit: GatePermit }>();
  private waiters: Waiter[] = [];
  private closed = false;

  constructor(
    readonly provider: string,
    private config: ModelGateBucketConfig,
    private readonly now: () => number,
  ) {
    this.tokens = config.burst;
    this.lastRefill = now();
  }

  /** Hot reload: keep what is in flight, retune the rest. */
  configure(config: ModelGateBucketConfig): void {
    this.refill();
    this.config = config;
    this.tokens = Math.min(this.tokens, config.burst);
    this.pump();
  }

  /**
   * Wait for a rate token and a concurrency slot, in that order: waiting for a
   * token must not occupy a slot other runs could use.
   */
  acquire(options: GateAcquireOptions): Promise<GatePermit> {
    if (this.closed) return Promise.reject(new Error('Model gate is shutting down'));
    if (options.signal?.aborted) return Promise.reject(options.signal.reason);
    return new Promise<GatePermit>((resolve, reject) => {
      const waiter: Waiter = {
        seq: this.seq++,
        priority: options.priority ?? 0,
        leaseMs: options.leaseMs,
        enqueuedAt: this.now(),
        grant: permit => { cleanup(); resolve(permit); },
        reject: error => { cleanup(); reject(error); },
        signal: options.signal,
      };
      const cleanup = (): void => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        waiter.signal?.removeEventListener('abort', abort);
      };
      const abort = (): void => waiter.reject(waiter.signal?.reason);
      waiter.signal?.addEventListener('abort', abort, { once: true });
      this.waiters.push(waiter);
      this.pump();
    });
  }

  release(permitId: string): boolean {
    if (!this.inflight.delete(permitId)) return false;
    this.pump();
    return true;
  }

  /** Reclaim permits whose run vanished without releasing; returns how many. */
  expire(): number {
    const now = this.now();
    let expired = 0;
    for (const [id, entry] of this.inflight) {
      if (entry.permit.expiresAt <= now) {
        this.inflight.delete(id);
        expired++;
      }
    }
    if (expired > 0) this.pump();
    return expired;
  }

  /** Start every waiter the current tokens and free slots allow. */
  pump(): void {
    if (this.closed) return;
    this.refill();
    while (this.inflight.size < this.config.concurrency && this.waiters.length > 0) {
      // Refill is fractional; a token reached to within rounding error is a token.
      if (this.tokens < 1 - 1e-9) break;
      const waiter = this.takeNext();
      if (!waiter) break;
      this.tokens -= 1;
      const permit: GatePermit = {
        id: `${this.provider}:${waiter.seq}`,
        provider: this.provider,
        expiresAt: this.now() + waiter.leaseMs,
      };
      this.inflight.set(permit.id, { expiresAt: permit.expiresAt, permit });
      waiter.grant(permit);
    }
  }

  /** True when a timer is needed: someone waits and nothing else will wake it. */
  needsPump(): boolean {
    return !this.closed && this.waiters.length > 0;
  }

  get queued(): number {
    return this.waiters.length;
  }

  stats(): GateBucketStats {
    this.refill();
    const now = this.now();
    const oldest = this.waiters.reduce((min, waiter) => Math.min(min, waiter.enqueuedAt), Number.POSITIVE_INFINITY);
    return {
      provider: this.provider,
      rpm: this.config.rpm,
      burst: this.config.burst,
      concurrency: this.config.concurrency,
      tokens: this.tokens,
      inflight: this.inflight.size,
      queued: this.waiters.length,
      oldestWaitMs: this.waiters.length > 0 ? Math.max(0, now - oldest) : 0,
    };
  }

  /** Drop queued waiters (shutdown); running permits are left to their runs. */
  close(): void {
    this.closed = true;
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) waiter.reject(new Error('Model gate is shutting down'));
    this.inflight.clear();
  }

  private takeNext(): Waiter | undefined {
    let best = 0;
    for (let index = 1; index < this.waiters.length; index += 1) {
      const candidate = this.waiters[index]!;
      const current = this.waiters[best]!;
      if (candidate.priority < current.priority
        || (candidate.priority === current.priority && candidate.seq < current.seq)) {
        best = index;
      }
    }
    return this.waiters.splice(best, 1)[0];
  }

  private refill(): void {
    const now = this.now();
    const elapsed = now - this.lastRefill;
    if (elapsed <= 0) return;
    this.lastRefill = now;
    this.tokens = Math.min(this.config.burst, this.tokens + (elapsed * this.config.rpm) / 60_000);
  }
}
