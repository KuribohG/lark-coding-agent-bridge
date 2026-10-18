import catalogue from '../../../inbox/lark-read-catalogue.json';
import { chatToolArgs, INBOX_CHAT_TOOLS, InboxChatTools } from './chat-tools';
import { InboxToolArgumentsError, obj, type Obj } from '../../../inbox/values';
import { parseModelJson } from '../../../inbox/model-json';

interface Schema {
  type?: string;
  enum?: unknown[];
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
}
interface Operation {
  name: string;
  description: string;
  parameters: Record<string, Schema>;
  required: string[];
  fixed?: Record<string, string | number | boolean>;
}
// Reviewed catalogue: CLI risk=read plus user identity, excluding local files, credentials and write-like shortcuts.
const operations = new Map<string, Operation>((catalogue.operations as unknown as Operation[]).map(op => [op.name, op]));
const domains = [...new Set([...operations.keys()].map(name => name.split(' ')[0]!))];
const optionalText = { type: ['string', 'null'] };
const definition = (name: string, description: string, properties: Obj) => ({ type: 'function', name, description, strict: true,
  parameters: { type: 'object', properties, required: Object.keys(properties), additionalProperties: false } });
export const INBOX_READ_TOOLS = [...INBOX_CHAT_TOOLS,
  definition('list_lark_read_tools', '查找可用的飞书只读业务查询（文档、表格、日历、任务、邮件、知识库等）。只返回已审核目录，不执行命令。',
    { domain: { ...optionalText, description: `业务域：${domains.join(', ')}；不限定传 null。` }, query: optionalText,
      offset: { type: ['integer', 'null'], description: '分页偏移；首页传 0 或 null。' } }),
  definition('describe_lark_read_tool', '查看只读查询的参数 schema。先查此 schema，再构造 call_lark_read_tool 的 argumentsJson。',
    { operation: { type: 'string', description: '目录中的完整 operation 名称。' } }),
  definition('call_lark_read_tool', '执行目录中的飞书只读查询，仅使用当前用户已授权权限。不能写入、下载、操作本机或切换身份。',
    { operation: { type: 'string' }, argumentsJson: { type: 'string', description: '符合查询 schema 的 JSON 对象；键不带 --。不支持 @file、stdin 或输出路径。' } }),
];

const invalid = () => new InboxToolArgumentsError('飞书只读工具参数无效');
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
function record(value: unknown): Obj {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  return value as Obj;
}
function fields(value: unknown, keys: string[]): Obj {
  const data = record(value);
  if (Object.keys(data).some(k => !keys.includes(k))) throw invalid();
  return data;
}
function text(value: unknown, limit = 4000): string {
  if (typeof value !== 'string' || value.length > limit || /[\x00-\x1f\x7f]/u.test(value)) throw invalid();
  return value;
}
function operation(value: unknown): Operation {
  const op = operations.get(text(value, 120));
  if (!op) throw new Error('不允许的飞书工具调用');
  return op;
}

function validate(value: unknown, schema: Schema, key: string, depth = 0): void {
  if (depth > 12 || key === '__proto__' || key === 'constructor' || key === 'prototype') throw invalid();
  if (schema.type && !({ string: typeof value === 'string', boolean: typeof value === 'boolean', number: typeof value === 'number',
    integer: typeof value === 'number', array: Array.isArray(value), object: Boolean(value) && typeof value === 'object' && !Array.isArray(value) } as Record<string, boolean>)[schema.type]) throw invalid();
  if (schema.enum && !schema.enum.includes(value)) throw invalid();
  if (/^(page[-_]size|limit|max)$/.test(key) && (!Number.isInteger(Number(value)) || Number(value) < 1 || Number(value) > 100)) throw invalid();
  if (schema.type === 'object') {
    const data = record(value);
    if (schema.required?.some(k => !own(data, k))) throw invalid();
    for (const [k, v] of Object.entries(data)) {
      if (schema.properties && !own(schema.properties, k)) throw invalid();
      validate(v, schema.properties?.[k] ?? {}, k, depth + 1);
    }
  } else if (schema.type === 'array' || Array.isArray(value)) {
    if (!Array.isArray(value) || value.length > 100) throw invalid();
    for (const item of value) validate(item, schema.items ?? {}, key, depth + 1);
  } else if (schema.type === 'integer' || schema.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value) || (schema.type === 'integer' && !Number.isSafeInteger(value))) throw invalid();
  } else if (schema.type === 'boolean') {
    if (typeof value !== 'boolean') throw invalid();
  } else if (schema.type === 'string' || typeof value === 'string') {
    const s = text(value);
    // JSON-bearing CLI flags also accept @file and stdin. Only literal values may cross this boundary.
    if (s.trimStart().startsWith('@') || s.trim() === '-') throw invalid();
    // IDs become URL path segments in typed APIs; reject traversal, query injection and encoded separators.
    if (/(?:^|[-_])(id|ids|token|tokens)$/.test(key) && (/[\/\\%?#]/.test(s) || s.includes('..'))) throw invalid();
    if (['url', 'doc', 'presentation'].includes(key) && s.includes(':')) {
      let url: URL;
      try { url = new URL(s); } catch { throw invalid(); }
      if (url.protocol !== 'https:' || url.username || url.password || url.port ||
        !/^(?:[\w-]+\.)*(?:feishu\.cn|larksuite\.com)$/.test(url.hostname)) throw invalid();
    }
    if (['url', 'doc', 'presentation'].includes(key) && !s.includes(':') && !/^[\w-]+$/.test(s)) throw invalid();
  } else if (value && typeof value === 'object') {
    validate(value, { type: 'object' }, key, depth + 1);
  } else if (value !== null && typeof value !== 'number' && typeof value !== 'boolean') throw invalid();
}

export type ReadRequest = { kind: 'chat'; args: string[] } | { kind: 'call'; args: string[] } |
  { kind: 'list'; domain?: string; query: string; offset: number } | { kind: 'describe'; operation: Operation };

/** All model-originated calls pass this check, including when execute() is called without the model loop. */
export function readToolRequest(name: string, input: unknown): ReadRequest {
  if (INBOX_CHAT_TOOLS.some(t => t.name === name)) return { kind: 'chat', args: chatToolArgs(name, input) };
  if (name === 'list_lark_read_tools') {
    const data = fields(input, ['domain', 'query', 'offset']);
    const domain = data.domain == null ? undefined : text(data.domain, 40);
    if (domain && !domains.includes(domain)) throw invalid();
    const offset = data.offset ?? 0;
    if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0 || offset > operations.size) throw invalid();
    return { kind: 'list', domain, query: data.query == null ? '' : text(data.query, 120).toLowerCase(), offset };
  }
  if (name === 'describe_lark_read_tool') return { kind: 'describe', operation: operation(fields(input, ['operation']).operation) };
  if (name !== 'call_lark_read_tool') throw new Error('不允许的工具调用');
  const data = fields(input, ['operation', 'argumentsJson']);
  const op = operation(data.operation);
  if (typeof data.argumentsJson !== 'string' || data.argumentsJson.length > 16_000) throw invalid();
  let parsed: unknown;
  try { parsed = parseModelJson(data.argumentsJson); } catch { throw invalid(); }
  const args = record(parsed);
  validate(args, { type: 'object', properties: op.parameters, required: op.required }, 'arguments');
  const argv = op.name.split(' ');
  for (const [key, value] of Object.entries(args)) {
    // Fixed catalogue flag names only. Nested API params and bodies are serialized, never treated as files.
    if (key === 'params' || key === 'data') argv.push(`--${key}=${JSON.stringify(value)}`);
    else for (const item of Array.isArray(value) ? value : [value]) argv.push(`--${key}=${String(item)}`);
  }
  for (const [key, value] of Object.entries(op.fixed ?? {})) argv.push(`--${key}=${String(value)}`);
  return { kind: 'call', args: [...argv, '--as=user'] };
}

export class InboxReadTools {
  private chat: InboxChatTools;
  constructor(private call: (args: string[], signal: AbortSignal) => Promise<unknown>) {
    this.chat = new InboxChatTools(async (args, signal) => obj(await call(args, signal)));
  }
  async execute(name: string, input: unknown, signal: AbortSignal): Promise<Obj> {
    const request = readToolRequest(name, input);
    signal.throwIfAborted();
    if (request.kind === 'chat') return this.chat.execute(name, input, signal);
    if (request.kind === 'describe') {
      const op = request.operation;
      return { operation: op.name, description: op.description, parameters: { type: 'object', properties: op.parameters,
        required: op.required, additionalProperties: false }, fixed: op.fixed, identity: 'user' };
    }
    if (request.kind === 'list') {
      const found = [...operations.values()].filter(op => (!request.domain || op.name.startsWith(request.domain + ' ')) &&
        (!request.query || `${op.name} ${op.description}`.toLowerCase().includes(request.query)));
      return { domains, operations: found.slice(request.offset, request.offset + 40).map(op => ({ operation: op.name, description: op.description })),
        total: found.length, nextOffset: request.offset + 40 < found.length ? request.offset + 40 : null };
    }
    const result = await this.call(request.args, signal);
    signal.throwIfAborted();
    if (result === undefined) throw new Error('飞书查询结果缺失');
    const content = JSON.stringify(result);
    const data = obj(result);
    const pagination = Object.fromEntries(['has_more', 'page_token', 'next_page_token', 'next_cursor', 'cursor', 'hasMore', 'nextPageToken']
      .filter(key => own(data, key)).map(key => [key, data[key]]));
    return { content: content.slice(0, 40_000), truncated: content.length > 40_000, pagination,
      hint: '截断或存在后续页时需缩小范围或翻页，不能认为已读取全部结果。' };
  }
}
