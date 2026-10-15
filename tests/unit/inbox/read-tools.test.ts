import { expect, it, vi } from 'vitest';
import { InboxReadTools, readToolRequest } from '../../../src/inbox/read-tools';

const signal = () => new AbortController().signal;
const request = (operation: string, args: unknown = {}) => ({ operation, argumentsJson: JSON.stringify(args) });

it('discovers business reads across domains and describes parameters without calling the CLI', async () => {
  const call = vi.fn(); const tools = new InboxReadTools(call);
  const listed = await tools.execute('list_lark_read_tools', { domain: 'docs', query: null, offset: 0 }, signal());
  expect(listed.domains).toEqual(expect.arrayContaining(['im', 'docs', 'base', 'sheets', 'calendar', 'mail', 'task', 'wiki']));
  expect(listed.operations).toEqual(expect.arrayContaining([expect.objectContaining({ operation: 'docs +fetch' })]));
  const described = await tools.execute('describe_lark_read_tool', { operation: 'docs +fetch' }, signal());
  expect(described).toMatchObject({ identity: 'user', parameters: { properties: { doc: { type: 'string' } } } });
  expect(call).not.toHaveBeenCalled();
});

it.each(['im +messages-send', 'docs +update', 'base +record-upsert', 'base +record-share-link-create', 'calendar events create',
  'task tasks patch', 'apps +db-execute', 'apps +git-credential-list', 'apps +openapi-key-get', 'apps +file-sign', 'apps +file-download',
  'drive +status', 'drive +download', 'drive +export', 'drive +version-get', 'docs +media-preview', 'note +transcript',
  'mail +watch', 'markdown +diff', 'sheets +workbook-export', 'slides +screenshot', 'api GET', 'auth status', 'config get', 'schema',
  'bash', '__proto__', 'constructor'])('rejects %s at the execution entry', async operation => {
  const call = vi.fn();
  await expect(new InboxReadTools(call).execute('call_lark_read_tool', request(operation), signal())).rejects.toThrow('不允许');
  expect(call).not.toHaveBeenCalled();
});

it.each([
  ['docs +fetch', { doc: 'doc_token', output: 'local.xml' }],
  ['docs +fetch', { doc: '/etc/passwd' }],
  ['docs +fetch', { doc: 'https://feishu.cn.evil.test/docx/abc' }],
  ['docs +fetch', { doc: 'https://user:pass@feishu.cn/docx/abc' }],
  ['docs +fetch', { doc: 'file:///etc/passwd' }],
  ['docs +fetch', { doc: ['abc'] }],
  ['docs +fetch', { doc: 'abc', as: 'bot' }],
  ['docs +fetch', { doc: 'abc', profile: 'other' }],
  ['base +record-list', { 'base-token': 'abc', 'filter-json': '  @secrets.json' }],
  ['base +data-query', { 'base-token': 'abc', dsl: '-' }],
  ['calendar calendars get', { params: { calendar_id: '../../auth/v3/token' } }],
  ['calendar calendars get', { params: { calendar_id: '%2f..%2fauth' } }],
  ['calendar calendars get', { params: '@secrets.json' }],
  ['calendar calendars get', { params: { calendar_id: 'abc', output: 'local.json' } }],
  ['calendar calendars get', { params: {} }],
  ['calendar calendars search', { data: { query: 'test', command: 'delete' } }],
  ['im +messages-mget', { 'message-ids': 'om_test', 'download-resources': true }],
  ['minutes +detail', { 'minute-tokens': 'abc', transcript: true }],
  ['whiteboard +export', { 'whiteboard-token': 'abc', 'output-type': 'preview' }],
  ['apps +env-list', { 'app-id': 'app_test', 'include-values': true }],
  ['sheets +cells-get', { 'spreadsheet-token': 'abc', 'max-chars': 1000000 }],
  ['task tasks list', { params: { page_size: 100000 } }],
])('rejects unsafe arguments to %s before dispatch', async (operation, args) => {
  const call = vi.fn();
  await expect(new InboxReadTools(call).execute('call_lark_read_tool', request(String(operation), args), signal())).rejects.toThrow();
  expect(call).not.toHaveBeenCalled();
});

it('keeps query text literal and serializes typed API params and JSON bodies', () => {
  const query = '$(touch /tmp/should-not-exist) `ls /` --output=secret';
  expect(readToolRequest('call_lark_read_tool', request('docs +search', { query }))).toMatchObject({ args: ['docs', '+search', `--query=${query}`, '--as=user'] });
  expect(readToolRequest('call_lark_read_tool', request('calendar calendars search', { data: { query } }))).toMatchObject({
    args: ['calendar', 'calendars', 'search', `--data=${JSON.stringify({ query })}`, '--as=user'],
  });
  expect(readToolRequest('call_lark_read_tool', request('mail user_mailbox.messages get', { params: { user_mailbox_id: 'me', message_id: 'mail_id', format: 'full' } }))).toMatchObject({
    args: ['mail', 'user_mailbox.messages', 'get', '--params={"user_mailbox_id":"me","message_id":"mail_id","format":"full"}', '--as=user'],
  });
});

it('repairs nested argument JSON while retaining field and identity validation', () => {
  expect(readToolRequest('call_lark_read_tool', { operation: 'docs +fetch', argumentsJson: "{doc:'doc_token',}" })).toMatchObject({
    args: ['docs', '+fetch', '--doc=doc_token', '--as=user'],
  });
  for (const argumentsJson of ["{doc:'doc_token',as:'bot'}", "{doc:'@private.json'}", "{doc:42}", "{__proto__:{doc:'doc_token'}}"]) {
    expect(() => readToolRequest('call_lark_read_tool', { operation: 'docs +fetch', argumentsJson })).toThrow();
  }
});

it('fixes safe inline-only modes and rejects prototype keys', () => {
  expect(readToolRequest('call_lark_read_tool', request('minutes +detail', { 'minute-tokens': 'abc' }))).toMatchObject({
    args: ['minutes', '+detail', '--minute-tokens=abc', '--summary=true', '--transcript=false', '--as=user'],
  });
  expect(readToolRequest('call_lark_read_tool', request('whiteboard +export', { 'whiteboard-token': 'abc' }))).toMatchObject({
    args: ['whiteboard', '+export', '--whiteboard-token=abc', '--output-type=raw', '--as=user'],
  });
  expect(() => readToolRequest('call_lark_read_tool', { operation: 'docs +fetch', argumentsJson: '{"__proto__":{"doc":"abc"}}' })).toThrow();
});

it('preserves array results and exposes bounded content with pagination', async () => {
  const tools = new InboxReadTools(async () => [{ title: 'array result' }]);
  expect(await tools.execute('call_lark_read_tool', request('wiki +space-list'), signal())).toMatchObject({ content: '[{"title":"array result"}]', truncated: false });
  const large = new InboxReadTools(async () => ({ body: 'x'.repeat(50000), has_more: true, page_token: 'next' }));
  const result = await large.execute('call_lark_read_tool', request('wiki +space-list'), signal());
  expect(result).toMatchObject({ truncated: true, pagination: { has_more: true, page_token: 'next' } });
  expect(String(result.content).length).toBe(40000);
});

it('does not dispatch on cancellation or return a late result', async () => {
  const controller = new AbortController();
  const call = vi.fn(async () => { controller.abort(); return {}; });
  const tools = new InboxReadTools(call);
  await expect(tools.execute('call_lark_read_tool', request('wiki +space-list'), controller.signal)).rejects.toThrow();
  await expect(tools.execute('call_lark_read_tool', request('wiki +space-list'), controller.signal)).rejects.toThrow();
  expect(call).toHaveBeenCalledTimes(1);
});
