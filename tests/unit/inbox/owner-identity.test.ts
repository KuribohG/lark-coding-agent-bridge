import { expect, it, vi } from 'vitest';
import { parseMessages } from '../../../src/inbox/lark';
import type { InboxJob } from '../../../src/inbox/types';
import { parseTriageResult } from '../../../src/monitoring/sources/lark/analyzer';
import { triageWithChatTools } from '../../../src/monitoring/sources/lark/codex-triage';
import { InboxReadTools } from '../../../src/monitoring/sources/lark/read-tools';
import { createLarkAssessment } from '../../../src/monitoring/sources/lark/assessment';

const raw = (id: string, mentioned: string) => ({ message_id: id, chat_id: 'oc_source', create_time: '1792050000000',
  content: '+ @同名用户', sender: { id: 'ou_sender', name: '同事', sender_type: 'user' },
  mentions: [{ id: mentioned, name: '同名用户' }] });
const job = { id: 'item', ownerKey: 'ou_owner',
  sourceRef: { transport: 'lark', containerId: 'oc_source', name: '项目群', kind: 'group' },
  messages: parseMessages([raw('om_other', 'ou_other'), raw('om_owner', 'ou_owner')]) } as InboxJob;
const answer = (ids: unknown = []) => ({ id: job.id, state: 'needed', reason: '需要确认本人负责系统的未解决故障',
  priority: 'normal', ownerMentionMessageIds: ids });
const response = (output: unknown[]) => new Response(JSON.stringify({ status: 'completed', output }),
  { headers: { 'content-type': 'application/json' } });
const result = (item: ReturnType<typeof answer>) => ({ type: 'message', role: 'assistant',
  content: [{ type: 'output_text', text: JSON.stringify(item) }] });
const provider = { url: 'https://model.test/responses', key: 'test-only', model: 'test-model' };

it.each([['om_other'], ['om_missing'], ['om_owner', 'om_other'], ['om_owner', 'om_owner'], null, 'om_owner', [7]].map(ids => ({ ids })))(
  'rejects wrong-owner or malformed mention evidence: %j', ({ ids }) => {
    expect(() => parseTriageResult(JSON.stringify(answer(ids)), job)).toThrow('本人 @ 证据');
  });

it('requires an explicit mention-evidence decision for actionable group items', () => {
  const { ownerMentionMessageIds: _, ...item } = answer();
  expect(() => parseTriageResult(JSON.stringify(item), job)).toThrow('本人 @ 证据');
});

it.each([[], ['om_owner']].map(ids => ({ ids })))('accepts system responsibility without a mention and preserves verified mention evidence: %j', ({ ids }) => {
  const decision = parseTriageResult(JSON.stringify(answer(ids)), job);
  expect(decision).toMatchObject({ state: 'needed', mentionedPrincipalMessageIds: ids });
  const interpreted = createLarkAssessment({} as never).interpret(job, decision!);
  expect(interpreted.attention).toMatchObject({ mentionedPrincipalMessageIds: ids });
});

it('corrects a wrong-owner claim before accepting the current item', async () => {
  const request = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(response([result(answer(['om_other']))]))
    .mockResolvedValueOnce(response([result({ ...answer(), state: 'quiet', reason: '@的是另一人，本人没有待处理动作' })]));
  const decision = await triageWithChatTools(job, '', provider, new InboxReadTools(async () => ({ messages: [] })),
    new AbortController().signal, undefined, request);
  expect(decision.state).toBe('quiet');
  const correction = JSON.parse(String(request.mock.calls[1]![1]!.body)).input.at(-1).content;
  expect(JSON.parse(correction)).toMatchObject({ expectedId: 'item', issue: expect.stringContaining('本人 @ 证据') });
});

it('validates mentions fetched from history rather than rejecting evidence absent from the initial excerpt', async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValueOnce(response([{ type: 'function_call', name: 'get_messages',
    call_id: 'read', arguments: JSON.stringify({ messageIds: ['om_history'] }) }]))
    .mockResolvedValueOnce(response([result(answer(['om_history']))]));
  const tools = new InboxReadTools(async () => ({ messages: [raw('om_history', 'ou_owner')] }), 'ou_owner');
  expect(await triageWithChatTools(job, '', provider, tools, new AbortController().signal, undefined, request))
    .toMatchObject({ mentionedPrincipalMessageIds: ['om_history'], state: 'needed' });
  const input = JSON.parse(String(request.mock.calls[1]![1]!.body)).input;
  expect(JSON.parse(input.at(-1).output).messages[0]).toMatchObject({ mentionsOwner: true,
    mentionDetails: [{ openId: 'ou_owner', name: '同名用户' }] });
});
