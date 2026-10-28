import type { NormalizedMessage } from '@larksuite/channel';
import { describe, expect, it, vi } from 'vitest';
import { PendingQueue } from '../../../src/bot/pending-queue.js';

describe('PendingQueue', () => {
  it('reads the configured quiet window for each new debounce timer', async () => {
    vi.useFakeTimers();
    try {
      let delayMs = 600;
      const flushed: string[][] = [];
      const queue = new PendingQueue(
        () => delayMs,
        (_scope, batch) => flushed.push(batch.map(message => message.messageId)),
      );

      queue.push('topic', message('first'));
      await vi.advanceTimersByTimeAsync(100);
      delayMs = 250;
      queue.push('topic', message('second'));

      await vi.advanceTimersByTimeAsync(249);
      expect(flushed).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(flushed).toEqual([['first', 'second']]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('allows an immediate zero-millisecond flush', async () => {
    vi.useFakeTimers();
    try {
      const flushed: string[][] = [];
      const queue = new PendingQueue(
        0,
        (_scope, batch) => flushed.push(batch.map(message => message.messageId)),
      );

      queue.push('chat', message('only'));
      expect(flushed).toEqual([]);
      await vi.advanceTimersByTimeAsync(0);
      expect(flushed).toEqual([['only']]);
    } finally {
      vi.useRealTimers();
    }
  });
});

function message(messageId: string): NormalizedMessage {
  return { messageId } as NormalizedMessage;
}
