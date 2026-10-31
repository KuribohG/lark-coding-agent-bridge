import { afterEach, describe, expect, it, vi } from 'vitest';
import { respondToCardAction } from '../../../src/card/response';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('card callback response deadline', () => {
  it('keeps fast card responses and clears their deadline timer', async () => {
    vi.useFakeTimers();
    const card = { card: { type: 'raw' as const, data: { schema: '2.0' } } };
    const notify = vi.fn();
    expect(await respondToCardAction(async () => card, notify)).toEqual(card);
    expect(await respondToCardAction(async () => undefined, notify)).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    expect(notify).not.toHaveBeenCalled();
  });

  it('acknowledges a slow action without reporting success or replaying it', async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const action = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const notify = vi.fn();
    const response = respondToCardAction(action, notify);
    await vi.advanceTimersByTimeAsync(500);
    expect(await response).toEqual({ toast: { type: 'info', content: '正在处理，请稍候。' } });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(action).toHaveBeenCalledOnce();
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(notify).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('returns immediate failures as an error toast without exposing the exception', async () => {
    const notify = vi.fn();
    const response = await respondToCardAction(() => { throw new Error('private detail'); }, notify);
    expect(response).toMatchObject({ toast: { type: 'error' } });
    expect(JSON.stringify(response)).not.toContain('private detail');
    expect(notify).not.toHaveBeenCalled();
  });

  it.each([false, true])('reports late failures and handles notice failure=%s', async noticeFails => {
    vi.useFakeTimers();
    let fail!: (error: Error) => void;
    const action = vi.fn(() => new Promise<void>((_resolve, reject) => { fail = reject; }));
    const notify = vi.fn(async () => { if (noticeFails) throw new Error('notice unavailable'); });
    const response = respondToCardAction(action, notify);
    await vi.advanceTimersByTimeAsync(500);
    expect(await response).toMatchObject({ toast: { type: 'info' } });
    fail(new Error('late failure'));
    await vi.advanceTimersByTimeAsync(0);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('未能确认完成'));
    expect(action).toHaveBeenCalledOnce();
  });
});
