import { monitorEventLoopDelay, performance } from 'node:perf_hooks';

/** Latency samples in milliseconds, summarized as percentiles. */
export class Samples {
  private readonly values: number[] = [];

  add(ms: number): void { this.values.push(ms); }

  /** Times a synchronous call. */
  time<T>(fn: () => T): T {
    const started = performance.now();
    try { return fn(); } finally { this.add(performance.now() - started); }
  }

  async timeAsync<T>(fn: () => Promise<T>): Promise<T> {
    const started = performance.now();
    try { return await fn(); } finally { this.add(performance.now() - started); }
  }

  summary(): { count: number; p50: number; p99: number; max: number; total: number } {
    const sorted = [...this.values].sort((a, b) => a - b);
    const at = (quantile: number) => round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * quantile))] ?? 0);
    return { count: sorted.length, p50: at(0.5), p99: at(0.99), max: round(sorted.at(-1) ?? 0), total: round(sorted.reduce((sum, value) => sum + value, 0)) };
  }
}

export function round(value: number): number { return Math.round(value * 1000) / 1000; }

/** How long the event loop was blocked beyond its timer resolution while `run` was in progress. */
export async function withLoopDelay<T>(run: () => Promise<T>): Promise<{ value: T; loopDelay: { p50: number; p99: number; max: number } }> {
  const delay = monitorEventLoopDelay({ resolution: 1 });
  delay.enable();
  try {
    const value = await run();
    return { value, loopDelay: { p50: round(delay.percentile(50) / 1e6), p99: round(delay.percentile(99) / 1e6), max: round(delay.max / 1e6) } };
  } finally { delay.disable(); }
}

export function memory(): { rssMb: number; heapMb: number } {
  const usage = process.memoryUsage();
  return { rssMb: Math.round(usage.rss / 1e6), heapMb: Math.round(usage.heapUsed / 1e6) };
}
