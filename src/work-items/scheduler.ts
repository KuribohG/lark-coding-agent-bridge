/** Shared FIFO slot for conversation analysis and every registered task source. */
export class AnalysisScheduler {
  private tail: Promise<void> = Promise.resolve();
  async run(signal: AbortSignal, task: (signal: AbortSignal) => Promise<void>): Promise<void> {
    const previous = this.tail;
    let release!: () => void;
    const turn = new Promise<void>(resolve => { release = resolve; });
    this.tail = previous.then(() => turn);
    let cancel!: () => void;
    const cancelled = new Promise<void>(resolve => { cancel = resolve; });
    signal.addEventListener('abort', cancel, { once: true });
    try {
      if (!signal.aborted) await Promise.race([previous, cancelled]);
      // Let the lifecycle record cancellation even when it never acquired a slot.
      await task(signal);
    } finally { signal.removeEventListener('abort', cancel); release(); }
  }
}
