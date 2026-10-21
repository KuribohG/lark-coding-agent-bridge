import type { AgentAdapter, AgentEvent, AgentInput, AgentInputReceipt, AgentRun, AgentRunOptions } from '../agent/types';
import { agentFailureKind, classifyAgentFailure, sendRunInput, supportsRunInput } from '../agent/execution';
import { log } from '../core/logger';

const RETRY_DELAYS_MS = [30_000, 60_000, 120_000] as const;
const CONTINUE_PROMPT = '上次执行因 API 限流中断。请从当前会话的已有进度继续完成用户请求，包括中途补充的要求。先检查已完成的操作和工具结果，不要重复执行已完成的操作。';

function isRateLimitError(event: AgentEvent): boolean {
  return event.type === 'error' && event.terminationReason === 'failed'
    && agentFailureKind(event) === 'rate_limit';
}

function isProgressEvent(event: AgentEvent): boolean {
  switch (event.type) {
    case 'text':
    case 'thinking':
      return event.delta.trim().length > 0;
    case 'final_text':
      return event.content.trim().length > 0;
    case 'tool_use':
    case 'tool_result':
    case 'user_input':
      return true;
    default:
      return false;
  }
}

/** Keep one scope, pool slot, and stop handle across consecutive rate-limit retries. */
export function retryingRun(input: {
  agent: AgentAdapter;
  initialRun: AgentRun;
  options: AgentRunOptions;
  exitGraceMs: number;
  canRetry(): boolean;
}): AgentRun {
  let current = input.initialRun;
  const controller = new AbortController();
  let terminal = false;
  let waiting = false;
  let steered = false;
  let uncertainInput = false;
  let pendingInputs = 0;
  let resolveFinished!: () => void;
  const finished = new Promise<void>(resolve => { resolveFinished = resolve; });
  const finish = () => { terminal = true; resolveFinished(); };
  const canRetry = () => !controller.signal.aborted && input.canRetry();

  async function* events(): AsyncGenerator<AgentEvent> {
    let sessionId: string | undefined;
    let threadId: string | undefined;
    let madeProgress = false;
    let attempt = 0;
    try {
      while (!controller.signal.aborted) {
        let failure: Extract<AgentEvent, { type: 'error' }> | undefined;
        for await (const event of current.events) {
          if (event.type === 'system') {
            sessionId = event.sessionId ?? sessionId;
            threadId = event.threadId ?? threadId;
          }
          if (isProgressEvent(event)) {
            madeProgress = true;
            // Recovery starts a fresh retry budget, but keeps the session's progress.
            attempt = 0;
          }
          if (event.type === 'error' && isRateLimitError(event) && attempt < RETRY_DELAYS_MS.length
            && !uncertainInput && pendingInputs === 0
            && !input.options.forkSession && (!(madeProgress || steered) || sessionId || threadId) && canRetry()) {
            failure = event;
            waiting = true;
            break;
          }
          if (event.type === 'done' || event.type === 'error') finish();
          yield event;
          if (terminal) return;
        }
        if (!failure) return;

        if (!await current.waitForExit(input.exitGraceMs)) {
          await current.stop();
          if (!await current.waitForExit(input.exitGraceMs)) {
            finish();
            yield failure;
            return;
          }
        }
        if (!canRetry()) break;
        const delayMs = RETRY_DELAYS_MS[attempt++]!;
        log.warn('run', 'rate-limit-retry', { runId: input.options.runId, agent: input.agent.id,
          attempt, maxAttempts: RETRY_DELAYS_MS.length, delayMs, error: failure.message });
        yield { type: 'retry', attempt, maxAttempts: RETRY_DELAYS_MS.length, delayMs };
        await waitForRetry(delayMs, controller.signal);
        if (!canRetry()) break;

        const options: AgentRunOptions = {
          ...input.options,
          sessionId: sessionId ?? input.options.sessionId,
          threadId: threadId ?? input.options.threadId,
          prompt: madeProgress || steered ? CONTINUE_PROMPT : input.options.prompt,
          images: madeProgress || steered ? undefined : input.options.images,
        };
        await input.agent.prepareRun?.(options);
        if (!canRetry()) break;
        current = input.agent.run(options);
        waiting = false;
        log.info('run', 'rate-limit-retry-started', { runId: input.options.runId, agent: input.agent.id,
          attempt, maxAttempts: RETRY_DELAYS_MS.length });
        yield { type: 'retry', attempt, maxAttempts: RETRY_DELAYS_MS.length, delayMs: 0 };
      }
      finish();
      yield { type: 'done', terminationReason: 'interrupted' };
    } catch (error) {
      finish();
      if (controller.signal.aborted) yield { type: 'done', terminationReason: 'interrupted' };
      else yield { type: 'error', terminationReason: 'failed', message: String(error), failureKind: classifyAgentFailure(String(error)) };
    } finally {
      finish();
    }
  }

  const sendInput = async (message: AgentInput): Promise<AgentInputReceipt> => {
    if (waiting || terminal || controller.signal.aborted) return { status: 'inactive', messageId: message.messageId };
    pendingInputs++;
    try {
      const result = await sendRunInput(current, message);
      if (result.status === 'accepted') steered = true;
      if (result.status === 'unknown') uncertainInput = true;
      return result;
    } finally { pendingInputs--; }
  };

  return {
    runId: input.options.runId,
    get capabilities() { return current.capabilities; },
    events: events(),
    ...(supportsRunInput(current) ? { sendInput, async steer(text: string, messageId: string) {
      const result = await sendInput({ text, messageId });
      if (result.status === 'unknown') throw new Error(result.message);
      return result.status === 'accepted' ? 'accepted' as const : 'inactive' as const;
    } } : {}),
    async stop() {
      controller.abort();
      finish();
      await current.stop();
    },
    async waitForExit(timeoutMs) {
      const started = Date.now();
      if (!terminal) {
        let timer: NodeJS.Timeout | undefined;
        const ended = await Promise.race([finished.then(() => true), new Promise<boolean>(resolve => {
          timer = setTimeout(() => resolve(false), timeoutMs);
        })]);
        if (timer) clearTimeout(timer);
        if (!ended) return false;
      }
      return current.waitForExit(Math.max(0, timeoutMs - (Date.now() - started)));
    },
  };
}

function waitForRetry(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, delayMs);
    signal.addEventListener('abort', finish, { once: true });
  });
}
