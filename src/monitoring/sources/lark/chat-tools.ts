import { parseMessages } from '../../../inbox/lark';
import { messageIdentity } from '../../../inbox/identity';
import { InboxToolArgumentsError, obj, type Obj } from '../../../inbox/values';

const optionalText = { type: ['string', 'null'] };
const page = { pageToken: { ...optionalText, description: '上一页返回的 nextPageToken；首页传 null。' } };
const range = { start: { ...optionalText, description: 'ISO 8601 起始时间，带时区；不限制传 null。' },
  end: { ...optionalText, description: 'ISO 8601 结束时间，带时区；不限制传 null。' } };
const definition = (name: string, description: string, properties: Obj) => ({ type: 'function', name, description,
  strict: true, parameters: { type: 'object', properties, required: Object.keys(properties), additionalProperties: false } });

export const INBOX_CHAT_TOOLS = [
  definition('search_messages', '只读搜索本人可读取的飞书聊天消息。关键词或 chatId 至少提供一个，优先限定相关会话。',
    { query: optionalText, chatId: optionalText, ...range, ...page }),
  definition('read_chat_messages', '只读查看指定飞书会话的消息，按时间倒序。旧话题的新回复请用搜索或读取话题。',
    { chatId: { type: 'string' }, ...range, ...page }),
  definition('read_thread_messages', '只读查看飞书话题及回复，按时间正序。',
    { threadId: { type: 'string', description: 'omt_ 话题 ID 或 om_ 根消息 ID。' }, ...page }),
  definition('get_messages', '只读查看已知消息 ID 的内容及话题回复，不下载附件。',
    { messageIds: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 20 } }),
];

const invalid = () => new InboxToolArgumentsError('飞书聊天工具参数无效');
function string(value: unknown, limit: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > limit || /[\x00-\x1f\x7f]/u.test(value)) throw invalid();
  return value;
}
function id(value: unknown, pattern: RegExp): string {
  const text = string(value, 128);
  if (!pattern.test(text)) throw invalid();
  return text;
}

/** The only model-to-CLI boundary: fixed read commands, typed values, no caller-supplied flags. */
export function chatToolArgs(name: string, input: unknown): string[] {
  const tool = INBOX_CHAT_TOOLS.find(t => t.name === name);
  if (!tool) throw new Error('不允许的工具调用');
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid();
  const data = obj(input);
  if (Object.keys(data).some(k => !tool.parameters.required.includes(k))) throw invalid();
  const args = ['im'];
  if (name === 'search_messages') {
    args.push('+messages-search');
    if (data.query != null) args.push(`--query=${string(data.query, 300)}`);
    if (data.chatId != null) args.push(`--chat-id=${id(data.chatId, /^oc_\w+$/)}`);
    if (data.query == null && data.chatId == null) throw invalid();
  } else if (name === 'read_chat_messages') {
    args.push('+chat-messages-list', `--chat-id=${id(data.chatId, /^oc_\w+$/)}`, '--order=desc');
  } else if (name === 'read_thread_messages') {
    args.push('+threads-messages-list', `--thread=${id(data.threadId, /^(om|omt)_\w+$/)}`, '--order=asc');
  } else {
    if (!Array.isArray(data.messageIds) || !data.messageIds.length || data.messageIds.length > 20) throw invalid();
    args.push('+messages-mget', `--message-ids=${data.messageIds.map(v => id(v, /^om_\w+$/)).join(',')}`);
  }
  for (const key of ['start', 'end']) if (data[key] != null) {
    const value = string(data[key], 40);
    if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?(?:Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value))) throw invalid();
    // Search rejects fractional seconds; round outward to retain boundary messages.
    const seconds = Date.parse(value) / 1000;
    const rounded = (key === 'start' ? Math.floor(seconds) : Math.ceil(seconds)) * 1000;
    args.push(`--${key}=${new Date(rounded).toISOString().replace('.000Z', 'Z')}`);
  }
  if (typeof data.start === 'string' && typeof data.end === 'string' && Date.parse(data.start) > Date.parse(data.end)) throw invalid();
  if (data.pageToken != null) args.push(`--page-token=${string(data.pageToken, 2048)}`);
  if (name !== 'get_messages') args.push('--page-size=50');
  return [...args, '--as=user', '--no-reactions'];
}

export class InboxChatTools {
  constructor(private call: (args: string[], signal: AbortSignal) => Promise<Obj>, private ownerOpenId?: string) {}
  async execute(name: string, input: unknown, signal: AbortSignal): Promise<Obj> {
    const args = chatToolArgs(name, input);
    signal.throwIfAborted();
    const result = await this.call(args, signal);
    signal.throwIfAborted();
    if (!Array.isArray(result.messages)) throw new Error('飞书消息结果不完整');
    const parsed = parseMessages(result.messages);
    let budget = 40_000;
    let truncated = false;
    const messages = [];
    for (const m of parsed) {
      if (messages.length >= 60 || budget <= 0) { truncated = true; break; }
      const text = m.text.slice(0, Math.min(budget, 4000));
      truncated ||= text.length < m.text.length; budget -= text.length;
      messages.push({ id: m.id, chatId: m.chatId, chatName: m.chatName.slice(0, 100), threadId: m.threadId,
        parentId: m.parentId, time: new Date(m.time).toISOString(), ...messageIdentity(m, this.ownerOpenId),
        sender: m.senderName.slice(0, 100), bot: m.bot, text });
    }
    const hasMore = result.has_more === true;
    if (hasMore && (typeof result.page_token !== 'string' || !result.page_token || result.page_token.length > 2048)) {
      throw new Error('飞书消息分页不完整');
    }
    return { messages, hasMore, nextPageToken: hasMore ? result.page_token : null, truncated };
  }
}
