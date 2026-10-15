import { expect, it, vi } from 'vitest';
import type { InboxJob } from '../../../src/inbox/types';
import { triageFailureReason, triageWithChatTools } from '../../../src/inbox/codex-triage';
import { InboxReadTools, INBOX_READ_TOOLS } from '../../../src/inbox/read-tools';
import { analysisBody, requestInboxResponse } from '../../../src/inbox/analyzer';

const job = (id: string): InboxJob => ({ id, ownerOpenId: 'ou_owner', source: { chatId: 'oc_source', name: 'test', type: 'p2p' }, messages: [] } as unknown as InboxJob);
const answer = (id: string, state = 'quiet') => ({ id, state, reason: '具体事实', priority: 'normal' });
const provider = { url: 'https://model.test/responses', key: 'private-token', model: 'default-model' };
const message = (items = [answer('a')]) => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify({ items }) }] });
const toolCall = (name = 'read_thread_messages', args: unknown = { threadId: 'omt_topic', pageToken: null }, id = 'call_1') =>
  ({ type: 'function_call', name, arguments: JSON.stringify(args), call_id: id });
const response = (output: unknown[], status = 'completed') => new Response(JSON.stringify({ status, output }), { headers: { 'content-type': 'application/json' } });
const fixture = () => { const call = vi.fn(async () => ({ messages: [] })); return { call, tools: new InboxReadTools(call) }; };
const run = (tools: InboxReadTools, request: typeof fetch, jobs = [job('a')], signal = new AbortController().signal) =>
  triageWithChatTools(jobs, '关联背景', provider, tools, signal, undefined, request);

it('advertises only read-only Lark functions, with fixed flash model and original provider', async () => {
  const f = fixture();
  const request = vi.fn<typeof fetch>(async () => response([message()]));
  expect(await run(f.tools, request)).toEqual([answer('a')]);
  const [url, options] = request.mock.calls[0]!;
  const body = JSON.parse(String(options!.body));
  expect(url).toBe(provider.url);
  expect(options).toMatchObject({ redirect: 'error', headers: { authorization: 'Bearer private-token' } });
  expect(body).toMatchObject({ model: 'deepseek-flash', tools: INBOX_READ_TOOLS, tool_choice: 'auto', store: false });
  expect(body.tools.map((t: { type: string }) => t.type)).toEqual(Array(7).fill('function'));
  expect(body).not.toHaveProperty('cwd');
  expect(body).not.toHaveProperty('max_output_tokens');
  expect(body).not.toHaveProperty('max_tokens');
  expect(analysisBody(job('a'), provider)).not.toHaveProperty('max_output_tokens');
  expect(provider.model).toBe('default-model');
  expect(f.call).not.toHaveBeenCalled();
});

it('executes validated chat reads and returns call outputs to the next model round', async () => {
  const f = fixture();
  const request = vi.fn<typeof fetch>().mockResolvedValueOnce(response([toolCall()])).mockResolvedValueOnce(response([message([answer('a', 'needed')])]));
  expect(await run(f.tools, request)).toEqual([answer('a', 'needed')]);
  expect(f.call).toHaveBeenCalledWith(['im', '+threads-messages-list', '--thread=omt_topic', '--order=asc', '--page-size=50', '--as=user', '--no-reactions'], expect.any(AbortSignal));
  const second = JSON.parse(String(request.mock.calls[1]![1]!.body));
  expect(second.input).toContainEqual({ type: 'function_call_output', call_id: 'call_1', output: JSON.stringify({ messages: [], hasMore: false, nextPageToken: null, truncated: false }) });
});

it('repairs unquoted ISO timestamps from the observed failure before validating and dispatching the read', async () => {
  const f = fixture();
  const broken = { ...toolCall('read_chat_messages'), arguments: '{"chatId":"oc_source","start":2026-10-15T00:00:00.000Z,"end":2026-10-15T01:00:00.000Z,"pageToken":null}' };
  const request = vi.fn<typeof fetch>().mockResolvedValueOnce(response([broken])).mockResolvedValueOnce(response([message()]));
  expect(await run(f.tools, request)).toEqual([answer('a')]);
  expect(f.call).toHaveBeenCalledWith(expect.arrayContaining(['--chat-id=oc_source', '--start=2026-10-15T00:00:00.000Z', '--end=2026-10-15T01:00:00.000Z']), expect.any(AbortSignal));
});

it('lets the model correct a schema error without dispatching the invalid read', async () => {
  const f = fixture();
  const broken = { ...toolCall(), arguments: '{threadId:42, pageToken:null,}' };
  const request = vi.fn<typeof fetch>().mockResolvedValueOnce(response([broken]))
    .mockResolvedValueOnce(response([toolCall('read_thread_messages', { threadId: 'omt_topic' }, 'corrected')]))
    .mockResolvedValueOnce(response([message()]));
  expect(await run(f.tools, request)).toEqual([answer('a')]);
  expect(f.call).toHaveBeenCalledTimes(1);
  const feedback = JSON.parse(String(request.mock.calls[1]![1]!.body)).input.find((v: { type: string }) => v.type === 'function_call_output');
  expect(JSON.parse(feedback.output)).toMatchObject({ error: 'invalid_arguments' });
});

it('bounds schema corrections and rejects unauthorized tools even with repairable arguments', async () => {
  const f = fixture(); let round = 0;
  const request = vi.fn<typeof fetch>(async () => response([{ ...toolCall('read_thread_messages', {}, `call_${++round}`), arguments: '{threadId:42}' }]));
  await expect(run(f.tools, request)).rejects.toThrow('纠正次数');
  expect(request).toHaveBeenCalledTimes(3); expect(f.call).not.toHaveBeenCalled();
  const unsafe = { ...toolCall('exec_command', {}, 'unsafe'), arguments: '{command:"pwd",}' };
  await expect(run(f.tools, vi.fn(async () => response([toolCall(), unsafe])))).rejects.toThrow('不允许');
  expect(f.call).not.toHaveBeenCalled();
});

it('repairs result punctuation and defaults only omitted priority while retaining result integrity checks', async () => {
  const m = (text: string) => ({ type: 'message', content: [{ type: 'output_text', text }] });
  expect(await run(fixture().tools, vi.fn(async () => response([m("{items:[{id:'a',state:'quiet',reason:'无需动作',},],}")]))))
    .toEqual([{ id: 'a', state: 'quiet', reason: '无需动作', priority: 'normal' }]);
  for (const text of ["{items:[{id:'a',state:'quiet'}]}", "{items:[{id:'a',state:'wrong',reason:'x'}]}",
    "{items:[{id:'a',state:'quiet',reason:'x',priority:'critical'}]}", "{items:[{id:'a',state:'quiet',reason:'x'},{id:'a',state:'quiet',reason:'x'}]}"]) {
    await expect(run(fixture().tools, vi.fn(async () => response([m(text)])))).rejects.toThrow();
  }
});

it('accepts a long reasoning stream without a cumulative size cap or reasoning previews', async () => {
  const progress = vi.fn();
  const reasoning = `data: ${JSON.stringify({ type: 'response.reasoning_text.delta', delta: 'x'.repeat(1000) })}\n\n`;
  const final = `data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: [message()] } })}\n\n`;
  const raw = reasoning.repeat(2200) + final;
  expect(raw.length).toBeGreaterThan(2_000_000);
  const result = await requestInboxResponse({}, provider, new AbortController().signal,
    vi.fn(async () => new Response(raw, { headers: { 'content-type': 'text/event-stream' } })), progress);
  expect(result.status).toBe('completed'); expect(progress).not.toHaveBeenCalled();
});

it('still rejects an oversized individual event and a provider-truncated response', async () => {
  const event = 'data: ' + 'x'.repeat(2_000_001);
  await expect(requestInboxResponse({}, provider, new AbortController().signal,
    vi.fn(async () => new Response(event, { headers: { 'content-type': 'text/event-stream' } })))).rejects.toThrow('事件超出限制');
  const raw = `data: ${JSON.stringify({ type: 'response.incomplete', response: { status: 'incomplete', output: [message()] } })}\n\n`;
  await expect(requestInboxResponse({}, provider, new AbortController().signal,
    vi.fn(async () => new Response(raw, { headers: { 'content-type': 'text/event-stream' } })))).rejects.toThrow('未完成');
});

it('validates cross-domain calls in the whole response before dispatching any', async () => {
  const f = fixture();
  const request = vi.fn<typeof fetch>(async () => response([toolCall(), toolCall('call_lark_read_tool',
    { operation: 'docs +update', argumentsJson: '{}' }, 'bad')]));
  await expect(run(f.tools, request)).rejects.toThrow('不允许');
  expect(f.call).not.toHaveBeenCalled();
});

it.each(['exec', 'exec_command', 'read_file', 'apply_patch', 'mcp__grafana__query', 'messages_send', 'download_resources', 'spawn_agent', 'constructor', '__proto__'])('rejects unauthorized %s before any CLI execution', async name => {
  const f = fixture();
  const request = vi.fn<typeof fetch>(async () => response([toolCall(), toolCall(name, {}, 'call_bad')]));
  await expect(run(f.tools, request)).rejects.toThrow('不允许');
  expect(f.call).not.toHaveBeenCalled();
});

it.each(['local_shell_call', 'computer_call', 'mcp_call', 'web_search_call', 'custom_tool_call'])('rejects provider-side %s items', async type => {
  const f = fixture();
  await expect(run(f.tools, vi.fn(async () => response([{ type }])))).rejects.toThrow('不允许');
  expect(f.call).not.toHaveBeenCalled();
});

it('refuses duplicate call IDs, including across rounds', async () => {
  const f = fixture();
  const request = vi.fn<typeof fetch>(async () => response([toolCall()]));
  await expect(run(f.tools, request)).rejects.toThrow('格式');
  expect(f.call).toHaveBeenCalledTimes(1);
});

it.each(['missing', 'duplicate', 'partial'] as const)('rejects %s final results', async kind => {
  const request = vi.fn<typeof fetch>(async () => response([message(kind === 'missing' ? [] : kind === 'duplicate' ? [answer('a'), answer('a')] : [answer('a')])], kind === 'partial' ? 'incomplete' : 'completed'));
  await expect(run(fixture().tools, request)).rejects.toThrow();
});

it('retains uncertainty and returns necessary query failures for automatic retry', async () => {
  const request = vi.fn<typeof fetch>(async () => response([message([answer('a', 'uncertain'), answer('b', 'retry')])]));
  expect((await run(fixture().tools, request, [job('a'), job('b')])).map(r => r.state)).toEqual(['uncertain', 'pending']);
  const f = fixture(); f.call.mockRejectedValueOnce(new Error('飞书读取失败'));
  await expect(run(f.tools, vi.fn(async () => response([toolCall()])))).rejects.toThrow('飞书读取失败');
});

it('streams only answer previews, without raw tool content or private reasoning', async () => {
  const progress = vi.fn();
  const completed = { status: 'completed', output: [message([answer('a', 'needed')])] };
  const events = [{ type: 'response.reasoning_text.delta', delta: 'private-reasoning' },
    { type: 'response.output_text.delta', delta: '{"items":[{"id":"a","reason":"需要确认' },
    { type: 'response.completed', response: completed }];
  const request = vi.fn<typeof fetch>(async () => new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } }));
  await triageWithChatTools([job('a')], '', provider, fixture().tools, new AbortController().signal, progress, request);
  expect(progress).toHaveBeenCalledWith([{ id: 'a', text: '需要确认' }]);
  expect(JSON.stringify(progress.mock.calls)).not.toMatch(/private-/);
});

it('passes 50 items and rejects oversized batches before a model request', async () => {
  const jobs = Array.from({ length: 50 }, (_, i) => job(String(i)));
  const request = vi.fn<typeof fetch>(async () => response([message(jobs.map(j => answer(j.id)))]));
  expect(await run(fixture().tools, request, jobs)).toHaveLength(50);
  expect(JSON.parse(JSON.parse(String(request.mock.calls[0]![1]!.body)).input[0].content).items).toHaveLength(50);
  await expect(run(fixture().tools, request, [...jobs, job('extra')])).rejects.toThrow('50');
  expect(request).toHaveBeenCalledTimes(1);
});

it('cancels model requests and never accepts late results or starts a tool after cancellation', async () => {
  const controller = new AbortController(); const f = fixture();
  const request = vi.fn<typeof fetch>(async () => { controller.abort(); return response([toolCall()]); });
  await expect(run(f.tools, request, [job('a')], controller.signal)).rejects.toThrow();
  expect(f.call).not.toHaveBeenCalled();
});

it('propagates timeout to the in-flight tool and redacts operational errors', async () => {
  let stopped = false;
  const tools = new InboxReadTools(async (_args, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => { stopped = true; reject(signal.reason); }, { once: true });
  }));
  await expect(triageWithChatTools([job('a')], '', provider, tools, new AbortController().signal, undefined,
    vi.fn(async () => response([toolCall()])), 20)).rejects.toThrow('超时');
  expect(stopped).toBe(true);
  expect(triageFailureReason(Error('HTTP 401 Bearer sensitive-token'))).toBe('工具或模型授权暂不可用');
});

it('defaults omitted priority to normal while preserving all decisions and explicit high priority', async () => {
  const items = ['quiet', 'needed', 'uncertain', 'retry'].map((state, index) => ({ id: String(index), state, reason: '具体事实' }));
  const request = vi.fn<typeof fetch>(async () => response([{ type: 'message', role: 'assistant', content: [{ type: 'output_text',
    text: JSON.stringify({ items: [...items, { ...answer('urgent', 'needed'), priority: 'high' }] }) }] }]));
  const result = await run(fixture().tools, request, [...items.map(item => job(item.id)), job('urgent')]);
  expect(result.map(item => item.state)).toEqual(['quiet', 'needed', 'uncertain', 'pending', 'needed']);
  expect(result.map(item => item.priority)).toEqual(['normal', 'normal', 'normal', 'normal', 'high']);
});

it.each([{ reason: '' }, { reason: undefined }, { state: undefined }, { id: 'unknown' }, { priority: 'urgent' }, { priority: null }])(
  'still rejects invalid final fields %j', async fields => {
    const request = vi.fn<typeof fetch>(async () => response([message([{ ...answer('a'), ...fields } as ReturnType<typeof answer>])]));
    await expect(run(fixture().tools, request)).rejects.toThrow('无效');
  });
