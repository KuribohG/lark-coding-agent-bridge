import type { LarkChannel } from '@larksuite/channel';
import type { KnownChat } from '../../commands/types';
import { log } from '../../core/logger';
import { userFirst, type LarkUserReads } from './user-read';

export async function fetchKnownChats(
  channel: LarkChannel,
  reads?: LarkUserReads,
): Promise<KnownChat[]> {
  try {
    const summaries = await userFirst(reads, 'lark-info',
      () => reads!.listChats({ pageSize: 100, maxPages: 5 }),
      () => channel.listChats({ pageSize: 100, maxPages: 5 }),
    );
    const chats: KnownChat[] = summaries.map((c) => ({
      id: c.id,
      name: c.name || '(无名)',
    }));
    log.info('lark-info', 'chats-fetched', { count: chats.length });
    return chats;
  } catch (err) {
    log.warn('lark-info', 'chats-fetch-failed', {
      err: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

/** Refreshes the bot's group list every 30 minutes, publishing only non-empty results. */
export function startKnownChatsRefresh(
  channel: LarkChannel,
  publish: (chats: KnownChat[]) => void,
  reads?: LarkUserReads,
): { stop(): void } {
  const refresh = async (): Promise<void> => {
    const chats = await fetchKnownChats(channel, reads);
    if (chats.length > 0) publish(chats);
  };
  void refresh();
  const timer = setInterval(() => void refresh(), 30 * 60 * 1000);
  return { stop: () => clearInterval(timer) };
}
