import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PendingQueue, type PendingItem } from '../../../src/runtime/pending-queue';

interface WebInput extends PendingItem { conversationId: string }
const input = (messageId: string, content = 'text'): WebInput => ({ messageId, content, conversationId: 'c1' });

const dirs: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

describe('PendingQueue with a channel-defined input', () => {
  it('batches a scope\'s inputs and holds them while the scope is blocked', () => {
    vi.useFakeTimers();
    const flushed: Array<[string, WebInput[]]> = [];
    const queue = new PendingQueue<WebInput>(50, (scope, batch) => { flushed.push([scope, batch]); });
    queue.block('s');
    expect(queue.push('s', input('m1'))).toBe(1);
    expect(queue.push('s', input('m2'))).toBe(2);
    vi.advanceTimersByTime(1_000);
    expect(flushed).toEqual([]);
    queue.unblock('s');
    vi.advanceTimersByTime(50);
    expect(flushed).toEqual([['s', [input('m1'), input('m2')]]]);
    expect(queue.hasWork('s')).toBe(false);
  });

  it('restores persisted inputs, dropping those the channel no longer accepts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bridge-queue-')); dirs.push(dir);
    const path = join(dir, 'pending.json');
    await writeFile(path, JSON.stringify([{ scope: 's', queuedAt: 1, messages: [
      input('m1'), { messageId: 'm2', content: 'no conversation' }, { messageId: 3, content: 'bad id', conversationId: 'c1' },
    ] }]));
    const flushed: WebInput[][] = [];
    const queue = new PendingQueue<WebInput>(0, (_scope, batch) => { flushed.push(batch); }, path,
      item => typeof (item as Partial<WebInput>).conversationId === 'string');
    await queue.load();
    expect(queue.queuedMessageCount()).toBe(1);
    queue.resume();
    await vi.waitFor(() => expect(flushed).toEqual([[input('m1')]]));
    await queue.flushPersistence();
  });
});
