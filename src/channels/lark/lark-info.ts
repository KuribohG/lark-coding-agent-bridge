import type { LarkChannel } from '@larksuite/channel';
import { log } from '../../core/logger';

export interface KnownChat {
  id: string;
  name: string;
}

export async function fetchKnownChats(channel: LarkChannel): Promise<KnownChat[]> {
  try {
    const summaries = await channel.listChats({ pageSize: 100, maxPages: 5 });
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
export function startKnownChatsRefresh(channel: LarkChannel, publish: (chats: KnownChat[]) => void): { stop(): void } {
  const refresh = async (): Promise<void> => {
    const chats = await fetchKnownChats(channel);
    if (chats.length > 0) publish(chats);
  };
  void refresh();
  const timer = setInterval(() => void refresh(), 30 * 60 * 1000);
  return { stop: () => clearInterval(timer) };
}
