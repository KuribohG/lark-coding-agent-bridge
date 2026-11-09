import type { WorkItemControl } from './control';
import type { WorkItemScheduler } from './scheduler';

export type TaskKind = 'analysis' | 'triage';
interface RunningTask { controller: AbortController; done: Promise<void> }

/** Running analyses and screenings, and the loop that fills their free slots. */
export class WorkItemTasks {
  readonly analyses = new Map<string, RunningTask>();
  readonly screenings = new Map<string, RunningTask>();
  private dispatching?: Promise<void>;
  private dispatchRequested = false;
  /** `next[kind]` starts at most one task and reports whether to keep filling slots. */
  constructor(private control: WorkItemControl, private queue: WorkItemScheduler, private triageQueue: WorkItemScheduler,
    private next: Record<TaskKind, () => Promise<boolean>>) {}
  get settled(): Promise<void> | undefined { return this.dispatching; }
  running(kind?: TaskKind): RunningTask[] {
    return [...(kind === 'triage' ? [] : this.analyses.values()), ...(kind === 'analysis' ? [] : this.screenings.values())];
  }
  abort(kind?: TaskKind): void {
    for (const task of this.running(kind)) task.controller.abort();
  }
  start(kind: TaskKind, id: string, fn: (signal: AbortSignal) => Promise<void>): void {
    const tasks = kind === 'analysis' ? this.analyses : this.screenings;
    tasks.set(id, this.launch(fn, () => { tasks.delete(id); }, kind === 'analysis' ? this.queue : this.triageQueue));
  }
  dispatch(): Promise<void> {
    this.dispatchRequested = true;
    return this.dispatching ??= this.runDispatch().catch(error => {
      this.pauseAfterFailure(); throw error;
    }).finally(() => {
      this.dispatching = undefined;
      // A completion can request dispatch between the loop exit and this cleanup.
      if (this.dispatchRequested && !this.control.blocked()) void this.dispatch().catch(() => {});
    });
  }
  private async runDispatch(): Promise<void> {
    do {
      this.dispatchRequested = false;
      await this.control.serial(() => this.dispatchJobs());
    } while (this.dispatchRequested && !this.control.blocked());
  }
  private async dispatchJobs(): Promise<void> {
    for (const kind of ['analysis', 'triage'] as const) {
      const tasks = kind === 'analysis' ? this.analyses : this.screenings;
      const queue = kind === 'analysis' ? this.queue : this.triageQueue;
      while (tasks.size < queue.concurrency && !this.control.blocked()) {
        if (!await this.next[kind]()) break;
      }
    }
  }
  private launch(fn: (signal: AbortSignal) => Promise<void>, release: () => void, queue: WorkItemScheduler): RunningTask {
    const controller = new AbortController();
    const done = Promise.resolve().then(() => queue.run(controller.signal, fn)).catch(() => this.pauseAfterFailure()).finally(() => {
      release();
      // Model completion must not wait for the next collection/history round.
      if (!this.control.blocked()) void this.dispatch().catch(() => {});
    });
    return { controller, done };
  }
  pauseAfterFailure(): void {
    this.control.lastError = '状态保存失败，助理已暂停'; this.control.stopped = true;
    this.abort();
  }
}
