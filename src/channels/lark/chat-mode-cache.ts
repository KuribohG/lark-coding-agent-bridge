import type { LarkChannel, NormalizedMessage } from '@larksuite/channel';
import { log } from '../../core/logger';
import { lookupMessageThreadId } from './thread-id';

export type ChatMode = 'p2p' | 'group' | 'topic';

export interface ResolvedScope {
  scope: string;
  threadId?: string;
  mode: ChatMode;
  /**
   * True when finding the session needed an API call that failed, so `scope`
   * is the conservative chat-level fallback rather than a confirmed answer.
   * Callers that can recover the scope from their own records (a pending
   * question, a card payload) must do so instead of trusting it.
   */
  unverified: boolean;
}

/**
 * In-memory cache for `channel.getChatMode()` results.
 *
 * Why: chat mode (`p2p` / `group` / `topic`) doesn't change within a chat's
 * lifetime under normal use, and the SDK doesn't expose it on the message
 * event — so we cache by chatId to avoid an `im.v1.chat.get` round-trip per
 * message. Admins can still convert a regular group into a topic group: the
 * channel layer treats a message-level `threadId` as authoritative and calls
 * `invalidate(chatId)` whenever a cached non-topic answer is contradicted, so
 * the next resolve re-probes and a stale `group` entry can't outlive one
 * message.
 *
 * On lookup failure (network / permission / unknown chatId) we **fall back
 * to 'group'** — that's the conservative default since it means "treat as
 * a normal chat, one session per chatId, no thread split". The fallback is
 * reported as `unverified` so callers can recover the real scope from their
 * own records instead of routing a topic action to the chat level.
 */
export class ChatModeCache {
  private readonly cache = new Map<string, ChatMode>();

  /** Text and card commands must address the same native conversation. Cards
   * lack threadId, so their carrier is checked even when chat metadata says group.
   */
  async resolveScope(channel: LarkChannel, message: Pick<NormalizedMessage, 'chatId' | 'messageId' | 'threadId'>,
    source: 'message' | 'card' = 'message'): Promise<ResolvedScope> {
    const { chatId, messageId } = message;
    let threadId = message.threadId;
    let mode: ChatMode;
    let unverified = false;
    if (threadId) mode = 'topic';
    else {
      const resolved = await this.resolveOutcome(channel, chatId);
      mode = resolved.mode;
      unverified = resolved.failed;
    }
    if (!threadId && (mode === 'topic' || (source === 'card' && mode === 'group'))) {
      const lookup = await lookupMessageThreadId(channel, messageId);
      if (lookup.threadId) {
        threadId = lookup.threadId;
        if (this.cache.get(chatId) !== 'topic') this.invalidate(chatId);
        mode = 'topic';
        unverified = false;
      } else if (lookup.failed) unverified = true;
    }
    return { scope: threadId ? `${chatId}:${threadId}` : chatId, threadId, mode, unverified };
  }

  async resolve(channel: LarkChannel, chatId: string): Promise<ChatMode> {
    return (await this.resolveOutcome(channel, chatId)).mode;
  }

  /** `failed` records that the probe itself failed and `mode` is the fallback. */
  async resolveOutcome(channel: LarkChannel, chatId: string): Promise<{ mode: ChatMode; failed: boolean }> {
    const hit = this.cache.get(chatId);
    if (hit) return { mode: hit, failed: false };
    try {
      const mode = await channel.getChatMode(chatId);
      this.cache.set(chatId, mode);
      log.info('chat', 'mode-resolved', { chatId, mode });
      return { mode, failed: false };
    } catch (err) {
      log.warn('chat', 'mode-resolve-failed', {
        chatId,
        err: err instanceof Error ? err.message : String(err),
      });
      // Don't poison the cache — next message gets another try.
      return { mode: 'group', failed: true };
    }
  }

  invalidate(chatId: string): void {
    this.cache.delete(chatId);
  }
}
