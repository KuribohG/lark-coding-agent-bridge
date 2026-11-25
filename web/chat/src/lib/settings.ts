import { useSyncExternalStore } from 'react';

export interface Settings {
  theme: 'system' | 'light' | 'dark';
  /** `enter`: Enter sends and Shift+Enter breaks the line. `mod`: Ctrl/⌘+Enter sends. */
  sendKey: 'enter' | 'mod';
  /** Show what each step thought, ran and got back without a click. */
  expandTools: boolean;
  /** Fold a long stretch of steps into one line once its run is over. */
  foldSteps: boolean;
  sidebar: boolean;
}

const KEY = 'bridge:settings';
const DEFAULTS: Settings = { theme: 'system', sendKey: 'enter', expandTools: false, foldSteps: true, sidebar: true };

function read(): Settings {
  try { return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Settings>) }; }
  catch { return DEFAULTS; }
}

let current = read();
const listeners = new Set<() => void>();
const systemDark = matchMedia('(prefers-color-scheme: dark)');

function paint(): void {
  const dark = current.theme === 'dark' || (current.theme === 'system' && systemDark.matches);
  document.documentElement.classList.toggle('dark', dark);
}
systemDark.addEventListener('change', paint);
paint();

export function setSettings(change: Partial<Settings>): void {
  current = { ...current, ...change };
  try { localStorage.setItem(KEY, JSON.stringify(current)); } catch { /* private mode: the choice lasts for this page */ }
  paint();
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

export function useSettings(): Settings {
  return useSyncExternalStore(subscribe, () => current);
}

// On a narrow screen the sidebar lies over the conversation, so it starts closed and is not remembered open.
const narrow = matchMedia('(max-width: 767px)');
let drawer = false;
narrow.addEventListener('change', () => { drawer = false; for (const listener of listeners) listener(); });

export function setSidebar(open: boolean): void {
  if (!narrow.matches) { setSettings({ sidebar: open }); return; }
  drawer = open;
  for (const listener of listeners) listener();
}

export const sidebarOpen = (): boolean => narrow.matches ? drawer : current.sidebar;

export function useSidebar(): boolean {
  return useSyncExternalStore(subscribe, sidebarOpen);
}

/** After choosing where to go on a narrow screen, the list gets out of the way. */
export function closeDrawer(): void {
  if (narrow.matches && drawer) setSidebar(false);
}
