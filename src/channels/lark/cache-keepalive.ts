import type { CacheKeepaliveSettings } from '../../config/schema';
import { log } from '../../core/logger';

/** What one keep-alive request read from and wrote to the provider's prompt cache. */
export interface CachePing {
  promptTokens: number;
  cachedTokens: number;
  costUsd?: number;
}

export interface CacheKeepaliveDeps {
  /** Scopes whose conversation is waiting on a workflow. */
  scopes(): Iterable<string>;
  /** Settings for the scope's conversation, or undefined while keep-alive is off for it. */
  settings(scope: string): CacheKeepaliveSettings | undefined;
  isIdle(scope: string): boolean;
  /** When the scope's session last finished a turn (epoch ms), if recorded. */
  lastActivity(scope: string): Promise<number | undefined>;
  /** Re-read the session's cached prompt from a throwaway fork; undefined when no request was made. */
  ping(scope: string, signal: AbortSignal): Promise<CachePing | undefined>;
  now?: () => number;
}

const TICK_MS = 30_000;
/** A request this late has probably outlived the cache; sending it would pay for the rebuild nobody asked for yet. */
const LATE_GRACE_MS = 5 * 60_000;
const PING_TIMEOUT_MS = 5 * 60_000;
/** Below this share of cached prompt tokens the cache was already gone, so further requests only add cost. */
const HIT_RATIO = 0.9;

interface IdlePeriod {
  /** When the cache was last known warm: the end of the last turn, then each successful request. */
  warmAt: number;
  pings: number;
  stopped?: string;
}

/**
 * Keeps the prompt cache of a conversation alive while it waits for its workflow. A workflow can leave the
 * main session idle for hours; without this its whole context is written to the cache again on the next wake.
 * Each idle period gets a bounded number of requests and ends at the first one that misses the cache.
 */
export class CacheKeepalive {
  private readonly periods = new Map<string, IdlePeriod>();
  private readonly busyAt = new Map<string, number>();
  private readonly inFlight = new Map<string, AbortController>();
  private timer: NodeJS.Timeout | undefined;
  private closed = false;

  constructor(private readonly deps: CacheKeepaliveDeps) {}

  start(): void {
    if (this.timer || this.closed) return;
    this.timer = setInterval(() => { void this.tick(); }, TICK_MS);
    this.timer.unref();
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    const running = [...this.inFlight.values()];
    for (const controller of running) controller.abort();
    while (this.inFlight.size) await new Promise(resolve => setTimeout(resolve, 20));
  }

  /** One scheduling pass; exposed for tests. Resolves once every request it started has finished. */
  async tick(): Promise<void> {
    if (this.closed) return;
    const now = this.now();
    const waiting = new Set(this.deps.scopes());
    for (const scope of [...this.periods.keys(), ...this.busyAt.keys()]) if (!waiting.has(scope)) this.forget(scope);
    const started: Promise<void>[] = [];
    for (const scope of waiting) {
      if (!this.deps.isIdle(scope)) {
        this.busyAt.set(scope, now);
        this.periods.delete(scope);
        continue;
      }
      const settings = this.deps.settings(scope);
      if (!settings) { this.periods.delete(scope); continue; }
      if (this.inFlight.has(scope)) continue;
      started.push(this.consider(scope, settings, now));
    }
    await Promise.all(started);
  }

  private async consider(scope: string, settings: CacheKeepaliveSettings, now: number): Promise<void> {
    let period = this.periods.get(scope);
    if (!period) {
      const recorded = await this.deps.lastActivity(scope).catch(() => undefined);
      const warmAt = Math.max(recorded ?? 0, this.busyAt.get(scope) ?? 0);
      // Without a known last turn there is no telling whether the cache is still there.
      if (!warmAt || this.closed || !this.deps.isIdle(scope)) return;
      period = { warmAt, pings: 0 };
      this.periods.set(scope, period);
    }
    if (period.stopped || period.pings >= settings.maxPings) return;
    const due = period.warmAt + settings.intervalMs;
    if (now < due) return;
    if (now > due + LATE_GRACE_MS) return this.stop(scope, period, 'late');
    await this.ping(scope, period, settings);
  }

  private async ping(scope: string, period: IdlePeriod, settings: CacheKeepaliveSettings): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PING_TIMEOUT_MS);
    this.inFlight.set(scope, controller);
    try {
      const sentAt = this.now();
      const result = await this.deps.ping(scope, controller.signal);
      // A turn that started meanwhile owns the cache now; its end opens the next idle period.
      if (this.periods.get(scope) !== period || !this.deps.isIdle(scope)) return;
      if (!result) return this.stop(scope, period, 'unavailable');
      period.pings++;
      const hit = result.promptTokens > 0 && result.cachedTokens >= result.promptTokens * HIT_RATIO;
      log.info('cache-keepalive', 'ping', { scope, ping: period.pings, maxPings: settings.maxPings, hit, ...result });
      if (!hit) return this.stop(scope, period, 'miss');
      if (result.promptTokens < settings.minContextTokens) return this.stop(scope, period, 'small-context');
      period.warmAt = sentAt;
    } catch (error) {
      if (this.periods.get(scope) === period) this.stop(scope, period, 'failed', String(error));
    } finally {
      clearTimeout(timeout);
      this.inFlight.delete(scope);
    }
  }

  private stop(scope: string, period: IdlePeriod, reason: string, error?: string): void {
    period.stopped = reason;
    log.info('cache-keepalive', 'stopped', { scope, reason, pings: period.pings, ...(error ? { error } : {}) });
  }

  private forget(scope: string): void {
    this.periods.delete(scope);
    this.busyAt.delete(scope);
    this.inFlight.get(scope)?.abort();
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }
}
