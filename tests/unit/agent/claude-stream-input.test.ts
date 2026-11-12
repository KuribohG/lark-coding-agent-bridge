import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudeStreamInput } from '../../../src/agent/claude/stream-input';

afterEach(() => vi.useRealTimers());

function harness() {
  const stdin = new PassThrough();
  const messages: Array<{ uuid: string; session_id: string; message: { role: string; content: string } }> = [];
  stdin.on('data', chunk => messages.push(JSON.parse(chunk.toString())));
  const sent: string[] = [];
  const input = new ClaudeStreamInput(stdin, { sent: uuid => { sent.push(uuid); } }, 'parent', 100);
  input.start('original');
  return { stdin, input, messages, sent,
    ack: (index: number) => input.receive({ type: 'command_lifecycle', state: 'queued', command_uuid: messages[index]!.uuid }),
  };
}

describe('Claude streaming input', () => {
  it('waits for a correlated receipt, records what it wrote, and deduplicates IM IDs', async () => {
    const h = harness();
    expect(h.input.receive({ type: 'system', subtype: 'init', session_id: 'child' })).toBe(false);
    const receipt = h.input.steer('more\n<bridge_context>', 'im-1');
    let resolved = false;
    void receipt.then(() => { resolved = true; });
    expect(h.input.steer('more\n<bridge_context>', 'im-1')).toBe(receipt);
    expect(h.input.receive({ type: 'command_lifecycle', state: 'queued', command_uuid: 'unrelated' })).toBe(true);
    await Promise.resolve();
    expect(resolved).toBe(false);
    expect(h.messages).toHaveLength(2);
    expect(h.messages[1]).toMatchObject({ session_id: 'child', message: { role: 'user', content: 'more\n<bridge_context>' } });
    expect(h.sent).toEqual(h.messages.map(message => message.uuid));
    expect(h.ack(1)).toBe(true);
    expect(await receipt).toBe('accepted');
    expect(h.stdin.writableEnded).toBe(false);
  });

  it('takes a replayed input or a result naming it as its receipt', async () => {
    const h = harness();
    const replayed = h.input.steer('second', 'im-1');
    expect(h.input.receive({ type: 'user', isReplay: true, uuid: h.messages[1]!.uuid, message: { content: 'second' } })).toBe(true);
    expect(await replayed).toBe('accepted');
    const named = h.input.steer('third', 'im-2');
    expect(h.input.receive({ type: 'result', user_message_uuids: [h.messages[2]!.uuid] })).toBe(false);
    expect(await named).toBe('accepted');
  });

  it('leaves subagent events alone', () => {
    const h = harness();
    expect(h.input.receive({ type: 'user', isReplay: true, parent_tool_use_id: 'tool', uuid: h.messages[0]!.uuid })).toBe(false);
  });

  it('reports the inputs an earlier bridge process wrote', () => {
    const sent: string[] = [];
    const input = new ClaudeStreamInput(new PassThrough(), { sent: uuid => { sent.push(uuid); } });
    input.restore(['not json', JSON.stringify({ type: 'user', uuid: 'a' }), JSON.stringify({ type: 'control_response' }),
      JSON.stringify({ type: 'user', uuid: 'b' })]);
    expect(sent).toEqual(['a', 'b']);
  });

  it('times out without replaying', async () => {
    vi.useFakeTimers();
    const h = harness();
    const receipt = h.input.steer('second', 'im-1');
    const rejected = expect(receipt).rejects.toThrow('delivery is unknown');
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    expect(h.input.steer('second', 'im-1')).toBe(receipt);
    expect(h.messages).toHaveLength(2);
  });

  it('settles pending receipts when closed and rejects new input', async () => {
    const h = harness();
    const rejected = expect(h.input.steer('second', 'im-1')).rejects.toThrow('delivery is unknown');
    h.input.close();
    await rejected;
    expect(h.stdin.writableEnded).toBe(true);
    expect(await h.input.steer('late', 'im-2')).toBe('inactive');
    expect(h.input.interrupt()).toBe(false);
  });

  it('treats write failure as ambiguous and clears receipt timers', async () => {
    const h = harness();
    vi.spyOn(h.stdin, 'write').mockImplementation(() => { throw new Error('broken pipe'); });
    await expect(h.input.steer('second', 'im-1')).rejects.toThrow('delivery is unknown');
    expect(await h.input.steer('third', 'im-2')).toBe('inactive');
  });
});
