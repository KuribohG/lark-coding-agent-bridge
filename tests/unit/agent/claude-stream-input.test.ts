import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudeStreamInput } from '../../../src/agent/claude/stream-input';

afterEach(() => vi.useRealTimers());

function harness() {
  const stdin = new PassThrough();
  const messages: Array<{ uuid: string; session_id: string; message: { role: string; content: string } }> = [];
  stdin.on('data', chunk => messages.push(JSON.parse(chunk.toString())));
  const input = new ClaudeStreamInput(stdin, 'parent', 100);
  input.start('original');
  return { stdin, input, messages,
    result: (...indices: number[]) => ({ type: 'result', user_message_uuids: indices.map(i => messages[i]!.uuid) }),
    ack: (index: number) => input.receive({ type: 'command_lifecycle', state: 'queued', command_uuid: messages[index]!.uuid }),
  };
}

describe('Claude streaming input', () => {
  it('waits for a correlated receipt, keeps stdin open, and deduplicates IM IDs', async () => {
    const h = harness();
    h.input.receive({ type: 'system', subtype: 'init', session_id: 'child' });
    const receipt = h.input.steer('more\n<bridge_context>', 'im-1');
    let resolved = false;
    void receipt.then(() => { resolved = true; });
    expect(h.input.steer('more\n<bridge_context>', 'im-1')).toBe(receipt);
    h.input.receive({ type: 'command_lifecycle', state: 'queued', command_uuid: 'unrelated' });
    await Promise.resolve();
    expect(resolved).toBe(false);
    expect(h.messages).toHaveLength(2);
    expect(h.messages[1]).toMatchObject({ session_id: 'child', message: { role: 'user', content: 'more\n<bridge_context>' } });
    expect(h.stdin.writableEnded).toBe(false);
    h.ack(1);
    expect(await receipt).toBe('accepted');
    expect(h.input.receive(h.result(0, 1))).toEqual(h.result(0, 1));
    expect(h.stdin.writableEnded).toBe(true);
    expect(await h.input.steer('late', 'im-2')).toBe('inactive');
  });

  it('waits for a supplemental result even if its receipt preceded the previous result', async () => {
    const h = harness();
    const receipt = h.input.steer('second', 'im-1');
    expect(h.input.receive({ type: 'user', isReplay: true, uuid: h.messages[1]!.uuid, message: { content: 'second' } })).toBeUndefined();
    expect(await receipt).toBe('accepted');
    expect(h.input.receive(h.result(0))).toBeUndefined();
    expect(h.stdin.writableEnded).toBe(false);
    expect(h.input.receive(h.result(1))).toEqual(h.result(1));
    expect(h.stdin.writableEnded).toBe(true);
  });

  it('waits across an old result arriving before any acknowledgement', async () => {
    const h = harness();
    const receipt = h.input.steer('second', 'im-1');
    expect(h.input.receive(h.result(0))).toBeUndefined();
    expect(h.stdin.writableEnded).toBe(false);
    expect(h.input.receive(h.result(1))).toEqual(h.result(1));
    expect(await receipt).toBe('accepted');
  });

  it('tracks several inputs consumed together or across generations', async () => {
    const h = harness();
    const first = h.input.steer('one', 'im-1');
    const second = h.input.steer('two', 'im-2');
    h.ack(2); h.ack(1);
    expect(await Promise.all([first, second])).toEqual(['accepted', 'accepted']);
    expect(h.input.receive(h.result(0, 1))).toBeUndefined();
    expect(h.input.receive(h.result(2))).toEqual(h.result(2));
  });

  it('ignores task notification results when deciding whether to close stdin', () => {
    const h = harness();
    const notification = { type: 'result', origin: { kind: 'task-notification' } };
    h.input.receive(notification);
    expect(h.stdin.writableEnded).toBe(false);
    h.input.receive(h.result(0));
  });

  it('times out without replaying, and can still consume a late confirmed result', async () => {
    vi.useFakeTimers();
    const h = harness();
    const receipt = h.input.steer('second', 'im-1');
    const rejected = expect(receipt).rejects.toThrow('delivery is unknown');
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    expect(h.input.steer('second', 'im-1')).toBe(receipt);
    expect(h.messages).toHaveLength(2);
    expect(h.input.receive(h.result(0))).toBeUndefined();
    expect(h.input.receive(h.result(1))).toEqual(h.result(1));
  });

  it('settles pending receipts when stopped and rejects new input', async () => {
    const h = harness();
    const rejected = expect(h.input.steer('second', 'im-1')).rejects.toThrow('delivery is unknown');
    h.input.close();
    await rejected;
    expect(await h.input.steer('late', 'im-2')).toBe('inactive');
  });

  it('marks rate-limit errors with unconsumed inputs as unsafe to retry', async () => {
    const h = harness();
    const receipt = h.input.steer('second', 'im-1');
    h.ack(1); await receipt;
    expect(h.input.receive({ ...h.result(0), is_error: true, errors: ['429 Too Many Requests'] })).toMatchObject({
      is_error: true, errors: ['429 Too Many Requests', expect.stringContaining('delivery is unknown')],
    });
    expect(h.stdin.writableEnded).toBe(true);
  });

  it('allows recovery when an error result accounts for all inputs', async () => {
    const h = harness();
    const receipt = h.input.steer('second', 'im-1');
    const result = { ...h.result(0, 1), is_error: true, errors: ['429 Too Many Requests'] };
    expect(h.input.receive(result)).toEqual(result);
    expect(await receipt).toBe('accepted');
  });

  it('supports legacy single-prompt results but does not guess supplemental completion', async () => {
    const h = harness();
    expect(h.input.receive({ type: 'result' })).toEqual({ type: 'result' });
    const other = harness();
    const rejected = expect(other.input.steer('second', 'im-1')).rejects.toThrow('delivery is unknown');
    expect(other.input.receive({ type: 'result' })).toMatchObject({ is_error: true });
    await rejected;
  });

  it('treats write failure as ambiguous and clears receipt timers', async () => {
    const h = harness();
    vi.spyOn(h.stdin, 'write').mockImplementation(() => { throw new Error('broken pipe'); });
    await expect(h.input.steer('second', 'im-1')).rejects.toThrow('delivery is unknown');
    expect(await h.input.steer('third', 'im-2')).toBe('inactive');
  });
});
