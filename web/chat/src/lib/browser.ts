import type { Route } from './session';

const TOKEN_KEY = 'bridge-chat-token';

/** The link the server prints carries the token once; the page keeps it for the browser session and cleans the address. */
export function takeToken(): string {
  const params = new URLSearchParams(location.hash.slice(1));
  const supplied = params.get('token');
  if (supplied) {
    sessionStorage.setItem(TOKEN_KEY, supplied);
    history.replaceState(null, '', location.pathname + location.search);
  }
  return sessionStorage.getItem(TOKEN_KEY) ?? '';
}

function routeId(): string | undefined {
  const match = /^#\/c\/(.+)$/.exec(location.hash);
  if (!match) return undefined;
  try { return decodeURIComponent(match[1]!); } catch { return undefined; }
}

/** The open conversation is the page's address, `#/c/<id>`: the server serves one page, so the place is in the fragment. */
export const browserRoute: Route = {
  current: routeId,
  go(id, replace) {
    const hash = id ? `#/c/${encodeURIComponent(id)}` : '#/';
    if (location.hash === hash) return;
    if (replace) history.replaceState(null, '', hash); else history.pushState(null, '', hash);
  },
  onChange(listener) {
    addEventListener('hashchange', () => listener(routeId()));
    addEventListener('popstate', () => listener(routeId()));
  },
};
