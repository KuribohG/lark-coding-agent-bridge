import type { NormalizedMessage } from '@larksuite/channel';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { PendingQueue } from '../../../src/bot/pending-queue.js';

describe('PendingQueue', () => {
  it('keeps workflow command turns separate from ordinary messages in the same debounce window', async () => {
    vi.useFakeTimers();
    try {
      const flushed: string[][] = [];
      const queue = new PendingQueue(10, (scope, batch) => {
        flushed.push(batch.map(message => message.messageId));
        queue.block(scope);
      });
      queue.push('topic', message('ordinary-before'));
      queue.push('topic', { ...message('workflow'), agentEntry: { kind: 'workflow', trigger: 'command' } });
      queue.push('topic', message('ordinary-after'));
      await vi.advanceTimersByTimeAsync(10);
      expect(flushed).toEqual([['ordinary-before']]);
      queue.unblock('topic');
      await vi.advanceTimersByTimeAsync(10);
      expect(flushed).toEqual([['ordinary-before'], ['workflow']]);
      queue.unblock('topic');
      await vi.advanceTimersByTimeAsync(10);
      expect(flushed).toEqual([['ordinary-before'], ['workflow'], ['ordinary-after']]);
      queue.unblock('topic');
    } finally { vi.useRealTimers(); }
  });

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

  it('caps a scope and forces a batch after the maximum wait', async () => {
    vi.useFakeTimers();
    try {
      const flushed: string[][] = [];
      const queue = new PendingQueue(
        10_000,
        (_scope, batch) => flushed.push(batch.map(message => message.messageId)),
      );

      for (let index = 0; index < 99; index += 1) {
        expect(queue.push('topic', message(`m-${index}`))).toBe(index + 1);
      }

      await vi.advanceTimersByTimeAsync(2_500);
      expect(flushed).toEqual([]);
      expect(queue.push('topic', message('m-late'))).toBe(100);
      expect(queue.push('topic', message('overflow'))).toBeUndefined();
      await vi.advanceTimersByTimeAsync(2_499);
      expect(flushed).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(flushed).toHaveLength(1);
      expect(flushed[0]).toHaveLength(100);
      expect(flushed[0]?.at(-1)).toBe('m-late');
    } finally {
      vi.useRealTimers();
    }
  });

  it('persists queued messages and resumes them after restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pending-queue-'));
    const path = join(root, 'pending.json');
    try {
      const first = new PendingQueue(20, () => {}, path);
      expect(first.push('topic', { ...message('persisted'), agentEntry: { kind: 'workflow', trigger: 'command' } })).toBe(1);
      await first.flushPersistence();
      first.suspend();
      expect(JSON.parse(await readFile(path, 'utf8'))).toHaveLength(1);

      const flushed: string[][] = [];
      const restarted = new PendingQueue(
        5,
        (_scope, batch) => {
          expect(batch[0]?.agentEntry).toEqual({ kind: 'workflow', trigger: 'command' });
          flushed.push(batch.map(message => message.messageId));
        },
        path,
      );
      await restarted.load();
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(flushed).toEqual([]);
      restarted.resume();
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(flushed).toEqual([['persisted']]);
      await restarted.flushPersistence();
      expect(JSON.parse(await readFile(path, 'utf8'))).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('holds writes during a connect-before-disconnect handoff and merges live input on reload', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pending-handoff-'));
    const path = join(root, 'pending.json');
    try {
      const first = new PendingQueue(60_000, () => {}, path);
      first.push('topic', message('before-handoff'));
      await first.flushPersistence();
      first.suspend();

      const handoff = new PendingQueue(60_000, () => {}, path);
      handoff.suspend();
      handoff.holdPersistence();
      await handoff.load();
      handoff.push('topic', message('during-handoff'));
      await handoff.flushPersistence();
      const held = JSON.parse(await readFile(path, 'utf8')) as Array<{ messages: NormalizedMessage[] }>;
      expect(held.flatMap(entry => entry.messages.map(item => item.messageId)))
        .toEqual(['before-handoff']);

      await handoff.reload();
      const merged = JSON.parse(await readFile(path, 'utf8')) as Array<{ messages: NormalizedMessage[] }>;
      expect(merged.flatMap(entry => entry.messages.map(item => item.messageId)))
        .toEqual(['before-handoff', 'during-handoff']);
      handoff.suspend();
      first.suspend();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function message(messageId: string): NormalizedMessage {
  return { messageId, chatId: 'chat', content: messageId } as NormalizedMessage;
}
