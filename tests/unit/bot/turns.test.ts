import { afterEach, expect, it, vi } from 'vitest';
import { PendingQueue } from '../../../src/bot/pending-queue';
import { LarkTurns } from '../../../src/channels/lark/turns';
import { ActiveRuns } from '../../../src/runtime/active-runs';

const pending = new PendingQueue(60_000, () => {});
afterEach(() => pending.cancelAll());

it('reserves preparation across all entry types and keeps cancellation until it releases', async () => {
  const turns = new LarkTurns(pending, new ActiveRuns());
  const turn = turns.claim('topic', 'timed-id');
  expect(turns.isIdle('topic')).toBe(false);
  expect(turns.timedRunId('topic')).toBe('timed-id');
  expect(() => turns.claim('topic')).toThrow('active');
  turns.cancel('topic', 'different-job');
  turns.cancel('topic', 'timed-id');
  expect(pending.isBlocked('topic')).toBe(true);
  await turn.run(async signal => {
    expect(signal.aborted).toBe(true);
    expect(signal.reason.reason).toBe('cancelled');
  });
  expect(turns.isIdle('topic')).toBe(true);
});

it('releases after failure and cannot let an old or reused claim release a new turn', async () => {
  const turns = new LarkTurns(pending, new ActiveRuns());
  const first = turns.claim('topic');
  await expect(first.run(async () => { throw new Error('prepare failed'); })).rejects.toThrow('prepare failed');
  const next = turns.claim('topic');
  first.release();
  const start = vi.fn(async () => {});
  await expect(first.run(start)).rejects.toThrow('already started');
  expect(start).not.toHaveBeenCalled();
  expect(pending.isBlocked('topic')).toBe(true);
  await next.run(start);
  expect(turns.isIdle('topic')).toBe(true);
});

it('shutdown aborts every entry and denies new admission', async () => {
  const turns = new LarkTurns(pending, new ActiveRuns());
  const first = turns.claim('topic-one');
  const second = turns.claim('topic-two', 'timed-id');
  turns.close();
  await Promise.all([first, second].map(turn => turn.run(async signal => {
    expect(signal.aborted).toBe(true);
    expect(signal.reason.reason).toBe('shutdown');
  })));
  expect(turns.isIdle('topic-one')).toBe(false);
  expect(() => turns.claim('topic-three')).toThrow('closed');
});
