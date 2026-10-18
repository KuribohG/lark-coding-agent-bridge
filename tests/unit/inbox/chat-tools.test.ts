import { expect, it, vi } from 'vitest';
import { chatToolArgs, InboxChatTools } from '../../../src/inbox/chat-tools';

it.each([
  ['read_chat_messages', { chatId: '/etc/passwd' }],
  ['read_chat_messages', { chatId: 'oc_test', command: 'ls /' }],
  ['read_chat_messages', { chatId: 'oc_test', downloadResources: true }],
  ['read_thread_messages', { threadId: 'omt_test; rm -rf /' }],
  ['get_messages', { messageIds: ['om_ok', '--as=bot'] }],
  ['get_messages', { messageIds: [] }],
  ['search_messages', { query: null, chatId: null }],
  ['search_messages', { query: 'a', start: 'yesterday' }],
  ['search_messages', { query: 'a', start: '2026-10-15T00:00:00Z', end: '2026-10-14T00:00:00Z' }],
  ['search_messages', { query: 'a', pageToken: 'x\u0000--output=secret' }],
  ['search_messages', { query: 'a', as: 'bot' }],
])('rejects invalid %s input before dispatch', async (name, input) => {
  const call = vi.fn();
  await expect(new InboxChatTools(call).execute(String(name), input, new AbortController().signal)).rejects.toThrow();
  expect(call).not.toHaveBeenCalled();
});

it('passes hostile-looking search text as a single literal option value, never a command', () => {
  const query = '--download-resources $(touch /tmp/forbidden) `cat /etc/passwd`';
  expect(chatToolArgs('search_messages', { query, chatId: 'oc_chat', pageToken: '--output=/tmp/file' }))
    .toEqual(['im', '+messages-search', `--query=${query}`, '--chat-id=oc_chat', '--page-token=--output=/tmp/file', '--page-size=50', '--as=user', '--no-reactions']);
});

it('returns bounded message content and explicit pagination without arbitrary response fields', async () => {
  const call = vi.fn(async () => ({ messages: [{ message_id: 'om_one', chat_id: 'oc_chat', create_time: '1792050000000',
    content: 'a'.repeat(5000), sender: { id: 'ou_sender', name: 'name', sender_type: 'user' } }],
    has_more: true, page_token: 'next', secret: 'must-not-expose' }));
  const result = await new InboxChatTools(call).execute('get_messages', { messageIds: ['om_one'] }, new AbortController().signal);
  expect(result).toMatchObject({ hasMore: true, nextPageToken: 'next', truncated: true });
  expect(JSON.stringify(result)).not.toContain('must-not-expose');
  expect((result.messages as { text: string }[])[0]!.text).toHaveLength(4000);
});

it.each(['search_messages', 'read_chat_messages'])('uses API-compatible seconds without losing time boundaries for %s', async name => {
  const call = vi.fn(async () => ({ messages: [] }));
  await new InboxChatTools(call).execute(name, { chatId: 'oc_chat', ...(name === 'search_messages' ? { query: '发布方案' } : {}),
    start: '2026-10-18T14:03:05.123+08:00', end: '2026-10-18T14:04:06.789+08:00' }, new AbortController().signal);
  expect(call).toHaveBeenCalledWith(expect.arrayContaining(['--start=2026-10-18T06:03:05Z', '--end=2026-10-18T06:04:07Z']), expect.any(AbortSignal));
});

it('fails closed if a next page cannot be retrieved', async () => {
  const call = vi.fn(async () => ({ messages: [], has_more: true }));
  await expect(new InboxChatTools(call).execute('read_thread_messages', { threadId: 'omt_thread' }, new AbortController().signal)).rejects.toThrow('分页');
});
