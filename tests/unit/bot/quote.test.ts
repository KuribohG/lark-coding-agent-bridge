import type { LarkChannel } from '@larksuite/channel';
import { describe, expect, it, vi } from 'vitest';
import { fetchTopicContext } from '../../../src/bot/quote';

describe('topic context import', () => {
  it('asks the API for the newest window and returns it chronologically', async () => {
    const items = Array.from({ length: 50 }, (_, index) => {
      const number = 249 - index;
      return item(`om_${number}`, 1_760_000_000_000 + number, `message ${number}`);
    });
    const list = vi.fn(async () => ({ data: { items, has_more: false } }));
    const channel = fakeChannel(list);

    const result = await fetchTopicContext(channel, 'thread-1', { maxMessages: 5 });

    expect(list).toHaveBeenCalledWith({
      params: expect.objectContaining({ sort_type: 'ByCreateTimeDesc', page_size: 50 }),
    });
    expect(result.map(message => message.messageId)).toEqual([
      'om_245', 'om_246', 'om_247', 'om_248', 'om_249',
    ]);
  });

  it('stops at the completion cursor and imports only newer messages', async () => {
    const list = vi.fn(async () => ({
      data: {
        items: [
          item('om_new', 1_760_000_002_000, 'new context'),
          item('om_cursor', 1_760_000_001_000, 'already seen'),
        ],
        has_more: false,
      },
    }));
    const channel = fakeChannel(list);

    const result = await fetchTopicContext(channel, 'thread-1', {
      maxMessages: 40,
      sinceMs: 1_760_000_001_000,
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ messageId: 'om_new', content: 'new context' });
  });

  it('clips a single oversized message to the context budget', async () => {
    const list = vi.fn(async () => ({
      data: {
        items: [item('om_large', 1_760_000_002_000, 'x'.repeat(4_000))],
        has_more: false,
      },
    }));
    const channel = fakeChannel(list);

    const result = await fetchTopicContext(channel, 'thread-1', {
      maxMessages: 40,
      maxChars: 900,
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.content).toContain('[话题上下文过长，中间内容已省略]');
    expect(result[0]?.content.length).toBeLessThanOrEqual(900);
  });
});

function fakeChannel(
  list: ReturnType<typeof vi.fn>,
): LarkChannel {
  return {
    botIdentity: { openId: 'ou_bot', name: 'Bridge' },
    rawClient: { im: { v1: { message: { list } } } },
    fetchRawMessage: vi.fn(),
  } as unknown as LarkChannel;
}

function item(messageId: string, createTime: number, text: string) {
  return {
    message_id: messageId,
    msg_type: 'text',
    body: { content: JSON.stringify({ text }) },
    sender: { id: 'ou_user', sender_type: 'user' },
    create_time: String(createTime),
  };
}
