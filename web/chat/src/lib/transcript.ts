import type { PageEvent, RunItem, TranscriptItem, UserItem } from './types';

/** One conversation as the page holds it: what the server sent, plus what the person just sent and the server has not echoed yet. */
export interface TranscriptView {
  /** The server process the cursor belongs to. */
  epoch?: string;
  /** The latest revision seen; the next connection asks for what came after it. */
  rev: number;
  /** In conversation order. */
  items: TranscriptItem[];
  /** Position of the oldest item held, and whether the server has older ones. */
  first: number;
  more: boolean;
  /** False until the server has sent everything the cursor had not seen. */
  ready: boolean;
  /** The conversation was deleted elsewhere. */
  gone: boolean;
}

export const emptyTranscript: TranscriptView = { rev: 0, items: [], first: 0, more: false, ready: false, gone: false };

/** Items the person sent that the server has not taken into the record sort after everything it has. */
const PENDING_ORD = Number.MAX_SAFE_INTEGER - 1_000_000;

function place(items: TranscriptItem[], item: TranscriptItem): TranscriptItem[] {
  const at = items.findIndex(known => known.key === item.key);
  if (at >= 0 && items[at]!.ord === item.ord) {
    const next = items.slice();
    next[at] = item;
    return next;
  }
  const next = at >= 0 ? items.filter(known => known.key !== item.key) : items.slice();
  let index = next.length;
  while (index > 0 && next[index - 1]!.ord > item.ord) index--;
  next.splice(index, 0, item);
  return next;
}

/** Takes one event of the page stream into the view. Returns the same object when nothing changed. */
export function applyEvent(view: TranscriptView, event: PageEvent): TranscriptView {
  switch (event.type) {
    case 'open':
      return event.reset
        // What the person sent and the server never confirmed stays on screen; the rest is sent again.
        ? { ...emptyTranscript, epoch: event.epoch, items: view.items.filter(item => item.kind === 'user' && (item.pending || item.failed)) }
        : { ...view, epoch: event.epoch, ready: false };
    case 'item':
      return { ...view, rev: Math.max(view.rev, event.item.rev), items: place(view.items, event.item) };
    case 'run': {
      const known = view.items.find(item => item.key === event.key);
      // A patch only fits the state it was made from; anything else is put right by the next full item.
      if (known?.kind !== 'run' || known.rev !== event.base) return view;
      const { type: _type, key: _key, base: _base, from, keep, blocks, state, ...rest } = event;
      const had = known.state.blocks[from];
      const first = blocks[0];
      // Streamed text and reasoning arrive as what was added to the block already held.
      const changed = keep && had && first && had.kind !== 'tool' && first.kind === had.kind
        ? [{ ...first, content: had.content.slice(0, keep) + first.content }, ...blocks.slice(1)] : blocks;
      const item: RunItem = {
        ...known, ...rest, kind: 'run', key: known.key, ord: known.ord,
        state: { ...state, blocks: [...known.state.blocks.slice(0, from), ...changed] },
      };
      return { ...view, rev: Math.max(view.rev, event.rev), items: place(view.items, item) };
    }
    case 'ready':
      return { ...view, rev: Math.max(view.rev, event.rev), ready: true,
        ...(event.first !== undefined ? { first: event.first, more: event.more ?? false } : {}) };
    case 'gone':
      return { ...view, gone: true };
    default:
      return view;
  }
}

/** Whether a patch was dropped because the view lacks the state it builds on, so the page should connect afresh. */
export function missedPatch(view: TranscriptView, event: PageEvent): boolean {
  if (event.type !== 'run') return false;
  const known = view.items.find(item => item.key === event.key);
  return known?.kind !== 'run' || known.rev !== event.base;
}

/** Older items fetched on request go in front. */
export function prependItems(view: TranscriptView, items: TranscriptItem[], more: boolean): TranscriptView {
  const fresh = items.filter(item => !view.items.some(known => known.key === item.key));
  const merged = [...fresh, ...view.items].sort((a, b) => a.ord - b.ord);
  return { ...view, items: merged, first: merged[0]?.ord ?? view.first, more };
}

let pendingCount = 0;

/** Shows what the person sent at once; the server's item with the same key replaces it. */
export function addPending(view: TranscriptView, messageId: string, text: string, via: UserItem['via'], now: number): TranscriptView {
  const item: UserItem = { kind: 'user', key: `u-${messageId}`, ord: PENDING_ORD + pendingCount++, rev: 0, at: now, text, via, pending: true };
  return { ...view, items: [...view.items, item] };
}

export function failPending(view: TranscriptView, messageId: string, reason: string): TranscriptView {
  const key = `u-${messageId}`;
  return { ...view, items: view.items.map(item => item.key === key && item.kind === 'user' && item.pending
    ? { ...item, pending: false, failed: reason } : item) };
}

export function dropItem(view: TranscriptView, key: string): TranscriptView {
  return { ...view, items: view.items.filter(item => item.key !== key) };
}

/** The run that is going in this conversation, if the view holds one. */
export function activeRun(view: TranscriptView): RunItem | undefined {
  for (let index = view.items.length - 1; index >= 0; index--) {
    const item = view.items[index]!;
    if (item.kind === 'run' && item.finishedAt === undefined && item.state.terminal === 'running') return item;
  }
  return undefined;
}
