import type { LarkChannel, NormalizedMessage } from '@larksuite/channel';
import { join } from 'node:path';
import {
  newRunHostKey,
  probeRunHost,
  removeRunHost,
  runHostAgent,
  runHostsSupported,
  sweepRunHosts,
  terminateRunHost,
  type RunHostBinding,
} from '../../agent/run-host';
import type { AgentKind } from '../../config/profile-schema';
import { log, withTrace } from '../../core/logger';
import type { AgentEntry } from '../../runtime/agent-entry';
import { abortStopReason } from '../../runtime/errors';
import type { RunExecution } from '../../runtime/run-executor';
import type { CotPublisher } from './cot';
import {
  InterruptedTurns as TurnJournal,
  MAX_RESUME_AGE_MS,
  MAX_RESUME_ATTEMPTS,
  type InterruptedTurn as JournaledTurn,
} from '../../runtime/interrupted-turns';
import type { PendingMessage } from './pending-queue';
import type { ConversationTurns } from '../../runtime/turns';

type InterruptedTurn = JournaledTurn<NormalizedMessage>;
type InterruptedTurns = TurnJournal<NormalizedMessage>;

export interface TurnDispatchOptions {
  signal: AbortSignal;
  entry?: AgentEntry;
  preparedCot?: CotPublisher;
  resumeAttempt?: number;
  host?: RunHostBinding;
}

export interface LarkTurnRunnerDeps {
  channel: LarkChannel;
  turns: ConversationTurns;
  /** Profile state directory holding the interrupted-turn journal. */
  stateDir?: string;
  resolveAgentKind(scope: string): AgentKind;
  dispatch(scope: string, batch: PendingMessage[], options: TurnDispatchOptions): Promise<RunExecution | undefined>;
}

interface ConversationTurnOptions {
  preparedCot?: CotPublisher;
  resumeAttempt?: number;
  startedAt?: number;
  attempts?: number;
  attachHost?: string;
}

/**
 * Runs claimed turns and keeps them recoverable: started turns are journaled
 * until they settle, so a bridge restart reattaches to their run host or
 * replays their input.
 */
export class LarkTurnRunner {
  // Created when this channel takes over persisted state, so a
  // connect-before-disconnect restart never has two writers.
  private journal: InterruptedTurns | undefined;

  constructor(private readonly deps: LarkTurnRunnerDeps) {}

  /** Adds input that arrived during a journaled turn, so a replay includes it. */
  recordFollowup(scope: string, message: NormalizedMessage): void {
    this.journal?.append(scope, message);
  }

  runConversationTurn(scope: string, batch: PendingMessage[], signal: AbortSignal, options: ConversationTurnOptions): Promise<void> {
    const firstMsg = batch[0]!;
    return withTrace({ chatId: firstMsg.chatId }, async () => {
      log.info('flush', 'start', {
        scope,
        batchSize: batch.length,
        chatId: firstMsg.chatId,
        threadId: firstMsg.threadId,
        msgId: firstMsg.messageId,
        ...(options.resumeAttempt ? { resumeAttempt: options.resumeAttempt } : {}),
        ...(options.attachHost ? { runHost: options.attachHost } : {}),
      });
      const entry = firstMsg.agentEntry ?? { kind: 'direct' };
      // Workflow turns are recovered by the workflow kernel itself.
      const journal = entry.kind === 'direct' ? this.journal : undefined;
      const host = this.hostFor(journal, options.attachHost);
      const attempts = options.resumeAttempt ?? options.attempts;
      let execution: RunExecution | undefined;
      try {
        await journal?.begin({ scope, messages: batch,
          ...(host ? { hostKey: host.key } : {}),
          ...(attempts ? { attempts } : {}),
          ...(options.startedAt ? { startedAt: options.startedAt } : {}) });
        execution = await this.deps.dispatch(scope, batch, { signal, entry, preparedCot: options.preparedCot,
          ...(options.resumeAttempt ? { resumeAttempt: options.resumeAttempt } : {}),
          ...(host ? { host } : {}) });
      } catch (err) {
        await options.preparedCot?.finish('error');
        log.fail('flush', err);
      } finally {
        if (journal && !await cutOffByShutdown(signal, execution)) endJournaled(journal, scope, host);
        log.info('flush', 'end');
      }
    });
  }

  /** Replays turns a previous process left unfinished, before queued input of the same scopes. */
  async resumeInterrupted(): Promise<void> {
    if (this.journal) return;
    const journal: InterruptedTurns = new TurnJournal(
      this.deps.stateDir ? join(this.deps.stateDir, 'interrupted-turns.json') : undefined,
      input => typeof (input as Partial<NormalizedMessage>).chatId === 'string');
    const previous = await journal.load();
    this.journal = journal;
    for (const turn of previous) await this.resumeTurn(turn, journal);
    const reattached = new Set(previous.flatMap(turn => turn.hostKey ? [turn.hostKey] : []));
    void sweepRunHosts(MAX_RESUME_AGE_MS, reattached).catch(err => log.warn('run-host', 'sweep-failed', { err: String(err) }));
  }

  /** Persists the journal and stops writing it, once stopped turns have recorded whether to replay. */
  async closeJournal(): Promise<void> {
    await this.journal?.flush();
    this.journal?.detach();
  }

  /** Journaled turns run under a host, so a restart reattaches to them instead of replaying. */
  private hostFor(journal: InterruptedTurns | undefined, attachHost?: string): RunHostBinding | undefined {
    if (attachHost) return { key: attachHost, attach: true };
    return journal && runHostsSupported() ? { key: newRunHostKey() } : undefined;
  }

  private async resumeTurn(turn: InterruptedTurn, journal: InterruptedTurns): Promise<void> {
    const { channel } = this.deps;
    const messages = [...turn.messages].sort((left, right) =>
      (Number.isFinite(left.createTime) ? left.createTime : 0) - (Number.isFinite(right.createTime) ? right.createTime : 0));
    const last = messages.at(-1)!;
    const notify = (markdown: string) => channel.send(last.chatId, { markdown },
      { replyTo: last.messageId, ...(last.threadId ? { replyInThread: true } : {}) })
      .catch(err => log.warn('resume', 'notice-failed', { scope: turn.scope, err: String(err) }));
    // A host that is still running, or finished while no bridge was attached, holds the native
    // run itself: attach without replaying input or notifying anyone. Another backend cannot
    // read the host's protocol, e.g. after the scope's agent was switched.
    const agentKind = this.deps.resolveAgentKind(turn.scope);
    const hostState = turn.hostKey && runHostAgent(turn.hostKey) === agentKind ? await probeRunHost(turn.hostKey) : 'missing';
    let skip: string | undefined;
    if (hostState === 'missing' && turn.attempts >= MAX_RESUME_ATTEMPTS) {
      skip = `这条消息的任务已在 bridge 重启后自动续跑 ${turn.attempts} 次仍被中断，不再自动续跑。如需继续，请重新发送。`;
    } else if (hostState === 'missing' && Date.now() - turn.startedAt > MAX_RESUME_AGE_MS) {
      skip = 'bridge 重启前这条消息的任务被中断，且已超过 24 小时，不再自动续跑。如需继续，请重新发送。';
    }
    const reattach = skip === undefined && hostState !== 'missing' ? turn.hostKey : undefined;
    const resume = reattach
      ? { attempt: turn.attempts, startedAt: turn.startedAt, attachHost: reattach }
      : { attempt: turn.attempts + 1, startedAt: turn.startedAt };
    log.info('resume', skip !== undefined ? 'skip' : reattach ? 'reattach' : 'start', { scope: turn.scope, attempt: resume.attempt,
      ...(turn.hostKey ? { runHost: turn.hostKey, hostState } : {}) });
    // A host nobody reattaches to must not keep the native run going.
    if (turn.hostKey && !reattach) await terminateRunHost(turn.hostKey);
    if (skip !== undefined) {
      journal.end(turn.scope);
      if (skip) await notify(skip);
      return;
    }
    try {
      const claimed = this.deps.turns.claim(turn.scope);
      void claimed.run(signal => this.runConversationTurn(turn.scope, messages, signal, reattach
        ? { attachHost: reattach, attempts: resume.attempt, startedAt: resume.startedAt }
        : { resumeAttempt: resume.attempt, startedAt: resume.startedAt }))
        .catch(err => log.fail('flush', err));
    } catch (err) {
      log.fail('resume', err, { scope: turn.scope });
      journal.end(turn.scope);
      if (reattach) await terminateRunHost(reattach);
      await notify(`bridge 重启前这条消息的任务被中断，自动续跑失败：${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    if (!reattach) await notify(`bridge 重启前这条消息的任务被中断，正在自动续跑（第 ${resume.attempt} 次）。发送 /stop 可取消。`);
  }
}

/** Only a bridge shutdown leaves a turn to be replayed; /stop, failures and completions end it. */
async function cutOffByShutdown(signal: AbortSignal, execution: RunExecution | undefined): Promise<boolean> {
  const reason = signal.aborted ? abortStopReason(signal) : execution?.handle.stopReason;
  return reason === 'shutdown' && (!execution || await execution.result !== 'completed');
}

function endJournaled(journal: InterruptedTurns | undefined, scope: string, host: RunHostBinding | undefined): void {
  if (journal?.end(scope) && host) removeRunHost(host.key);
}
