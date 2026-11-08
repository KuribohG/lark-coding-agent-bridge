/** Collectors publish full snapshots. Revisions increase within a source/key partition. */
export interface WorkItemEvent {
  key: string;
  title: string;
  reason: string;
  url: string;
  time: number;
  data: unknown;
  eventId?: string;
  revision?: number;
  operation?: 'upsert' | 'resolve';
  priority?: 'normal' | 'high';
  evidenceDir?: string;
  maxAttempts?: number;
  /** Source-owned alert/recovery text, delivered independently of analysis slots. */
  notice?: string;
}

/**
 * Durable intake for a collector: its observations and its read state (cursors, pending
 * windows) commit together, so a crash or failed write never advances one without the other.
 */
export interface ObservationJournal<S> {
  /** The state committed last; undefined before the first commit. */
  state(): S | undefined;
  commit(events: readonly WorkItemEvent[], state: S): Promise<void>;
}
