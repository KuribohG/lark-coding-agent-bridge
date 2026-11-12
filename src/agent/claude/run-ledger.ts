import { ClaudeBackgroundTasks } from './background-tasks';
import { isTaskNotificationResult } from './stream-json';

type RawEvent = Record<string, unknown>;
const object = (value: unknown): RawEvent => value !== null && typeof value === 'object' ? value as RawEvent : {};

type ResultVerdict =
  /** Not an outcome of this run yet: an input still awaits its answer, or the turn belongs to an earlier process. */
  | { kind: 'hidden' }
  /** Answers everything sent so far, but background work will start another turn. */
  | { kind: 'held'; result: RawEvent }
  /** Ends the run. */
  | { kind: 'final'; result: RawEvent };

/** Input ids a result accounts for; undefined from CLIs that do not report them. */
export function coveredInputs(result: RawEvent): unknown[] | undefined {
  return Array.isArray(result.user_message_uuids) ? result.user_message_uuids
    : typeof result.user_message_uuid === 'string' ? [result.user_message_uuid] : undefined;
}

const failed = (result: RawEvent): boolean =>
  Boolean(result.is_error) || (typeof result.subtype === 'string' && result.subtype.startsWith('error'));

/**
 * What one Claude process still owes the run: an answer to every input sent to it, and
 * the outcome of its background tasks. Every top-level result is judged here and nowhere
 * else, so the two kinds of debt cannot disagree about whether a turn ended the run.
 * It does no I/O; the adapter acts on its verdicts.
 */
export class ClaudeRunLedger {
  readonly tasks = new ClaudeBackgroundTasks();
  private readonly unanswered = new Set<string>();
  private initialId: string | undefined;

  /** An input was written to the process; the first one is the prompt, later ones supplements. */
  sent(uuid: string): void {
    this.initialId ??= uuid;
    this.unanswered.add(uuid);
  }

  /** Some input sent to this process has no covering result yet. */
  get awaitingResult(): boolean {
    return this.unanswered.size > 0;
  }

  /** Nothing is owed and nothing can start another turn, so stdin may close. */
  get quiet(): boolean {
    return this.tasks.idle && this.unanswered.size === 0;
  }

  /** A failure message that also says when a supplement may not have been consumed. */
  failure(message: string): string {
    return this.hasUnansweredSupplement ? `${message}; supplemental input delivery is unknown` : message;
  }

  /** Take in every event of the process. A top-level result gets a verdict; anything else undefined. */
  receive(raw: unknown): ResultVerdict | undefined {
    this.tasks.receive(raw);
    const result = object(raw);
    if (result.type !== 'result' || result.parent_tool_use_id) return undefined;
    const notification = isTaskNotificationResult(result);
    // A resumed session replays notification turns for tasks of earlier processes.
    if (notification && !this.tasks.launchedHere(result)) return { kind: 'hidden' };

    // Whatever started the turn, it answers the inputs it names: Claude folds a supplement
    // that arrives while it waits on a task into that task's notification turn.
    const covered = coveredInputs(result);
    for (const uuid of covered ?? []) {
      if (typeof uuid === 'string') this.unanswered.delete(uuid);
    }
    if (!notification) {
      // Replay/queued receipts confirm intake, not which generation consumed an input.
      const supplements = this.hasUnansweredSupplement;
      if (failed(result) || (!covered && supplements)) {
        if (!supplements) return { kind: 'final', result };
        return { kind: 'final', result: { ...result, is_error: true, errors: [
          ...(Array.isArray(result.errors) ? result.errors
            : [result.result ?? result.subtype ?? 'Claude result lacks input IDs (requires Claude Code 2.1.302+)']),
          'Claude did not confirm completion of all supplemental inputs; delivery is unknown',
        ] } };
      }
      // Older CLIs can still complete a single prompt without correlation fields.
      if (!covered && this.initialId) this.unanswered.delete(this.initialId);
    }
    if (this.unanswered.size > 0) return { kind: 'hidden' };
    return this.tasks.outstanding && !failed(result) ? { kind: 'held', result } : { kind: 'final', result };
  }

  private get hasUnansweredSupplement(): boolean {
    return [...this.unanswered].some(uuid => uuid !== this.initialId);
  }
}
