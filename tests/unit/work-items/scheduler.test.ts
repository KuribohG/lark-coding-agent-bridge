import { expect, it, vi } from 'vitest';
import { WorkItemScheduler } from '../../../src/work-items/scheduler';

function gate() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

it('runs five tasks by default and refills in FIFO order after out-of-order completion or failure', async () => {
  const queue = new WorkItemScheduler(); const started: number[] = [];
  const gates = Array.from({ length: 8 }, gate);
  let active = 0; let peak = 0;
  const runs = gates.map((g, i) => queue.run(new AbortController().signal, async () => {
    started.push(i); peak = Math.max(peak, ++active);
    try { await g.promise; } finally { active--; }
  }));
  const settled = Promise.allSettled(runs);
  try {
    await vi.waitFor(() => expect(started).toEqual([0, 1, 2, 3, 4]));
    gates[3]!.resolve(); await vi.waitFor(() => expect(started).toEqual([0, 1, 2, 3, 4, 5]));
    gates[1]!.reject(Error('failure')); await vi.waitFor(() => expect(started).toHaveLength(7));
    gates[5]!.resolve(); await vi.waitFor(() => expect(started).toEqual([0, 1, 2, 3, 4, 5, 6, 7]));
    expect(peak).toBe(5); expect(active).toBe(5);
  } finally { gates.forEach(g => g.resolve()); await settled; }
});

it('removes cancelled waiters and records cancellation without releasing an occupied slot', async () => {
  const queue = new WorkItemScheduler(1); const held = gate();
  const controllers = Array.from({ length: 4 }, () => new AbortController());
  const started: number[] = []; const cancelled: number[] = [];
  const first = queue.run(controllers[0]!.signal, () => held.promise);
  const waiting = controllers.slice(1).map((controller, index) => queue.run(controller.signal, async signal => {
    if (signal.aborted) cancelled.push(index + 1); else started.push(index + 1);
  }));
  try {
    controllers[1]!.abort(); controllers[2]!.abort();
    await Promise.all(waiting.slice(0, 2));
    expect(cancelled).toEqual([1, 2]); expect(started).toEqual([]);
    controllers[0]!.abort(); await Promise.resolve();
    expect(started).toEqual([]);
  } finally { held.resolve(); await Promise.all([first, ...waiting]); }
  expect(started).toEqual([3]);
});

it('records a pre-aborted task and releases a slot after a synchronous throw', async () => {
  const queue = new WorkItemScheduler(1); const controller = new AbortController(); controller.abort();
  const cancelled = vi.fn(async (signal: AbortSignal) => { signal.throwIfAborted(); });
  await expect(queue.run(controller.signal, cancelled)).rejects.toThrow();
  expect(cancelled).toHaveBeenCalledTimes(1);
  await expect(queue.run(new AbortController().signal, () => { throw Error('failed'); })).rejects.toThrow('failed');
  const next = vi.fn(async () => {}); await queue.run(new AbortController().signal, next);
  expect(next).toHaveBeenCalledTimes(1);
});

it.each([0, -1, 1.5, Infinity, NaN])('rejects an invalid concurrency of %s', concurrency => {
  expect(() => new WorkItemScheduler(concurrency)).toThrow('Invalid work item concurrency');
});

it('resizes a live queue, immediately filling added slots and draining before honoring a lower cap', async () => {
  const queue = new WorkItemScheduler(1); const gates = Array.from({ length: 5 }, gate); const started: number[] = [];
  const runs = gates.map((g, i) => queue.run(new AbortController().signal, async () => { started.push(i); await g.promise; }));
  try {
    await vi.waitFor(() => expect(started).toEqual([0]));
    queue.resize(3); await vi.waitFor(() => expect(started).toEqual([0, 1, 2]));
    queue.resize(1); gates[0]!.resolve(); gates[1]!.resolve(); await Promise.all(runs.slice(0, 2));
    expect(started).toEqual([0, 1, 2]);
    gates[2]!.resolve(); await vi.waitFor(() => expect(started).toEqual([0, 1, 2, 3]));
    expect(() => queue.resize(0)).toThrow(); expect(queue.concurrency).toBe(1);
  } finally { gates.forEach(g => g.resolve()); await Promise.all(runs); }
});
