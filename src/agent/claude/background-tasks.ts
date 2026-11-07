type RawEvent = Record<string, unknown>;
const object = (value: unknown): RawEvent => value !== null && typeof value === 'object' ? value as RawEvent : {};

const descriptionLimit = 80;

/**
 * Background work (`run_in_background` shells and subagents) of one Claude
 * process. After a turn's result `-p` keeps these running and starts a
 * task-notification turn as each one finishes, so the run is not over while
 * any are left.
 */
export class ClaudeBackgroundTasks {
  private readonly launched = new Set<string>();
  private live: string[] = [];

  receive(raw: unknown): void {
    const event = object(raw);
    if (event.type !== 'system') return;
    if (event.subtype === 'task_started' && typeof event.run_id === 'string') this.launched.add(event.run_id);
    // Each change carries the full list of tasks still running.
    if (event.subtype === 'background_tasks_changed' && Array.isArray(event.tasks)) {
      this.live = event.tasks.map((task) => {
        const { description, task_id: id } = object(task);
        return typeof description === 'string' && description.trim() ? description.trim() : String(id ?? '');
      });
    }
  }

  get running(): number {
    return this.live.length;
  }

  /** A resumed session replays notifications for tasks of earlier processes; only ours continue the run. */
  launchedHere(raw: unknown): boolean {
    const runId = object(object(raw).origin).runId;
    return typeof runId === 'string' && this.launched.has(runId);
  }

  describe(): string {
    const names = this.live.map(name => name.length > descriptionLimit ? `${name.slice(0, descriptionLimit)}…` : name);
    return `⏳ 等待 ${names.length} 个后台任务完成后继续：${names.join('；')}`;
  }
}
