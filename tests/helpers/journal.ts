import type { ObservationJournal, WorkItemEvent } from '../../src/work-items/events';

/** In-memory journal; `fail` rejects the next commits without keeping them. */
export function memoryJournal<S>(initial?: S) {
  let state: S | undefined = initial === undefined ? undefined : structuredClone(initial);
  const commits: { events: WorkItemEvent[]; state: S }[] = [];
  const failures: Error[] = [];
  const journal: ObservationJournal<S> & {
    commits: typeof commits;
    events(): WorkItemEvent[];
    fail(error: Error, times?: number): void;
  } = {
    state: () => state === undefined ? undefined : structuredClone(state),
    async commit(events, next) {
      const failure = failures.shift();
      if (failure) throw failure;
      state = structuredClone(next);
      commits.push({ events: structuredClone([...events]), state: structuredClone(next) });
    },
    commits,
    events: () => commits.flatMap(commit => commit.events),
    fail(error, times = 1) { for (let i = 0; i < times; i++) failures.push(error); },
  };
  return journal;
}
