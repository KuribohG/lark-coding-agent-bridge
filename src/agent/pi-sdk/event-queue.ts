/** Minimal single-consumer async queue used to bridge frame callbacks into a generator. */
export class AsyncEventQueue<T> {
  private readonly buffer: T[] = [];
  private waiter: (() => void) | undefined;
  private finished = false;

  push(value: T): void {
    if (this.finished) return;
    this.buffer.push(value);
    this.wake();
  }

  end(): void {
    if (this.finished) return;
    this.finished = true;
    this.wake();
  }

  private wake(): void {
    const waiter = this.waiter;
    this.waiter = undefined;
    waiter?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    for (;;) {
      while (this.buffer.length > 0) yield this.buffer.shift()!;
      if (this.finished) return;
      await new Promise<void>((resolve) => {
        this.waiter = resolve;
      });
    }
  }
}
