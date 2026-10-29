import { describe, expect, it } from 'vitest';
import { ProcessPool } from '../../../src/runtime/process-pool';

describe('workflow admission', () => {
  it('reserves capacity for interactive work and grants it before queued workers', async () => {
    const pool = new ProcessPool(() => 3);
    const a = await pool.acquire(undefined, 'background');
    const b = await pool.acquire(undefined, 'background');
    expect(pool.tryAcquire('background')).toBeUndefined();
    const main = await pool.acquire();
    const order: string[] = [];
    const worker = pool.acquire(undefined, 'background').then(release => { order.push('worker'); return release; });
    const interactive = pool.acquire().then(release => { order.push('main'); return release; });
    a();
    const foreground = await interactive;
    expect(order).toEqual(['main']);
    b(); const background = await worker;
    expect(order).toEqual(['main', 'worker']);
    main(); foreground(); background(); background();
    expect(pool.snapshot().active).toBe(0);
  });

  it('serializes on a one-slot host without a waiting main consuming the worker slot', async () => {
    const pool = new ProcessPool(() => 1);
    const main = await pool.acquire();
    const queued = pool.acquire(undefined, 'background');
    expect(pool.snapshot()).toMatchObject({ active: 1, waiting: 1 });
    main(); const worker = await queued;
    expect(pool.snapshot()).toMatchObject({ active: 1, waiting: 0 });
    worker();
  });

  it('cancels queued admission and cannot steal a slot reserved for a woken caller', async () => {
    const pool = new ProcessPool(() => 1);
    const release = await pool.acquire();
    const cancelled = new AbortController();
    const pending = pool.acquire(cancelled.signal, 'background');
    cancelled.abort(new Error('cancelled'));
    await expect(pending).rejects.toThrow('cancelled');
    const next = pool.acquire(); release();
    expect(pool.tryAcquire()).toBeUndefined();
    (await next)(); expect(pool.snapshot().active).toBe(0);
  });
});
