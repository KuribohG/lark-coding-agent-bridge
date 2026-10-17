import { mkdir } from 'node:fs/promises';
import { agentFailureKind, executionCapabilities } from '../agent/execution';
import type { AgentAdapter, AgentEvent, AgentFailureKind, AgentRunOptions } from '../agent/types';
import { log } from '../core/logger';
import { retryingRun } from './retrying-run';

export class BackgroundExecutionError extends Error {
  constructor(readonly code: AgentFailureKind | 'timeout' | 'cancelled' | 'incomplete' | 'unsupported') {
    super(`Background execution failed: ${code}`);
  }
}

/** Collect an authoritative answer; the caller owns prompts and result validation. */
export async function executeBackgroundRun(agent: AgentAdapter, options: AgentRunOptions & { cwd: string },
  signal: AbortSignal, onEvent?: (event: AgentEvent) => void) {
  signal.throwIfAborted();
  if (executionCapabilities(agent).finalAnswer !== 'separate-event') throw new BackgroundExecutionError('unsupported');
  await mkdir(options.cwd, { recursive: true, mode: 0o700 });
  const deadlineAt = options.deadlineAt ?? Date.now() + 30 * 60_000;
  // Pass the effective deadline to every attempt, including the native watchdog.
  const runOptions = { ...options, deadlineAt };
  if (Date.now() >= deadlineAt) throw new BackgroundExecutionError('timeout');
  await agent.prepareRun?.(runOptions);
  signal.throwIfAborted();
  if (Date.now() >= deadlineAt) throw new BackgroundExecutionError('timeout');
  const run = retryingRun({ agent, initialRun: agent.run(runOptions), options: runOptions, exitGraceMs: 1000,
    canRetry: () => !signal.aborted && Date.now() < deadlineAt });
  let stopping: Promise<void> | undefined;
  let timedOut = false;
  const stop = () => { stopping ??= run.stop(); void stopping.catch(() => {}); };
  const timer = setTimeout(() => { timedOut = true; stop(); }, Math.max(0, deadlineAt - Date.now()));
  signal.addEventListener('abort', stop, { once: true });
  let text = '', inputTokens = 0, outputTokens = 0, completed = false;
  try {
    if (signal.aborted) { stop(); signal.throwIfAborted(); }
    if (executionCapabilities(run).finalAnswer !== 'separate-event') throw new BackgroundExecutionError('unsupported');
    for await (const event of run.events) {
      signal.throwIfAborted();
      onEvent?.(event);
      if (event.type === 'final_text') text = event.content;
      if (event.type === 'usage') { inputTokens = event.inputTokens ?? inputTokens; outputTokens = event.outputTokens ?? outputTokens; }
      if (event.type === 'retry' && event.delayMs > 0) text = '';
      if (event.type === 'error' || event.type === 'done') {
        if (timedOut || Date.now() >= deadlineAt || event.terminationReason === 'timeout') throw new BackgroundExecutionError('timeout');
        if (event.terminationReason === 'interrupted') throw new BackgroundExecutionError('cancelled');
        if (event.type === 'error') {
          log.warn('run', 'background-agent-error', { runId: options.runId, error: event.message });
          throw new BackgroundExecutionError(agentFailureKind(event));
        }
        completed = true; break;
      }
    }
    signal.throwIfAborted();
    if (timedOut) throw new BackgroundExecutionError('timeout');
    if (!completed || !text) throw new BackgroundExecutionError('incomplete');
    return { text, inputTokens, outputTokens };
  } finally {
    clearTimeout(timer); signal.removeEventListener('abort', stop);
    if (!completed || !await run.waitForExit(1000)) stop();
    await stopping;
  }
}
