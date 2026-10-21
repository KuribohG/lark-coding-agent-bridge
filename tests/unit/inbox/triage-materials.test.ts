import { expect, it } from 'vitest';
import { normalizeInbox } from '../../../src/inbox/config';
import { triageMaterials } from '../../../src/monitoring/sources/lark/triage-materials';
import type { InboxJob, InboxMessage } from '../../../src/inbox/types';
import { processingPrompt } from '../../../src/monitoring/sources/lark/processor';

const message = (id: string, text: string, bot = false): InboxMessage => ({ id, text, bot, time: 1000,
  chatId: 'oc_source', chatName: 'service users', chatType: 'group', senderId: bot ? 'cli_helper' : 'ou_colleague',
  senderName: bot ? 'helper' : 'colleague', mentions: [], threadId: 'omt_topic' });
const job = (messages: InboxMessage[]): InboxJob => ({ id: 'item', ownerOpenId: 'ou_owner',
  source: { chatId: 'oc_source', name: 'service users', type: 'group', threadId: 'omt_topic' }, messages } as InboxJob);

it('keeps owner identity separate from another mention even when their display names match', () => {
  const item = job([{ ...message('om_other', '+ @本人'), mentions: ['ou_other'],
    mentionDetails: [{ openId: 'ou_other', name: '本人' }] },
    { ...message('om_owner', '我来核实'), senderId: 'ou_owner', senderName: '本人' }]);
  const materials = JSON.parse(triageMaterials(item, '本人姓名=本人；open_id=ou_owner'));
  expect(materials.background).toContain('open_id=ou_owner');
  expect(materials.item).toMatchObject({ ownerOpenId: 'ou_owner', directlyMentioned: false,
    messages: [{ senderIsOwner: false, mentionsOwner: false, mentionDetails: [{ openId: 'ou_other', name: '本人' }] },
      { senderIsOwner: true, mentionsOwner: false }] });
  const prompt = processingPrompt(item, materials.background);
  expect(prompt).not.toContain('该事项已被确认为需要本人处理');
  expect(prompt).toContain('"mentionDetails":[{"openId":"ou_other","name":"本人"}]');
});

it('retains the original question and report tail when a long incident ends with bot control/status messages', () => {
  const messages = [message('question', '任务失败是否和我们负责的文件系统有关？'),
    ...Array.from({ length: 22 }, (_, i) => message(`update_${i}`, '正在收集客户端证据')),
    message('report', '客户端断连。' + '长日志\n'.repeat(1000) + '反复发生，死因未明，请维护者核对退出原因。', true),
    message('working', '⏳ Working — 3 min — iteration 1/150', true),
    message('review', "💾 Self-improvement review: Skill 'incident-review' patched", true),
    message('empty', '[System: Empty message content sanitised to satisfy protocol]', true),
    message('stop', '@helper /stop'), message('stopped', 'No active task to stop.', true)];
  const item = JSON.parse(triageMaterials(job(messages), '', { triageMessageLimit: 6, triageMessageChars: 500 })).item;
  expect(item.totalMessages).toBe(29);
  expect(item.messages).toHaveLength(6);
  expect(item.messages[0].id).toBe('question');
  expect(item.messages.at(-1).id).toBe('stop');
  const report = item.messages.find((m: InboxMessage) => m.id === 'report');
  expect(report.text).toContain('客户端断连');
  expect(report.text).toContain('死因未明，请维护者核对退出原因');
  expect(report.text.length).toBeLessThanOrEqual(500);
  expect(report).toMatchObject({ truncated: true, originalChars: messages[23]!.text.length });
  expect(item).toMatchObject({ excerpt: true, omittedMessages: 23, omittedProgressMessages: 4 });
});

it('keeps explicit recovery evidence and does not discard substantive bot reports or human status text', () => {
  const messages = [message('question', '客户端反复断连'),
    message('recovery', '已确认退出原因并修复，重试成功，维护者无需继续处理。', true),
    message('human', 'No active task to stop.')];
  const item = JSON.parse(triageMaterials(job(messages), '')).item;
  expect(item.messages.map((m: InboxMessage) => m.id)).toEqual(['question', 'recovery', 'human']);
  expect(item).toMatchObject({ excerpt: false, omittedMessages: 0 });
});

it('marks long-message omission even when every message fits the count limit', () => {
  const item = JSON.parse(triageMaterials(job([message('report', 'a'.repeat(2001))]), '')).item;
  expect(item).toMatchObject({ excerpt: true, omittedMessages: 0 });
  expect(item.messages[0].text).toHaveLength(2000);
  expect(normalizeInbox({ triageMessageLimit: 1, triageMessageChars: Infinity })).toMatchObject({
    triageMessageLimit: 2, triageMessageChars: 2000 });
});

it('applies large configured excerpts to one item without combining unrelated contexts', () => {
  const config = normalizeInbox({ triageMessageLimit: 100, triageMessageChars: 16000 });
  const item = job(Array.from({ length: 10 }, (_, i) => message(`m_${i}`, '长'.repeat(10_000))));
  const material = JSON.parse(triageMaterials(item, '', config));
  expect(material.item.messages).toHaveLength(10);
  expect(material.item.messages[0].text).toHaveLength(10_000);
  expect(material).not.toHaveProperty('items');
});
