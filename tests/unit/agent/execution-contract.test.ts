import { afterEach, describe, expect, it, vi } from 'vitest';
import { executionCapabilities, sendRunInput, supportsRunInput, withExecutionContract } from '../../../src/agent/execution';
import type { AgentAdapter, AgentEvent, AgentExecutionCapabilities, AgentRun } from '../../../src/agent/types';
import { retryingRun } from '../../../src/runtime/retrying-run';

const capabilities: AgentExecutionCapabilities = { finalAnswer: 'separate-event', input: 'active-turn' };
const failure: AgentEvent = { type: 'error', terminationReason: 'failed', message: '429 Too Many Requests' };
const done: AgentEvent = { type: 'done', terminationReason: 'normal' };
function native(events: AgentEvent[] = []): AgentRun {
  return { runId: 'r', events: (async function* () { yield* events; })(),
    steer: vi.fn(async () => 'accepted' as const), stop: vi.fn(async () => {}), waitForExit: vi.fn(async () => true) };
}
async function collect(events: AsyncIterable<AgentEvent>) { const result: AgentEvent[] = []; for await (const event of events) result.push(event); return result; }
afterEach(() => vi.useRealTimers());

describe('agent execution contract', () => {
  it('preserves public progress, authoritative final output and terminal ordering', async () => {
    const events: AgentEvent[] = [{ type: 'text', delta: 'checking' }, { type: 'final_text', content: 'answer' }, done];
    const transport = native(events);
    const run = withExecutionContract(transport, capabilities);
    expect(await sendRunInput(run, { text: 'more', messageId: 'm' }))
      .toEqual({ status: 'accepted', messageId: 'm', scope: 'active-turn' });
    expect(await collect(run.events)).toEqual(events);
    expect(await sendRunInput(run, { text: 'late', messageId: 'late' })).toEqual({ status: 'inactive', messageId: 'late' });
    expect(transport.steer).toHaveBeenCalledTimes(1);
    await run.waitForExit(123); expect(transport.waitForExit).toHaveBeenCalledWith(123);
  });

  it('closes input before awaiting stop or emitting a thrown stream failure', async () => {
    const transport = native();
    const run = withExecutionContract(transport, capabilities);
    await run.stop();
    expect(await sendRunInput(run, { text: 'late', messageId: 'm' })).toMatchObject({ status: 'inactive' });
    expect(transport.steer).not.toHaveBeenCalled(); expect(transport.stop).toHaveBeenCalledTimes(1);
    const broken = withExecutionContract({ ...native(), events: (async function* () { throw new Error('401 unauthorized'); })() }, capabilities);
    const iterator = broken.events[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toMatchObject({ type: 'error', failureKind: 'authentication' });
    expect(await sendRunInput(broken, { text: 'late', messageId: 'm' })).toMatchObject({ status: 'inactive' });
    await iterator.return?.();
  });

  it('keeps legacy adapters conservative without disabling their existing input', async () => {
    const run = native();
    expect(executionCapabilities(run).finalAnswer).toBe('stream');
    expect(supportsRunInput(run)).toBe(true);
    expect(await sendRunInput(run, { text: 'more', messageId: 'm' })).toMatchObject({ status: 'accepted', scope: 'active-session' });
    const unsupported = withExecutionContract(run, { finalAnswer: 'separate-event', input: 'unsupported' });
    expect(supportsRunInput(unsupported)).toBe(false);
    expect(await sendRunInput(unsupported, { text: 'no', messageId: 'n' })).toEqual({ status: 'unsupported', messageId: 'n' });
    expect(run.steer).toHaveBeenCalledTimes(1);
  });

  it('treats lost or mismatched receipts as unknown without another delivery', async () => {
    const run = native();
    vi.mocked(run.steer!).mockRejectedValue(new Error('lost receipt'));
    expect(await sendRunInput(withExecutionContract(run, capabilities), { text: 'once', messageId: 'm' }))
      .toMatchObject({ status: 'unknown', messageId: 'm' });
    expect(run.steer).toHaveBeenCalledTimes(1);
    run.sendInput = vi.fn(async () => ({ status: 'accepted', messageId: 'other', scope: 'active-turn' } as const));
    expect(await sendRunInput(run, { text: 'once', messageId: 'm' })).toMatchObject({ status: 'unknown', messageId: 'm' });
    expect(run.sendInput).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['429 insufficient_quota', 'quota'], ['429 unauthorized', 'authentication'],
    ['429 delivery is unknown', 'delivery_unknown'], ['429 Too Many Requests', 'rate_limit'], ['process exited', 'runtime'],
    ['stream disconnected before completion: stream closed before response.completed', 'transient'],
    ['read ECONNRESET', 'transient'], ['connect ETIMEDOUT', 'transient'], ['getaddrinfo EAI_AGAIN', 'transient'],
    ['HTTP 503 Service Unavailable', 'transient'], ['HTTP/1.1 502 Bad Gateway', 'transient'],
    ['HTTP 400 invalid request', 'runtime'], ['HTTP 501 Not Implemented', 'runtime'],
    ['HTTP 503 delivery is unknown', 'delivery_unknown'], ['HTTP 503 insufficient_quota', 'quota'],
  ])('normalizes %s at the adapter boundary as %s', async (message, failureKind) => {
    const run = withExecutionContract(native([{ type: 'error', terminationReason: 'failed', message }]), capabilities);
    expect(await collect(run.events)).toEqual([{ type: 'error', terminationReason: 'failed', message, failureKind }]);
  });

  it.each(['quota', 'authentication', 'delivery_unknown', 'runtime'] as const)('honors explicit %s over text suggesting 429', async failureKind => {
    const initialRun = withExecutionContract(native([{ ...failure, failureKind }]), capabilities);
    const agent: AgentAdapter = { id: 'any-engine', displayName: 'Test', capabilities, isAvailable: async () => true, run: vi.fn() };
    const run = retryingRun({ agent, initialRun, options: { runId: 'r', prompt: 'task' }, exitGraceMs: 10, canRetry: () => true });
    expect(await collect(run.events)).toEqual([{ ...failure, failureKind }]); expect(agent.run).not.toHaveBeenCalled();
  });

  it.each(['unknown', 'pending'])('does not restart a failed turn when an input receipt is %s', async state => {
    let resolve!: (value: 'accepted') => void;
    const transport = native([failure]);
    transport.steer = state === 'unknown' ? async () => { throw new Error('lost receipt'); }
      : () => new Promise(r => { resolve = r; });
    const agent: AgentAdapter = { id: 'any-engine', displayName: 'Test', isAvailable: async () => true, run: vi.fn() };
    const run = retryingRun({ agent, initialRun: withExecutionContract(transport, capabilities),
      options: { runId: 'r', prompt: 'task' }, exitGraceMs: 10, canRetry: () => true });
    const receipt = sendRunInput(run, { text: 'supplement', messageId: 'm' });
    if (state === 'unknown') expect(await receipt).toMatchObject({ status: 'unknown' });
    const iterator = run.events[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toMatchObject({ type: 'error' });
    if (state === 'pending') { resolve('accepted'); await receipt; }
    await iterator.return?.();
    expect(agent.run).not.toHaveBeenCalled();
  });

  it('keeps capabilities and routes input to the resumed attempt while retaining its deadline', async () => {
    vi.useFakeTimers();
    const first = native([{ type: 'system', threadId: 'thread' }, failure]);
    const second = native([{ type: 'final_text', content: 'answer' }, done]);
    const agent: AgentAdapter = { id: 'any-engine', displayName: 'Test', capabilities, isAvailable: async () => true,
      run: vi.fn(() => withExecutionContract(second, capabilities)) };
    const options = { runId: 'r', prompt: 'task', deadlineAt: Date.now() + 60_000 };
    const run = retryingRun({ agent, initialRun: withExecutionContract(first, capabilities), options, exitGraceMs: 10, canRetry: () => true });
    expect(await sendRunInput(run, { text: 'first', messageId: '1' })).toMatchObject({ status: 'accepted' });
    const iterator = run.events[Symbol.asyncIterator]();
    await iterator.next();
    expect((await iterator.next()).value).toMatchObject({ type: 'retry', delayMs: 30_000 });
    expect(await sendRunInput(run, { text: 'wait', messageId: '2' })).toMatchObject({ status: 'inactive' });
    const next = iterator.next(); await vi.advanceTimersByTimeAsync(30_000); await next;
    expect(run.capabilities).toEqual(capabilities);
    expect(await sendRunInput(run, { text: 'resumed', messageId: '3' })).toMatchObject({ status: 'accepted', scope: 'active-turn' });
    expect(first.steer).toHaveBeenCalledTimes(1); expect(second.steer).toHaveBeenCalledWith('resumed', '3');
    expect(agent.run).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'thread', deadlineAt: options.deadlineAt, prompt: expect.stringContaining('中途补充') }));
    await iterator.return?.(); await run.stop();
  });
});
