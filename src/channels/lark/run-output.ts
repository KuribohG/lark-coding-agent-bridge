import type { LarkChannel } from '@larksuite/channel';
import type { RunOutputContext, RunOutputPlugin } from '../../runtime/run-output';
import type { FileLinkRenderOptions } from '../../card/file-links';
import { renderCard } from '../../card/run-renderer';
import { initialState, type RunState } from '../../runtime/run-state';
import { renderProgressText, renderText } from '../../card/text-renderer';
import { getMessageReplyMode, type CotMessagesMode } from '../../config/schema';
import { log } from '../../core/logger';
import { consumeCotEvents, CotClient, CotPublisher, finalAnswerOnlyState } from '../../bot/cot';
import { addWorkingReaction, removeReaction } from '../../bot/reaction';
import { processAgentStream } from '../../runtime/run-stream';
import { createProgressMarkdownWriter } from './progress-markdown';

const STREAM_TERMINAL_GRACE_MS = 3000;
const REACTION_CLEANUP_GRACE_MS = 1000;

export interface LarkRunOutputOptions {
  channel: LarkChannel;
  chatId: string;
  replyMode: ReturnType<typeof getMessageReplyMode>;
  sendOpts: { replyTo: string; replyInThread?: boolean };
  cardRenderOptions: FileLinkRenderOptions & { signCallback?: (action: string) => string };
  cotMessages: CotMessagesMode;
  cotClient: CotClient;
  preparedCot?: CotPublisher;
  originMessageId: string;
  inputPreview: string;
}

type RunOutputInput = RunOutputContext & LarkRunOutputOptions;

export function createLarkRunOutput(options: LarkRunOutputOptions): RunOutputPlugin {
  return { id: 'lark', render: input => renderRunOutput({ ...input, ...options }) };
}

/** Owns progress creation, late producers and updates for either streaming format. */
class ProgressOutput {
  state: RunState = initialState;
  readonly progress: LazyProgressStream;
  private producerStarted = false;
  private renderDone!: Promise<RunState>;
  private update?: () => Promise<void>;

  constructor(private input: RunOutputInput, private mode: 'card' | 'markdown',
    private options: { openOnContent: boolean; tolerateUpdateFailure: boolean } = { openOnContent: true, tolerateUpdateFailure: false }) {
    const content = () => input.filterForPrefs(this.state);
    const produce = async (update: () => Promise<void>) => {
      this.producerStarted = true;
      if (this.progress.abandoned()) return;
      this.update = update;
      await update();
      await this.renderDone;
    };
    this.progress = createLazyProgressStream(input.scope, mode, () => mode === 'card'
      ? input.channel.stream(input.chatId, { card: {
          initial: renderCard(initialState, input.cardRenderOptions),
          producer: ctrl => produce(() => ctrl.update(renderCard(content(), input.cardRenderOptions))),
        } }, input.sendOpts)
      : input.channel.stream(input.chatId, {
          markdown: ctrl => {
            const writeProgress = createProgressMarkdownWriter(ctrl);
            return produce(() => writeProgress(renderProgressText(content(), input.cardRenderOptions)));
          },
        }, input.sendOpts));
  }

  start(): Promise<RunState> {
    const i = this.input;
    return this.renderDone = processAgentStream(i.handle, i.events, i.scope, i.idleTimeoutMs, i.recordSession,
      async state => {
        this.state = state;
        if (this.options.openOnContent && shouldOpenProgressStream(i.filterForPrefs(state))) this.progress.ensureOpen();
        if (!this.update || this.progress.abandoned()) return;
        try { await this.update(); }
        catch (err) {
          if (!this.options.tolerateUpdateFailure) throw err;
          this.progress.abandon();
          log.fail('stream', err, { mode: this.mode, step: 'cot-fallback-update' });
        }
      });
  }

  settle(fallback: (state: RunState) => Promise<void>): Promise<void> {
    return awaitRenderAwareStream({ mode: this.mode, progress: this.progress, renderDone: this.renderDone,
      producerStarted: () => this.producerStarted, fallback });
  }

  recallEmpty(): Promise<void> {
    return recallIfEmptyStreamedReply(this.input.channel, this.progress, this.input.filterForPrefs(this.state), this.input.scope);
  }
}

async function renderRunOutput(input: RunOutputInput): Promise<void> {
  const reaction = input.cotMessages !== 'off' || input.replyMode === 'card'
    ? undefined : addWorkingReaction(input.channel, input.originMessageId);
  try {
    if (input.cotMessages === 'off') {
      await input.preparedCot?.finish('cancelled');
    } else if (await renderCotOutput(input)) {
      return;
    }
    if (input.replyMode === 'text') {
      const state = await processAgentStream(input.handle, input.events, input.scope, input.idleTimeoutMs,
        input.recordSession, async () => {});
      await sendFinalReply({ ...input, state: input.separateFinalAnswer
        ? finalAnswerOnlyState(input.filterForPrefs(state)) : input.filterForPrefs(state) });
      return;
    }
    const output = new ProgressOutput(input, input.replyMode);
    output.start();
    try {
      await output.settle(async state => {
        if (input.separateFinalAnswer) return;
        const projected = input.filterForPrefs(state);
        const body = renderText(projected, input.cardRenderOptions);
        if (!body.trim()) return;
        await input.channel.send(input.chatId, input.replyMode === 'card'
          ? { card: renderCard(projected, input.cardRenderOptions) } : { markdown: body }, input.sendOpts);
      });
    } catch (err) {
      if (!input.separateFinalAnswer) throw err;
      log.fail('stream', err, { mode: input.replyMode, step: 'progress-stream' });
    }
    await output.recallEmpty();
    if (input.separateFinalAnswer) {
      await sendFinalReply({ ...input, state: finalReplyState(output.progress, input.filterForPrefs(output.state)) });
    }
  } finally {
    scheduleWorkingReactionCleanup(input.channel, input.originMessageId, reaction);
  }
}

async function renderCotOutput(input: RunOutputInput): Promise<boolean> {
  const output = new ProgressOutput(input, 'markdown', { openOnContent: false, tolerateUpdateFailure: true });
  const publisher = input.preparedCot ?? new CotPublisher({
    client: input.cotClient, chatId: input.chatId, originMessageId: input.originMessageId,
  });
  publisher.bind({ runId: input.runId, scope: input.scope, inputPreview: input.inputPreview });
  await publisher.start();
  if (publisher.disabled) {
    log.warn('cot', 'fallback-existing-reply', { reason: 'create-disabled' });
    await sendCotCreateFailedNotice(input);
    return false;
  }
  const cotDone = consumeCotEvents(input.subscribe(), publisher, { detail: input.cotMessages });
  const renderDone = output.start();
  const progressDone = output.settle(async () => { output.progress.abandon(); }).catch(err => {
    output.progress.abandon();
    log.fail('stream', err, { mode: 'markdown', step: 'cot-fallback' });
  });
  const finalState = await renderDone;
  await cotDone;
  await progressDone;
  await output.recallEmpty();
  await sendFinalReply({ ...input, state: finalReplyState(output.progress, finalState) });
  return true;
}

interface LazyProgressStream {
  /**
   * Mirrors the underlying `channel.stream(...)` promise, and stays pending
   * forever while no stream has been opened — so callers can race it against
   * the render loop exactly as if the stream had been created up front.
   */
  readonly settled: Promise<unknown>;
  opened(): boolean;
  ensureOpen(): void;
  /**
   * True once the reply went out without this stream. A producer that starts
   * after that must render nothing, or the user gets the same answer twice.
   */
  abandoned(): boolean;
  abandon(): void;
}

/**
 * Wrap a progress stream so the user-visible message is only created once the
 * run has something worth showing (see `shouldOpenProgressStream`).
 *
 * The SDK starts a stream eagerly: `channel.stream(...)` sends a card before
 * the producer runs, and finishes it with a "(no content)" placeholder when the
 * producer never supplied any text. A Codex round that only produces a final
 * answer (delivered separately by `sendFinalReply`) used to hit exactly that:
 * an empty card sat in the chat for seconds until `recall-empty` cleaned it up.
 */
function createLazyProgressStream(
  scope: string,
  mode: 'card' | 'markdown',
  open: () => Promise<unknown>,
): LazyProgressStream {
  let stream: Promise<unknown> | undefined;
  let givenUp = false;
  let settle!: (result: Promise<unknown>) => void;
  const settled = new Promise<unknown>((resolve, reject) => {
    settle = (result) => {
      result.then(resolve, reject);
    };
  });
  return {
    settled,
    opened: () => stream !== undefined,
    ensureOpen: () => {
      if (stream) return;
      log.info('outbound', 'progress-stream-open', { scope, mode });
      stream = open();
      settle(stream);
    },
    abandoned: () => givenUp,
    abandon: () => {
      givenUp = true;
    },
  };
}

/**
 * Is there anything in this state that will still be on screen when the run
 * ends? Footer status lines ("正在思考…") don't count: the terminal event drops
 * them, so a stream opened for a footer alone can still finish empty — which is
 * the placeholder-then-recall churn we're avoiding.
 *
 * Terminal states don't count either. By then the stream has nothing left to
 * stream, and whatever the run produced goes out as a normal reply
 * (`sendFinalReply`, or the stream fallback) instead of a card that would be
 * created only to be finished a moment later.
 *
 * `state` must already be `filterForPrefs`-projected, and emptiness is measured
 * with `renderText` in both reply modes so it matches the rule
 * `recallIfEmptyStreamedReply` applies: a stream we open is one that survives.
 */
function shouldOpenProgressStream(state: RunState): boolean {
  if (state.terminal !== 'running') return false;
  return renderProgressText(state).trim() !== '';
}

/**
 * What Codex's dedicated final reply may carry, given what the progress stream
 * already put on screen.
 *
 * `finalAnswerOnlyState` falls back to the run's text blocks when Codex held
 * nothing back for the end — correct where nothing was streamed (CoT, text
 * mode, a stream we gave up on), but those blocks are already visible once a
 * stream rendered them, and repeating them posts the same words a second time.
 * Codex leaves the answer in `blocks` more often than it looks: any abnormal
 * turn end (`turn.failed`, or the process exiting before `turn.completed`)
 * flushes the pending message as text instead of `final_text`.
 *
 * Terminal notices are dropped for the same reason — the stream rendered them.
 */
function finalReplyState(progress: LazyProgressStream, state: RunState): RunState {
  if (!progress.opened() || progress.abandoned()) return finalAnswerOnlyState(state);
  return {
    ...state,
    blocks: state.finalText ? [{ kind: 'text', content: state.finalText, streaming: false }] : [],
    reasoning: { content: '', active: false },
    footer: null,
    terminal: 'done',
    errorMsg: undefined,
  };
}

/**
 * Backstop for a progress stream that was opened on real content and still
 * ended up empty — e.g. `/config` hiding tool calls mid-run, which retroactively
 * empties a tool-only render. The SDK fills such a card with its "(no content)"
 * placeholder, so recall it instead of leaving noise in the chat.
 *
 * `finalState` must already be `filterForPrefs`-projected (what the user sees).
 */
async function recallIfEmptyStreamedReply(
  channel: LarkChannel,
  progress: LazyProgressStream,
  finalState: RunState,
  scope: string,
): Promise<void> {
  if (!progress.opened()) return;
  // An abandoned stream renders nothing, so whatever message it eventually
  // posts is empty by construction. It is still in flight (that is why we gave
  // up on it), so clean up in the background instead of blocking the run on it.
  if (progress.abandoned()) {
    void progress.settled.then(
      (result) => recallStreamedMessage(channel, result, scope),
      () => {},
    );
    return;
  }
  if (renderText(finalState).trim() !== '') return;
  const result = await progress.settled.catch(() => undefined);
  await recallStreamedMessage(channel, result, scope);
}

async function recallStreamedMessage(
  channel: LarkChannel,
  streamResult: unknown,
  scope: string,
): Promise<void> {
  const messageId = (streamResult as { messageId?: string } | undefined)?.messageId;
  if (!messageId) return;
  try {
    await channel.recallMessage(messageId);
    log.info('outbound', 'recall-empty', { scope, messageId });
  } catch (err) {
    log.warn('outbound', 'recall-empty-failed', {
      scope,
      messageId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

async function sendFinalReply(input: {
  channel: LarkChannel;
  chatId: string;
  scope: string;
  state: RunState;
  replyMode: ReturnType<typeof getMessageReplyMode>;
  sendOpts: { replyTo: string; replyInThread?: boolean };
  cardRenderOptions: FileLinkRenderOptions & { signCallback?: (action: string) => string };
}): Promise<void> {
  const body = renderText(input.state, input.cardRenderOptions);

  // Nothing deliverable to send (agent produced no text on a clean finish;
  // error/interrupt/timeout keep `body` non-empty via their notices). Skip
  // rather than post an empty card that renders as "(no content)".
  if (!body.trim()) {
    log.info('outbound', 'skip-empty', { scope: input.scope, mode: input.replyMode });
    return;
  }

  if (input.replyMode === 'card') {
    const result = await input.channel.send(
      input.chatId,
      { card: renderCard(input.state, input.cardRenderOptions) },
      input.sendOpts,
    );
    requireMessageReceipt(result, 'card');
    log.info('outbound', 'sent', outboundLogFields(input, 'card', body, result));
  } else if (input.replyMode === 'markdown') {
    if (body.trim()) {
      const result = await input.channel.send(
        input.chatId,
        { markdown: body },
        input.sendOpts,
      );
      requireMessageReceipt(result, 'markdown');
      log.info('outbound', 'sent', outboundLogFields(input, 'markdown', body, result));
    }
  } else if (body.trim()) {
    const result = await input.channel.send(
      input.chatId,
      { markdown: body },
      input.sendOpts,
    );
    requireMessageReceipt(result, 'text');
    log.info('outbound', 'sent', outboundLogFields(input, 'text', body, result));
  }
}

function requireMessageReceipt(result: { messageId?: string }, type: string): void {
  if (!result.messageId?.trim()) {
    throw new Error(`final ${type} reply missing message receipt`);
  }
}

async function sendCotCreateFailedNotice(input: {
  channel: LarkChannel;
  chatId: string;
  scope: string;
  sendOpts: { replyTo: string; replyInThread?: boolean };
}): Promise<void> {
  try {
    await input.channel.send(
      input.chatId,
      { markdown: '原生 COT 过程消息创建失败，已异常回退为普通进度显示。任务仍会继续，最终答复会单独发送；请检查 Bridge 日志排查原因。' },
      input.sendOpts,
    );
  } catch (err) {
    log.warn('cot', 'create-failed-notice-failed', {
      scope: input.scope,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

function outboundLogFields(
  input: {
    scope?: string;
    replyMode: ReturnType<typeof getMessageReplyMode>;
    sendOpts?: { replyTo?: string; replyInThread?: boolean };
  },
  type: string,
  body: string,
  result?: { messageId?: string },
): Record<string, unknown> {
  return {
    type,
    scope: input.scope,
    mode: input.replyMode,
    chars: body.length,
    messageId: result?.messageId,
    replyTo: input.sendOpts?.replyTo,
    replyInThread: input.sendOpts?.replyInThread === true,
  };
}

async function awaitRenderAwareStream(input: {
  mode: 'card' | 'markdown';
  progress: LazyProgressStream;
  renderDone: Promise<RunState>;
  producerStarted: () => boolean;
  fallback: (state: RunState) => Promise<void>;
}): Promise<void> {
  const streamResult = input.progress.settled.then(
    () => ({ kind: 'stream' as const, ok: true as const }),
    (err) => ({ kind: 'stream' as const, ok: false as const, err }),
  );
  const renderResult = input.renderDone.then(
    (state) => ({ kind: 'render' as const, ok: true as const, state }),
    (err) => ({ kind: 'render' as const, ok: false as const, err }),
  );
  const first = await Promise.race([streamResult, renderResult]);
  if (!first.ok) {
    if (first.kind === 'stream') {
      log.fail('stream', first.err, { mode: input.mode, step: 'stream' });
      const rendered = await renderResult;
      if (!rendered.ok) throw rendered.err;
      await runFallbackReply(input.mode, rendered.state, input.fallback);
      return;
    }
    throw first.err;
  }

  if (first.kind === 'stream') {
    const rendered = await renderResult;
    if (!rendered.ok) throw rendered.err;
    return;
  }

  // Nothing durable ever showed up, so no progress message was opened at all
  // (the common Codex final-only round). Whatever the run ended with still has
  // to reach the user as a standalone reply.
  if (!input.progress.opened()) {
    log.info('outbound', 'progress-stream-skipped', { mode: input.mode });
    await runFallbackReply(input.mode, first.state, input.fallback);
    return;
  }

  // The run ended before the stream did. A producer that hasn't started yet is
  // usually just a card still being created (two API round trips), so give the
  // stream its grace window rather than replying immediately — an immediate
  // fallback would post the same answer twice once the stream catches up.
  const terminal = await Promise.race([
    streamResult,
    delay(STREAM_TERMINAL_GRACE_MS).then(() => undefined),
  ]);

  if (!terminal) {
    if (input.producerStarted()) {
      log.warn('stream', 'terminal-grace-expired', {
        mode: input.mode,
        graceMs: STREAM_TERMINAL_GRACE_MS,
      });
      void streamResult.then((result) => {
        if (!result.ok) {
          log.fail('stream', result.err, { mode: input.mode, step: 'stream-terminal-late' });
        }
      });
      return;
    }
    // Still nothing on screen after the grace window: give up on the stream and
    // reply without it. `abandon()` keeps a late producer from rendering the
    // same answer again; the empty message it leaves is recalled in cleanup.
    input.progress.abandon();
    log.warn('stream', 'producer-not-started-before-agent-terminal', { mode: input.mode });
    await runFallbackReply(input.mode, first.state, input.fallback);
    return;
  }

  if (!terminal.ok) {
    // A stream that failed before producing anything delivered nothing, so the
    // reply still has to go out; one that failed later already showed its
    // content and the error is the caller's to handle.
    if (input.producerStarted()) throw terminal.err;
    log.fail('stream', terminal.err, { mode: input.mode, step: 'stream' });
    await runFallbackReply(input.mode, first.state, input.fallback);
  }
}

async function runFallbackReply(
  mode: 'card' | 'markdown',
  state: RunState,
  fallback: (state: RunState) => Promise<void>,
): Promise<void> {
  try {
    await fallback(state);
  } catch (err) {
    log.fail('stream', err, { mode, step: 'fallback' });
  }
}

function scheduleWorkingReactionCleanup(
  channel: LarkChannel,
  messageId: string,
  reactionPromise: Promise<string | undefined> | undefined,
): void {
  if (!reactionPromise) return;

  void (async () => {
    const reactionResult = reactionPromise.then(
      (reactionId) => ({ ok: true as const, reactionId }),
      (err) => ({ ok: false as const, err }),
    );
    const settled = await Promise.race([
      reactionResult,
      delay(REACTION_CLEANUP_GRACE_MS).then(() => undefined),
    ]);

    if (!settled) {
      log.warn('reaction', 'cleanup-deferred', {
        messageId,
        graceMs: REACTION_CLEANUP_GRACE_MS,
      });
      void reactionResult.then((result) => {
        if (!result.ok || !result.reactionId) return;
        void removeReaction(channel, messageId, result.reactionId);
      });
      return;
    }

    if (!settled.ok || !settled.reactionId) return;
    await removeReaction(channel, messageId, settled.reactionId);
  })();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
