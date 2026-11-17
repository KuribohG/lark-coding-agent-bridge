import { describe, expect, it } from 'vitest';
import { GateBucket, type GateAcquireOptions, type GatePermit } from '../../../src/model-gate/limiter';

/** Let promise callbacks run before a test inspects the result. */
const settle = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

interface Tracked {
  outcome: 'granted' | 'rejected' | 'pending';
}

/** Records what a promise did by the time the test looks at it. */
function track(promise: Promise<GatePermit>): Tracked {
  const record: Tracked = { outcome: 'pending' };
  promise.then(() => { record.outcome = 'granted'; }, () => { record.outcome = 'rejected'; });
  return record;
}

interface Harness {
  bucket: GateBucket;
  advance(ms: number): void;
}

function harness(config: { rpm: number; burst: number; concurrency: number }): Harness {
  let clock = 0;
  const bucket = new GateBucket('test', config, () => clock);
  return { bucket, advance: (ms: number) => { clock += ms; bucket.pump(); } };
}

const acquire = (bucket: GateBucket, options: Partial<GateAcquireOptions> = {}): Promise<GatePermit> =>
  bucket.acquire({ leaseMs: 60_000, ...options });

describe('GateBucket', () => {
  it('grants up to the burst immediately and then refills continuously', async () => {
    const h = harness({ rpm: 60, burst: 2, concurrency: 10 });
    const first = track(acquire(h.bucket));
    const second = track(acquire(h.bucket));
    const third = track(acquire(h.bucket));
    await settle();

    expect(first.outcome).toBe('granted');
    expect(second.outcome).toBe('granted');
    expect(third.outcome).toBe('pending');
    expect(h.bucket.stats().queued).toBe(1);

    // 60 rpm = one token a second.
    h.advance(999);
    await settle();
    expect(third.outcome).toBe('pending');
    h.advance(1);
    await settle();
    expect(third.outcome).toBe('granted');
  });

  it('never holds a concurrency slot while waiting for a token', async () => {
    const h = harness({ rpm: 60, burst: 1, concurrency: 2 });
    const firstGrant = acquire(h.bucket);
    const first = track(firstGrant);
    const second = track(acquire(h.bucket));
    const third = track(acquire(h.bucket));
    await settle();

    // One token, two slots: only one request may be in flight.
    expect(first.outcome).toBe('granted');
    expect(second.outcome).toBe('pending');
    expect(third.outcome).toBe('pending');
    expect(h.bucket.stats()).toMatchObject({ inflight: 1, queued: 2 });

    // Releasing the slot is not enough; the second request still needs a token.
    h.bucket.release((await firstGrant).id);
    await settle();
    expect(second.outcome).toBe('pending');

    h.advance(1000);
    await settle();
    expect(second.outcome).toBe('granted');
  });

  it('runs an interactive waiter ahead of workers already queued', async () => {
    const h = harness({ rpm: 6000, burst: 100, concurrency: 1 });
    const holding = await acquire(h.bucket);
    const worker = track(acquire(h.bucket, { priority: 1 }));
    const interactive = track(acquire(h.bucket, { priority: 0 }));
    await settle();
    expect(worker.outcome).toBe('pending');
    expect(interactive.outcome).toBe('pending');

    h.bucket.release(holding.id);
    await settle();
    expect(interactive.outcome).toBe('granted');
    expect(worker.outcome).toBe('pending');
  });

  it('keeps FIFO order within one priority class', async () => {
    const h = harness({ rpm: 6000, burst: 100, concurrency: 1 });
    const holding = await acquire(h.bucket);
    const order: string[] = [];
    const waiters = ['a', 'b', 'c'].map(name => acquire(h.bucket).then(permit => {
      order.push(name);
      return permit;
    }));
    await settle();
    h.bucket.release(holding.id);
    await settle();
    expect(order).toEqual(['a']);
    const granted = await waiters[0]!;
    h.bucket.release(granted.id);
    await settle();
    expect(order).toEqual(['a', 'b']);
  });

  it('drops an aborted waiter instead of keeping its place', async () => {
    const h = harness({ rpm: 6000, burst: 100, concurrency: 1 });
    const holding = await acquire(h.bucket);
    const controller = new AbortController();
    const waiting = track(acquire(h.bucket, { signal: controller.signal }));
    await settle();
    expect(h.bucket.stats().queued).toBe(1);

    controller.abort(new Error('cancelled'));
    await settle();
    expect(waiting.outcome).toBe('rejected');
    expect(h.bucket.stats().queued).toBe(0);
    h.bucket.release(holding.id);
  });

  it('reclaims permits whose run vanished, and leaves live ones alone', async () => {
    const h = harness({ rpm: 6000, burst: 100, concurrency: 2 });
    await acquire(h.bucket, { leaseMs: 1000 });
    await acquire(h.bucket, { leaseMs: 60_000 });
    expect(h.bucket.stats().inflight).toBe(2);

    h.advance(1001);
    expect(h.bucket.expire()).toBe(1);
    expect(h.bucket.stats().inflight).toBe(1);
  });

  it('treats release as idempotent', async () => {
    const h = harness({ rpm: 6000, burst: 100, concurrency: 1 });
    const permit = await acquire(h.bucket);
    expect(h.bucket.release(permit.id)).toBe(true);
    expect(h.bucket.release(permit.id)).toBe(false);
    expect(h.bucket.stats().inflight).toBe(0);
  });

  it('retunes without dropping what is already in flight', async () => {
    const h = harness({ rpm: 6000, burst: 100, concurrency: 2 });
    const a = await acquire(h.bucket);
    const b = await acquire(h.bucket);
    const queued = track(acquire(h.bucket));
    await settle();
    expect(queued.outcome).toBe('pending');

    h.bucket.configure({ rpm: 6000, burst: 100, concurrency: 1 });
    // Two requests were already in flight; no new one starts until both leave.
    expect(h.bucket.stats()).toMatchObject({ inflight: 2, queued: 1 });
    h.bucket.release(a.id);
    await settle();
    expect(queued.outcome).toBe('pending');
    h.bucket.release(b.id);
    await settle();
    expect(queued.outcome).toBe('granted');
  });

  it('rejects queued waiters when the gate shuts down', async () => {
    const h = harness({ rpm: 60, burst: 1, concurrency: 1 });
    await acquire(h.bucket);
    const waiting = track(acquire(h.bucket));
    await settle();
    h.bucket.close();
    await settle();
    expect(waiting.outcome).toBe('rejected');
    expect(h.bucket.needsPump()).toBe(false);
  });
});
