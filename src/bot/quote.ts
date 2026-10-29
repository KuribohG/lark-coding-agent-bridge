import type {
  ApiMessageItem,
  LarkChannel,
  RawMessageEvent,
} from '@larksuite/channel';
import { normalize } from '@larksuite/channel';
import { log } from '../core/logger';
import { expandInteractiveCard } from './interactive-card';

export interface QuotedContext {
  messageId: string;
  senderId: string;
  /** Bot open_id exposed by Lark for app senders. */
  openBotId?: string;
  senderName?: string;
  /** Human vs bot, derived from the Feishu `sender.sender_type`. Undefined when
   * the source item didn't carry it (single-quote fetch path). */
  senderType?: 'user' | 'bot';
  /** ISO timestamp of the quoted message's creation. Empty when SDK can't
   * resolve it from the fetched item. */
  createdAt: string;
  /** Normalized human-readable content. For text/post this is plain text;
   * for merge_forward the SDK expands the tree into `<forwarded_messages>...
   * </forwarded_messages>` (capped at 50 items by the SDK). */
  content: string;
  rawContentType: string;
}

const TOPIC_CONTEXT_ITEM_OVERHEAD = 256;
const TOPIC_CONTEXT_TRUNCATION_MARKER = '\n\n[话题上下文过长，中间内容已省略]\n\n';
export const LARK_CONTEXT_MAX_CHARS = 30_000;

export type TopicContextIncompleteReason =
  | 'fetch-failed'
  | 'message-limit'
  | 'char-limit'
  | 'normalize-failed'
  | 'anchor-fetch-failed';

export interface TopicContextFetchResult {
  messages: QuotedContext[];
  /** True only when every message in the requested window was fetched and fit. */
  complete: boolean;
  reason?: TopicContextIncompleteReason;
}

/**
 * Fetch and normalize the content of a message that the user is reply-quoting.
 *
 * Why this is non-trivial: `im.v1.message.get` returns a flat `ApiMessageItem`
 * list (parent + descendants for merge_forward), but the bot intake pipeline
 * deals in `NormalizedMessage`. We synthesize a `RawMessageEvent` from the
 * parent item and feed it through the SDK's `normalize` so merge_forward gets
 * the same `<forwarded_messages>` expansion path that live events do.
 *
 * `chatId` / `chatType` on the synthesized raw event don't have to be real —
 * normalize doesn't validate them, and downstream only uses the resulting
 * `content`. Same for mentions (we don't pass any).
 */
/**
 * Rewrite an interactive sub-message's body.content so the SDK's
 * `convertInteractive` → `walkCard` finds a text node and emits real card
 * content instead of the literal `[interactive card]` placeholder. We wrap
 * our expanded `<interactive_card>` block as a `plain_text` node — that's
 * one of the three tags walkCard treats as text-bearing
 * (plain_text / lark_md / markdown).
 *
 * This is the merge_forward fix: sub-messages bypass the parent-level
 * expansion because the SDK assembles `<forwarded_messages>` internally from
 * each sub's flattened form, so we have to inject expansion at the sub-fetch
 * layer.
 */
function preExpandInteractive(item: ApiMessageItem): ApiMessageItem {
  if (item.msg_type !== 'interactive') return item;
  const raw = item.body?.content;
  if (typeof raw !== 'string' || raw.length === 0) return item;
  const expanded = expandInteractiveCard('[interactive card]', raw);
  // expandInteractiveCard returns the placeholder unchanged when there's
  // nothing to expand — skip rewriting in that case to avoid double wrapping.
  if (expanded === '[interactive card]') return item;
  const wrapper = JSON.stringify({ tag: 'plain_text', content: expanded });
  return { ...item, body: { ...item.body, content: wrapper } };
}

export async function fetchQuotedContext(
  channel: LarkChannel,
  messageId: string,
  opts: { maxChars?: number } = {},
): Promise<QuotedContext | undefined> {
  let items: ApiMessageItem[];
  try {
    // Ask for the original card JSON (incl. v2 user_dsl) instead of the
    // default v1-canonical fallback that strips it.
    items = await channel.fetchRawMessage(messageId, {
      cardContentType: 'user_card_content',
    });
  } catch (err) {
    log.warn('quote', 'fetch-failed', {
      messageId,
      err: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
  const parent = items[0];
  if (!parent || !parent.message_id) return undefined;

  // Reuse the already-fetched items when the SDK re-asks for sub-messages of
  // this same id (merge_forward case). For nested merge_forwards inside, fetch
  // fresh — and let a fetch failure throw so it surfaces as a fetch_failed
  // forward rather than a silently-empty one (see fetchSubTreeItems).
  const fetchSubMessages = async (mid: string): Promise<ApiMessageItem[]> => {
    if (mid === parent.message_id) return items.map(preExpandInteractive);
    const subItems = await fetchSubTreeItems(channel, mid);
    return subItems.map(preExpandInteractive);
  };

  const quoted = await normalizeItemToQuoted(channel, parent, fetchSubMessages);
  if (!quoted) return undefined;
  return boundTopicContext(
    [quoted],
    opts.maxChars ?? LARK_CONTEXT_MAX_CHARS,
  ).messages[0];
}

function mapSenderType(raw: unknown): 'user' | 'bot' | undefined {
  if (raw === 'user') return 'user';
  if (raw === 'app' || raw === 'bot') return 'bot';
  return undefined;
}

/**
 * Normalize a single fetched message item (from `im.v1.message.get` or
 * `im.v1.message.list`) into a {@link QuotedContext}. Shared by the reply-quote
 * path and the topic-context path. `fetchSubMessages` resolves merge_forward
 * children — callers decide whether to reuse an already-fetched batch or fetch
 * fresh.
 */
async function normalizeItemToQuoted(
  channel: LarkChannel,
  parent: ApiMessageItem,
  fetchSubMessages: (mid: string) => Promise<ApiMessageItem[]>,
): Promise<QuotedContext | undefined> {
  if (!parent.message_id) return undefined;
  const senderOpenId = parent.sender?.id;
  const fakeRaw: RawMessageEvent = {
    sender: { sender_id: { open_id: senderOpenId } },
    message: {
      message_id: parent.message_id,
      // chat_id / chat_type aren't actually used by normalize's converters,
      // but the field is required by the type. Empty strings are safe.
      chat_id: '',
      chat_type: 'group',
      message_type: parent.msg_type ?? 'text',
      content: parent.body?.content ?? '',
      create_time: parent.create_time !== undefined ? String(parent.create_time) : undefined,
      mentions: parent.mentions,
    },
  };

  const botIdentity = channel.botIdentity ?? { openId: '', name: '' };
  try {
    const normalized = await normalize(fakeRaw, {
      botIdentity,
      fetchSubMessages,
      // We want the raw content here, not the trimmed @bot mention form.
      stripBotMentions: false,
    });
    const createMs = parent.create_time
      ? Number.parseInt(String(parent.create_time), 10)
      : 0;
    const sender = parent.sender as (ApiMessageItem['sender'] & {
      name?: unknown;
      open_bot_id?: unknown;
    }) | undefined;
    return {
      messageId: parent.message_id,
      senderId: senderOpenId ?? '',
      ...(typeof sender?.open_bot_id === 'string' && sender.open_bot_id
        ? { openBotId: sender.open_bot_id }
        : {}),
      senderName: typeof sender?.name === 'string' && sender.name
        ? sender.name
        : normalized.senderName,
      senderType: mapSenderType(sender?.sender_type),
      createdAt: Number.isFinite(createMs) && createMs > 0
        ? new Date(createMs).toISOString()
        : '',
      // For zero-text interactive cards the SDK gave us "[interactive card]"
      // — substitute the raw JSON so Claude can still see what was quoted.
      content: expandInteractiveCard(normalized.content, parent.body?.content),
      rawContentType: parent.msg_type ?? 'text',
    };
  } catch (err) {
    log.warn('quote', 'normalize-failed', {
      messageId: parent.message_id,
      err: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

/**
 * Fetch a Feishu topic's upstream messages (chronological) so the agent has the
 * conversation it's being pulled into. Feishu's `im.v1.message.list` with
 * `container_id_type=thread` returns every message in the topic — including the
 * root that may never have @-mentioned the bot. The channel uses a timestamp
 * cursor on resumed sessions so only unseen messages are imported.
 *
 * `excludeIds` drops the triggering messages and any explicit reply-quotes so
 * they aren't duplicated. Fetching newest-first keeps `maxMessages` correct
 * for long topics, while `maxChars` bounds what reaches the model.
 */
export async function fetchTopicContext(
  channel: LarkChannel,
  threadId: string,
  opts: {
    maxMessages: number;
    maxChars?: number;
    sinceMs?: number;
    untilMs?: number;
    anchorMessageId?: string;
    excludeIds?: Set<string>;
    selfOpenId?: string;
    selfAppId?: string;
  },
): Promise<TopicContextFetchResult> {
  const collected: ApiMessageItem[] = [];
  const exclude = opts.excludeIds ?? new Set<string>();
  let pageToken: string | undefined;
  let reachedSince = false;
  let hitMessageLimit = false;
  let incompleteReason: TopicContextIncompleteReason | undefined;
  try {
    do {
      const res = await channel.rawClient.im.v1.message.list({
        params: {
          container_id_type: 'thread',
          container_id: threadId,
          sort_type: 'ByCreateTimeDesc',
          page_size: 50,
          ...(pageToken ? { page_token: pageToken } : {}),
        },
      });
      const data = (res as {
        data?: { items?: ApiMessageItem[]; messages?: ApiMessageItem[]; has_more?: boolean; page_token?: string };
      }).data;
      const items = data?.items ?? data?.messages ?? [];
      for (let index = 0; index < items.length; index += 1) {
        const item = items[index]!;
        const createdAt = messageCreateMs(item);
        if (opts.untilMs !== undefined && createdAt !== undefined && createdAt > opts.untilMs) {
          continue;
        }
        if (opts.sinceMs !== undefined && createdAt !== undefined && createdAt <= opts.sinceMs) {
          reachedSince = true;
          break;
        }
        const sender = item.sender as (ApiMessageItem['sender'] & {
          open_bot_id?: unknown;
        }) | undefined;
        if (
          !item.message_id ||
          exclude.has(item.message_id) ||
          (opts.selfOpenId &&
            sender?.open_bot_id === opts.selfOpenId) ||
          (opts.selfAppId && sender?.id === opts.selfAppId) ||
          (item as { deleted?: boolean }).deleted
        ) {
          continue;
        }
        collected.push(item);
        if (collected.length >= opts.maxMessages) {
          hitMessageLimit = index < items.length - 1 || data?.has_more === true;
          break;
        }
      }
      pageToken = data?.has_more ? data.page_token : undefined;
    } while (pageToken && !reachedSince && collected.length < opts.maxMessages);
  } catch (err) {
    log.warn('topic', 'context-fetch-failed', {
      threadId,
      err: err instanceof Error ? err.message : String(err),
    });
    return { messages: [], complete: false, reason: 'fetch-failed' };
  }
  if (hitMessageLimit && !reachedSince) {
    incompleteReason = 'message-limit';
    log.info('topic', 'context-truncated', {
      threadId,
      maxMessages: opts.maxMessages,
      sinceMs: opts.sinceMs,
    });
  }

  collected.sort((a, b) => (messageCreateMs(a) ?? 0) - (messageCreateMs(b) ?? 0));

  const out: QuotedContext[] = [];
  for (const item of collected) {
    const fetchSubMessages = async (mid: string): Promise<ApiMessageItem[]> => {
      const source = mid === item.message_id ? [item] : await fetchSubTreeItems(channel, mid);
      return source.map(preExpandInteractive);
    };
    const quoted = await normalizeItemToQuoted(channel, item, fetchSubMessages);
    if (quoted) out.push(quoted);
    else incompleteReason ??= 'normalize-failed';
  }

  if (
    opts.sinceMs === undefined &&
    opts.anchorMessageId &&
    !exclude.has(opts.anchorMessageId) &&
    !out.some(item => item.messageId === opts.anchorMessageId)
  ) {
    try {
      const items = await channel.fetchRawMessage(opts.anchorMessageId, {
        cardContentType: 'user_card_content',
      });
      const anchor = items[0];
      if (anchor) {
        const quoted = await normalizeItemToQuoted(
          channel,
          anchor,
          async (mid) => (mid === anchor.message_id
            ? items.map(preExpandInteractive)
            : (await fetchSubTreeItems(channel, mid)).map(preExpandInteractive)),
        );
        if (quoted) out.unshift(quoted);
      }
    } catch (err) {
      incompleteReason ??= 'anchor-fetch-failed';
      log.warn('topic', 'anchor-fetch-failed', {
        threadId,
        messageId: opts.anchorMessageId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  out.sort(compareQuotedContextTime);
  const bounded = boundTopicContext(
    out,
    opts.maxChars,
    opts.sinceMs === undefined ? opts.anchorMessageId : undefined,
  );
  if (bounded.truncated) incompleteReason ??= 'char-limit';
  return {
    messages: bounded.messages,
    complete: incompleteReason === undefined,
    ...(incompleteReason ? { reason: incompleteReason } : {}),
  };
}

function boundTopicContext(
  items: QuotedContext[],
  maxChars: number | undefined,
  anchorMessageId?: string,
): { messages: QuotedContext[]; truncated: boolean } {
  if (maxChars === undefined || maxChars <= 0) {
    return { messages: items, truncated: false };
  }
  const selected: QuotedContext[] = [];
  const order = new Map(items.map((item, index) => [item.messageId, index]));
  let used = 0;
  let truncated = false;
  const anchor = anchorMessageId
    ? items.find(item => item.messageId === anchorMessageId)
    : undefined;
  if (anchor) {
    const fitted = fitTopicContextItem(anchor, Math.min(maxChars, 6_000));
    if (fitted) {
      if (fitted.content !== anchor.content) truncated = true;
      selected.push(fitted);
      used += quotedContextChars(fitted);
    } else {
      truncated = true;
    }
  }
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]!;
    if (item.messageId === anchor?.messageId) continue;
    const fitted = fitTopicContextItem(item, maxChars - used);
    if (!fitted) {
      truncated = true;
      continue;
    }
    if (fitted.content !== item.content) truncated = true;
    selected.push(fitted);
    used += quotedContextChars(fitted);
  }
  return {
    messages: selected.sort((a, b) =>
      (order.get(a.messageId) ?? 0) - (order.get(b.messageId) ?? 0)),
    truncated,
  };
}

function fitTopicContextItem(item: QuotedContext, maxChars: number): QuotedContext | undefined {
  const needed = quotedContextChars(item);
  if (needed <= maxChars) return item;
  const contentBudget = maxChars - TOPIC_CONTEXT_ITEM_OVERHEAD - TOPIC_CONTEXT_TRUNCATION_MARKER.length;
  if (contentBudget < 512) return undefined;
  const head = Math.ceil(contentBudget * 0.65);
  const tail = contentBudget - head;
  const clipped = tail > 0
    ? `${item.content.slice(0, head)}${TOPIC_CONTEXT_TRUNCATION_MARKER}${item.content.slice(-tail)}`
    : item.content.slice(0, head);
  return { ...item, content: clipped };
}

function quotedContextChars(item: QuotedContext): number {
  return TOPIC_CONTEXT_ITEM_OVERHEAD + item.content.length;
}

function messageCreateMs(item: ApiMessageItem): number | undefined {
  if (item.create_time === undefined) return undefined;
  const value = Number(item.create_time);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function compareQuotedContextTime(a: QuotedContext, b: QuotedContext): number {
  const left = Date.parse(a.createdAt);
  const right = Date.parse(b.createdAt);
  if (!Number.isFinite(left) || !Number.isFinite(right)) return 0;
  return left - right;
}

/**
 * Fetch a nested sub-message's items for merge_forward expansion. Unlike a
 * best-effort context fetch, this RE-THROWS on failure: the SDK's
 * convertMergeForward turns a throw into the `<forwarded_messages
 * status="fetch_failed"/>` sentinel, so a transient fetch failure surfaces as
 * fetch_failed instead of being silently flattened to an empty forward — the
 * same distinction @larksuite/channel makes on the live-event path. Passed into
 * `normalize` as `fetchSubMessages`.
 */
async function fetchSubTreeItems(
  channel: LarkChannel,
  messageId: string,
): Promise<ApiMessageItem[]> {
  try {
    return await channel.fetchRawMessage(messageId, { cardContentType: 'user_card_content' });
  } catch (err) {
    log.warn('quote', 'sub-fetch-failed', {
      messageId,
      err: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}
