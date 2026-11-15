import { mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { log } from '../core/logger';
import { writeFileAtomic } from '../platform/atomic-write';

/** What the journal reads of an input; a channel records its own message type on top of this. */
export interface TurnInput {
  messageId: string;
  content: string;
}

/** Replays per input, so a turn that kills the bridge cannot restart it forever. */
export const MAX_RESUME_ATTEMPTS = 3;
/** Older turns are reported instead of replayed: the conversation has likely moved on. */
export const MAX_RESUME_AGE_MS = 24 * 60 * 60_000;

export interface InterruptedTurn<M extends TurnInput = TurnInput> {
  scope: string;
  /** Input delivered to the native run: the flushed batch plus accepted follow-ups. */
  messages: M[];
  timedRunId?: string;
  /** Run host keeping the native process alive; a live or finished host is reattached instead of replayed. */
  hostKey?: string;
  /** When the original input first started running; replays keep it. */
  startedAt: number;
  /** Replays already started for this input. */
  attempts: number;
}

/**
 * Conversation turns that have started but not settled, persisted so a bridge
 * that dies mid-run can replay them on its next start. A turn leaves the
 * journal when it ends for any reason other than bridge shutdown.
 */
export class InterruptedTurns<M extends TurnInput = TurnInput> {
  private readonly turns = new Map<string, InterruptedTurn<M>>();
  private writes: Promise<void> = Promise.resolve();
  private detached = false;

  constructor(
    private readonly path?: string,
    /** Whether a recorded input still has the channel's shape; others are dropped on load. */
    private readonly accepts: (input: TurnInput) => boolean = () => true,
  ) {}

  /** Returns the turns a previous process left unfinished; they stay recorded until replayed or ended. */
  async load(): Promise<InterruptedTurn<M>[]> {
    if (!this.path) return [];
    try {
      const raw = JSON.parse(await readFile(this.path, 'utf8')) as { version?: unknown; turns?: unknown };
      if (raw.version !== 1 || !Array.isArray(raw.turns)) return [];
      for (const value of raw.turns) {
        const turn = this.normalizeTurn(value);
        if (turn) this.turns.set(turn.scope, turn);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }
    return [...this.turns.values()].map(turn => structuredClone(turn));
  }

  /** Resolves once the record is durable, so the run never starts unrecorded. */
  begin(turn: Omit<InterruptedTurn<M>, 'startedAt' | 'attempts'> & Partial<Pick<InterruptedTurn<M>, 'startedAt' | 'attempts'>>): Promise<void> {
    this.turns.set(turn.scope, { ...turn, messages: [...turn.messages],
      startedAt: turn.startedAt ?? Date.now(), attempts: turn.attempts ?? 0 });
    return this.persist();
  }

  /** A follow-up accepted by the running native session must be replayed with it. */
  append(scope: string, message: M): void {
    const turn = this.turns.get(scope);
    if (!turn || turn.messages.some(existing => existing.messageId === message.messageId)) return;
    turn.messages.push(message);
    void this.persist();
  }

  /** False once the file belongs to the next channel, which then also owns the turn's run host. */
  end(scope: string): boolean {
    if (this.turns.delete(scope)) void this.persist();
    return !this.detached;
  }

  /** Resolves after every write requested so far has finished. */
  flush(): Promise<void> { return this.writes; }

  /** Hands the file to the next channel; late settlements of old turns are not written. */
  detach(): void { this.detached = true; }

  private persist(): Promise<void> {
    const path = this.path;
    if (!path || this.detached) return this.writes;
    const payload = `${JSON.stringify({ version: 1, turns: [...this.turns.values()] })}\n`;
    this.writes = this.writes.then(async () => {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFileAtomic(path, payload, { mode: 0o600 });
    }).catch(error => log.warn('resume', 'persist-failed', { error: String(error) }));
    return this.writes;
  }

  private normalizeTurn(value: unknown): InterruptedTurn<M> | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const raw = value as Partial<InterruptedTurn<M>>;
    if (typeof raw.scope !== 'string' || !raw.scope || !Array.isArray(raw.messages)) return undefined;
    const messages = raw.messages.filter((message): message is M => Boolean(message)
      && typeof message === 'object'
      && typeof message.messageId === 'string'
      && typeof message.content === 'string'
      && this.accepts(message));
    if (messages.length === 0) return undefined;
    return {
      scope: raw.scope,
      messages,
      ...(typeof raw.timedRunId === 'string' ? { timedRunId: raw.timedRunId } : {}),
      ...(typeof raw.hostKey === 'string' && raw.hostKey ? { hostKey: raw.hostKey } : {}),
      startedAt: Number.isFinite(raw.startedAt) ? raw.startedAt! : 0,
      attempts: Number.isInteger(raw.attempts) && raw.attempts! >= 0 ? raw.attempts! : MAX_RESUME_ATTEMPTS,
    };
  }
}
