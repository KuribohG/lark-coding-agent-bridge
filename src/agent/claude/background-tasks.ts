type RawEvent = Record<string, unknown>;
const object = (value: unknown): RawEvent => value !== null && typeof value === 'object' ? value as RawEvent : {};

const descriptionLimit = 80;

/**
 * Background work (`run_in_background` shells and subagents) of one Claude
 * process. After a turn's result `-p` keeps these running and reports each one
 * that finishes in a task-notification turn, so the run is not over while any
 * task is running or any finished task has not been reported yet.
 *
 * A task can finish while a turn is still open. Claude then either folds the
 * notification into that turn or queues it for a turn right after the result,
 * which is why a result with no task running does not end the run by itself.
 */
export class ClaudeBackgroundTasks {
  private readonly launched = new Set<string>();
  private readonly backgrounded = new Set<string>();
  /** Run ids of finished background tasks whose notification Claude has not delivered to the model yet. */
  private readonly unreported = new Set<string>();
  private live: string[] = [];
  /** Between a top-level init and its result; that turn's result decides whether the run ends. */
  private open = false;

  receive(raw: unknown): void {
    const event = object(raw);
    const runId = typeof event.run_id === 'string' ? event.run_id : undefined;
    if (!event.parent_tool_use_id) {
      const origin = object(event.origin);
      // The notification reached the model: replayed into an open turn, or answered by its own turn.
      if (origin.kind === 'task-notification' && typeof origin.runId === 'string') this.unreported.delete(origin.runId);
      if (event.type === 'result') this.open = false;
      if (event.type === 'system' && event.subtype === 'init') this.open = true;
    }
    if (event.type !== 'system') return;
    if (event.subtype === 'task_started' && runId) {
      this.launched.add(runId);
      if (event.is_backgrounded === true) this.backgrounded.add(runId);
    }
    // Foreground tools also report task_notification; only background ones get a turn of their own.
    if (event.subtype === 'task_notification' && runId && this.backgrounded.has(runId)) this.unreported.add(runId);
    // Each change carries the full list of tasks still running.
    if (event.subtype === 'background_tasks_changed' && Array.isArray(event.tasks)) {
      this.live = event.tasks.map((task) => {
        const { description, task_id: id, run_id: taskRunId } = object(task);
        if (typeof taskRunId === 'string' && this.launched.has(taskRunId)) this.backgrounded.add(taskRunId);
        return typeof description === 'string' && description.trim() ? description.trim() : String(id ?? '');
      });
    }
  }

  get running(): number {
    return this.live.length;
  }

  /** Background work that will still produce a turn: tasks running, or finished and not yet reported. */
  get outstanding(): boolean {
    return this.live.length > 0 || this.unreported.size > 0;
  }

  /** Nothing in this process can start another turn on its own, so stdin may close. */
  get idle(): boolean {
    return this.live.length === 0 && !this.open;
  }

  /** A resumed session replays notifications for tasks of earlier processes; only ours continue the run. */
  launchedHere(raw: unknown): boolean {
    const runId = object(object(raw).origin).runId;
    return typeof runId === 'string' && this.launched.has(runId);
  }

  describe(): string {
    if (this.live.length === 0) return '⏳ 后台任务已完成，等待处理结果后继续';
    const names = this.live.map(name => name.length > descriptionLimit ? `${name.slice(0, descriptionLimit)}…` : name);
    return `⏳ 等待 ${names.length} 个后台任务完成后继续：${names.join('；')}`;
  }
}
