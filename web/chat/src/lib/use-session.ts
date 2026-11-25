import { createContext, useContext, useSyncExternalStore } from 'react';
import type { Session, SessionState } from './session';

export const SessionContext = createContext<Session | null>(null);

export function useSessionApi(): Session {
  const session = useContext(SessionContext);
  if (!session) throw new Error('No session');
  return session;
}

/** One part of the session's state; the component draws again only when that part changes. */
export function useSession<T>(select: (state: SessionState) => T): T {
  const session = useSessionApi();
  return useSyncExternalStore(session.subscribe, () => select(session.getState()));
}
