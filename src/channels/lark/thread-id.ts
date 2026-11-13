import type { LarkChannel } from '@larksuite/channel';
import { log } from '../../core/logger';

/**
 * Recover a message's topic `thread_id` (omt_*) via the raw `im.v1.message.get`
 * API.
 *
 * Feishu delivers a sizable fraction of topic-group message events (and every
 * card-action carrier) without a `thread_id` on the event payload — notably the
 * message that starts a new topic. The bridge routes topic replies and isolates
 * per-topic session scope off `thread_id`, so a missing one makes the reply
 * escape into a brand-new topic and collapses the scope to the chat level.
 *
 * The raw `im.v1.message.get` items DO carry `thread_id` even when the event
 * dropped it. We deliberately avoid `channel.fetchMessage()`: its
 * NormalizedMessage path rebuilds a synthetic raw event without `thread_id`, so
 * threadId always comes back undefined.
 *
 * `threadId` is undefined when the message genuinely has no thread; `failed`
 * marks the case where the API call itself failed, so the caller must not
 * mistake an unknown answer for a confirmed chat-level message.
 */
export interface MessageThreadIdLookup {
  threadId?: string;
  failed: boolean;
}

export async function lookupMessageThreadId(
  channel: LarkChannel,
  messageId: string,
): Promise<MessageThreadIdLookup> {
  try {
    const [parent] = await channel.fetchRawMessage(messageId);
    // ApiMessageItem's SDK type omits thread_id even though the API returns it.
    return { threadId: (parent as { thread_id?: string } | undefined)?.thread_id, failed: false };
  } catch (err) {
    log.warn('thread', 'thread-id-lookup-failed', {
      messageId,
      err: err instanceof Error ? err.message : String(err),
    });
    return { failed: true };
  }
}
