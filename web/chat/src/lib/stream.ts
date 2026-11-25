import type { Api } from './api';
import type { PageEvent } from './types';

export type Link = 'connecting' | 'live' | 'offline' | 'unauthorized';

export interface FollowOptions {
  api: Api;
  /** The query of the next connection: the conversation and how far the page has seen it. */
  query(): URLSearchParams;
  event(event: PageEvent): void;
  link(state: Link): void;
  signal: AbortSignal;
}

/** The server says it is alive every 20 s; a connection silent for this long is taken for dead. */
const SILENCE_MS = 50_000;

/**
 * Holds the page's connection to the server until the signal aborts: reads events line by line, and connects
 * again, a little later each time, whenever the connection ends.
 */
export async function follow(options: FollowOptions): Promise<void> {
  const { api, signal } = options;
  let failures = 0;
  while (!signal.aborted) {
    const attempt = new AbortController();
    const abort = () => attempt.abort();
    signal.addEventListener('abort', abort, { once: true });
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const heard = () => {
      if (watchdog) clearTimeout(watchdog);
      watchdog = setTimeout(() => attempt.abort(), SILENCE_MS);
    };
    try {
      const response = await api.stream(options.query(), attempt.signal);
      if (response.status === 401 || response.status === 403) { options.link('unauthorized'); return; }
      if (!response.ok || !response.body) throw new Error('stream failed');
      options.link('live');
      failures = 0;
      heard();
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = '';
      for (;;) {
        const { done, value } = await reader.read();
        heard();
        pending += decoder.decode(value, { stream: !done });
        const lines = pending.split('\n');
        pending = lines.pop() ?? '';
        for (const line of lines) {
          if (!line || signal.aborted) continue;
          options.event(JSON.parse(line) as PageEvent);
        }
        if (done) break;
      }
    } catch {
      /* connect again below */
    } finally {
      if (watchdog) clearTimeout(watchdog);
      signal.removeEventListener('abort', abort);
    }
    if (signal.aborted) return;
    failures++;
    options.link(failures > 1 ? 'offline' : 'connecting');
    await new Promise(resolve => setTimeout(resolve, Math.min(8_000, 400 * 2 ** Math.min(failures, 5))));
  }
}
