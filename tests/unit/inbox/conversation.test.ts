import { expect, it } from 'vitest';
import { normalizeInbox } from '../../../src/inbox/config';
import { workItemTarget } from '../../../src/inbox/lark-target';
import type { InboxJob, InboxMessage } from '../../../src/inbox/types';
import { boundMessages, classifyMessage, LarkConversation } from '../../../src/monitoring/sources/lark/conversation';

const now = 1_800_000_000_000;
const config = normalizeInbox({ recipientKey: 'ou_owner', intakeScope: 'private_mentions',
  target: workItemTarget({ chatId: 'oc_result', threadId: 'omt_result', replyTo: 'om_result' }) });
const message = (id: string, extra: Partial<InboxMessage> = {}): InboxMessage => ({ id, containerId: 'oc_team', containerName: 'team',
  containerKind: 'group', senderId: 'ou_peer', senderName: 'Peer', senderBot: false, time: now, text: `please check ${id}`, mentions: [], ...extra });
const item = (messages: InboxMessage[], extra: Partial<InboxJob> = {}): InboxJob => ({ id: `job-${messages[0]!.id}`, ownerKey: 'ou_owner', profile: 'p',
  target: config.target, sourceRef: { transport: 'lark', containerId: messages[0]!.containerId, name: 'team', kind: 'group', threadId: messages[0]!.threadId },
  messages, state: 'waiting', createdAt: now, updatedAt: now, automatic: true, alert: false, handlingState: 'open', intakeTrigger: 'mention', ...extra });
const conversation = (scope = config.intakeScope) => new LarkConversation({ ...config, intakeScope: scope }, ['cli_bot'], () => now);
const mention = { mentions: [{ id: 'ou_owner', name: 'Owner' }] };

it('creates an item for a mention and ignores unaddressed group chatter outside the "all" scope', () => {
  expect(conversation().route(message('a', mention), [])).toEqual({ kind: 'create' });
  expect(conversation().route(message('b'), [])).toEqual({ kind: 'ignore' });
  expect(conversation('all').route(message('b'), [])).toEqual({ kind: 'create' });
});

it('appends a follow-up in the same topic or reply chain to the open item', () => {
  const open = item([message('a', { ...mention, threadId: 'omt_1' })]);
  expect(conversation().route(message('b', { threadId: 'omt_1' }), [open])).toEqual({ kind: 'append', item: open, mention: false, alert: false });
  const plain = item([message('c', mention)]);
  expect(conversation().route(message('d', { replyTo: 'c', ...mention }), [plain])).toMatchObject({ kind: 'append', item: plain, mention: true });
});

it('treats an owner reply after the evidence as handling the item', () => {
  const open = item([message('a', { ...mention, threadId: 'omt_1', time: now - 10 })]);
  expect(conversation().route(message('b', { senderId: 'ou_owner', threadId: 'omt_1' }), [open])).toEqual({ kind: 'handled', items: [open] });
  expect(conversation().route(message('c', { senderId: 'ou_owner', threadId: 'omt_2' }), [open])).toEqual({ kind: 'handled', items: [] });
});

it('closes the incident a bot reports recovered and drops acknowledgements and direct bot messages', () => {
  const alert = message('a', { senderBot: true, senderId: 'cli_alert', text: '告警 firing', metadata: { incidentId: 'inc-1' }, ...mention });
  const open = item([alert], { incidentId: 'inc-1' });
  const recovery = message('b', { senderBot: true, senderId: 'cli_alert', text: 'resolved', metadata: { incidentId: 'inc-1', recovered: true } });
  expect(conversation().route(recovery, [open])).toEqual({ kind: 'recovered', items: [open] });
  expect(conversation().route(message('c', { ...mention, text: '收到' }), [])).toEqual({ kind: 'ignore' });
  expect(conversation().route(message('d', { containerKind: 'direct', senderBot: true }), [])).toEqual({ kind: 'ignore' });
});

it('excludes the assistant\'s own messages and result chats from evidence', () => {
  const c = conversation();
  expect(c.acceptsMessage(message('a', { senderId: 'cli_bot' }), [])).toBe(false);
  expect(c.acceptsMessage(message('b', { containerId: 'oc_result' }), [])).toBe(false);
  expect(c.safe(item([message('c', mention)]), [])).toBe(true);
  expect(c.accepts(item([message('d')], { intakeTrigger: 'group' }), [])).toBe(false);
});

it('classifies and bounds evidence', () => {
  expect(classifyMessage(message('a', { text: 'OK' }))).toBe('skip');
  expect(classifyMessage(message('b', { senderBot: true }))).toBe('alert');
  expect(classifyMessage(message('c'))).toBe('request');
  const bounded = boundMessages([message('x', { time: 1, text: 'x'.repeat(50) }), message('y', { time: 2, text: 'y'.repeat(50) })], 60);
  expect(bounded.map(m => [m.id, m.text.length])).toEqual([['y', 50]]);
});
