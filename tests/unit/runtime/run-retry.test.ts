import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../../../src/agent/types';
import { CodexJsonlTranslator } from '../../../src/agent/codex/jsonl';
import { ActiveRuns } from '../../../src/bot/active-runs';
import { ProcessPool } from '../../../src/bot/process-pool';
import { initialState, reduce } from '../../../src/card/run-state';
import { renderCard } from '../../../src/card/run-renderer';
import { renderText } from '../../../src/card/text-renderer';
import type { RunPolicyAllow } from '../../../src/policy/run-policy';
import { RunExecutor } from '../../../src/runtime/run-executor';
import { FakeAgentAdapter, type FakeAgentEvents } from '../../helpers/fake-agent';

const rateLimit: AgentEvent = { type: 'error', terminationReason: 'failed',
  message: 'exceeded retry limit, last status: 429 Too Many Requests' };
const done: AgentEvent = { type: 'done', terminationReason: 'normal' };
afterEach(() => vi.useRealTimers());

function harness(events: FakeAgentEvents) {
  vi.useFakeTimers();
  const agent = new FakeAgentAdapter({ events });
  const activeRuns = new ActiveRuns();
  const pool = new ProcessPool(() => 1);
  const executor = new RunExecutor({ agent, activeRuns, pool, postDoneExitGraceMs: 10 });
  const policy: RunPolicyAllow = { ok: true, prompt: 'original task', requestedCwd: '/repo', cwdRealpath: '/repo',
    accessMode: 'workspace', sandbox: 'workspace-write', permissionMode: 'acceptEdits',
    access: { ok: true, reason: 'allowed-user' }, attachments: [], policyFingerprint: 'fp', expiresAt: Date.now() + 1000 };
  return { agent, activeRuns, pool, executor, policy };
}

async function collect(events: AsyncIterable<AgentEvent>) {
  const output: AgentEvent[] = [];
  for await (const event of events) output.push(event);
  return output;
}

describe('rate-limit retries through RunExecutor', () => {
  it('reports a disconnected stream as a transient retry instead of a rate limit', async () => {
    const h = harness([[{ type: 'system', threadId: 'child' }, { type: 'error', terminationReason: 'failed',
      message: 'stream disconnected before completion: stream closed before response.completed' }], [done]]);
    const run = await h.executor.submit({ scopeId: 's', policy: h.policy });
    const output = collect(run.subscribe());
    await vi.advanceTimersByTimeAsync(30_000);
    const events = await output;
    const retry = events.find(e => e.type === 'retry' && e.delayMs > 0)!;
    expect(retry).toMatchObject({ type: 'retry', failureKind: 'transient', delayMs: 30_000 });
    const text = renderText(reduce(initialState, retry));
    expect(text).toContain('API 连接或服务暂时异常');
    expect(text).not.toContain('API 限流');
    expect(await run.result).toBe('completed');
  });

  it('backs off, retains the scope and options, fans out only one successful result, and releases the slot', async () => {
    const h = harness([[{ type: 'system', threadId: 'thread-1' }, rateLimit], [done]]);
    const run = await h.executor.submit({ scopeId: 's', policy: h.policy, model: 'model', reasoningEffort: 'high',
      images: ['/private/picture.png'], stopGraceMs: 250 });
    const output = collect(run.subscribe());
    const secondSubscriber = collect(run.subscribe());
    await vi.advanceTimersByTimeAsync(29_999);
    expect(h.agent.runs).toHaveLength(1);
    expect(h.pool.snapshot().active).toBe(1);
    await expect(h.executor.submit({ scopeId: 's', policy: { ...h.policy, expiresAt: Date.now() + 1000 } }))
      .rejects.toMatchObject({ code: 'run-already-active' });
    await vi.advanceTimersByTimeAsync(1);
    const events = await output;
    expect(await secondSubscriber).toEqual(events);
    expect(events.filter(e => e.type === 'error')).toEqual([]);
    expect(events.filter(e => e.type === 'done')).toEqual([done]);
    expect(events).toContainEqual({ type: 'retry', attempt: 1, maxAttempts: 100, delayMs: 30_000 });
    expect(h.agent.runOptions[1]).toEqual({ ...h.agent.runOptions[0], threadId: 'thread-1' });
    expect(await run.result).toBe('completed');
    expect(h.activeRuns.get('s')).toBeUndefined();
    expect(h.pool.snapshot().active).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['sessionId', 'threadId'] as const)('resumes partial work using the emitted %s and a continuation prompt', async id => {
    const h = harness([[{ type: 'system', [id]: 'new-session' },
      { type: 'tool_use', id: 'write', name: 'write', input: {} },
      { type: 'tool_result', id: 'write', output: 'saved', isError: false }, rateLimit], [done]]);
    const run = await h.executor.submit({ scopeId: 's', policy: h.policy, [id]: 'old-session', images: ['/picture.png'] });
    const output = collect(run.subscribe());
    await vi.advanceTimersByTimeAsync(30_000);
    await output;
    expect(h.agent.runOptions[1]?.[id]).toBe('new-session');
    expect(h.agent.runOptions[1]?.prompt).toContain('不要重复执行已完成的操作');
    expect(h.agent.runOptions[1]?.images).toBeUndefined();
  });

  it('stops after 100 retries, caps the backoff at two minutes, and reports the last error once', async () => {
    const h = harness([...Array.from({ length: 101 }, () => [rateLimit]), [done]]);
    const run = await h.executor.submit({ scopeId: 's', policy: h.policy });
    const output = collect(run.subscribe());
    await vi.advanceTimersByTimeAsync(11_850_000);
    const events = await output;
    expect(events.filter(e => e.type === 'retry' && e.delayMs > 0).map(e => e.type === 'retry' && e.delayMs))
      .toEqual([30_000, 60_000, ...Array(98).fill(120_000)]);
    expect(events.filter(e => e.type === 'error')).toEqual([rateLimit]);
    expect(h.agent.runs).toHaveLength(101);
    expect(await run.result).toBe('failed');
    expect(h.pool.snapshot().active).toBe(0);
  });

  it.each<AgentEvent>([
    { type: 'text', delta: 'continuing the task' },
    { type: 'final_text', content: 'partial answer' },
    { type: 'thinking', delta: 'checking the next step' },
    { type: 'tool_use', id: 'read', name: 'read', input: {} },
    { type: 'tool_result', id: 'read', output: '', isError: false },
  ])('resets the retry count and backoff after $type progress', async progress => {
    const system: AgentEvent = { type: 'system', threadId: 'thread-1' };
    const h = harness([[system, rateLimit], [system, progress, rateLimit],
      [system, rateLimit], [system, rateLimit], [done]]);
    const run = await h.executor.submit({ scopeId: 's', policy: h.policy, images: ['/picture.png'] });
    const output = collect(run.subscribe());
    await vi.advanceTimersByTimeAsync(240_000);
    const events = await output;
    expect(events.filter(e => e.type === 'retry' && e.delayMs > 0)).toEqual([
      { type: 'retry', attempt: 1, maxAttempts: 100, delayMs: 30_000 },
      { type: 'retry', attempt: 1, maxAttempts: 100, delayMs: 30_000 },
      { type: 'retry', attempt: 2, maxAttempts: 100, delayMs: 60_000 },
      { type: 'retry', attempt: 3, maxAttempts: 100, delayMs: 120_000 },
    ]);
    expect(events.filter(e => e.type === 'retry' && e.delayMs === 0).map(e => e.type === 'retry' && e.attempt))
      .toEqual([1, 1, 2, 3]);
    expect(events).toContainEqual(progress);
    expect(events.filter(e => e.type === 'error')).toEqual([]);
    expect(events.filter(e => e.type === 'done')).toEqual([done]);
    expect(h.agent.runs).toHaveLength(5);
    for (const options of h.agent.runOptions.slice(2)) {
      expect(options.threadId).toBe('thread-1');
      expect(options.prompt).toContain('不要重复执行已完成的操作');
      expect(options.images).toBeUndefined();
    }
    expect(await run.result).toBe('completed');
    expect(h.activeRuns.get('s')).toBeUndefined();
    expect(h.pool.snapshot().active).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('allows another retry when progress resumes on the last allowed attempt', async () => {
    const h = harness([[{ type: 'system', sessionId: 'session-1' }, rateLimit],
      ...Array.from({ length: 99 }, () => [rateLimit]),
      [{ type: 'text', delta: 'recovered' }, rateLimit], [done]]);
    const run = await h.executor.submit({ scopeId: 's', policy: h.policy });
    const output = collect(run.subscribe());
    await vi.advanceTimersByTimeAsync(11_880_000);
    const events = await output;
    expect(events.filter(e => e.type === 'retry' && e.delayMs > 0).map(e => e.type === 'retry' && e.attempt))
      .toEqual([...Array.from({ length: 100 }, (_, index) => index + 1), 1]);
    expect(h.agent.runOptions[101]?.sessionId).toBe('session-1');
    expect(await run.result).toBe('completed');
  });

  it('keeps resetting after repeated Codex app-server output followed by 429', async () => {
    const attempts = Array.from({ length: 5 }, (_, index) => {
      const translator = new CodexJsonlTranslator();
      return [
        ...translator.translate({ type: 'thread.started', thread_id: 'thread-1' }),
        ...translator.translate({ type: 'item.completed', item: {
          id: `message-${index}`, type: 'agent_message', text: `completed step ${index + 1}`,
        } }),
        ...translator.fail(rateLimit.message),
      ];
    });
    const h = harness([...attempts, [done]]);
    const run = await h.executor.submit({ scopeId: 's', policy: h.policy });
    const output = collect(run.subscribe());
    await vi.advanceTimersByTimeAsync(150_000);
    const events = await output;
    expect(events.filter(e => e.type === 'retry' && e.delayMs > 0)).toEqual(
      Array.from({ length: 5 }, () => ({ type: 'retry', attempt: 1, maxAttempts: 100, delayMs: 30_000 })),
    );
    expect(events.filter(e => e.type === 'text')).toEqual(
      Array.from({ length: 5 }, (_, index) => ({ type: 'text', delta: `completed step ${index + 1}` })),
    );
    expect(events.filter(e => e.type === 'error')).toEqual([]);
    expect(h.agent.runs).toHaveLength(6);
    expect(await run.result).toBe('completed');
    expect(h.pool.snapshot().active).toBe(0);
  });

  it('does not reset retries for session metadata, usage, or empty output', async () => {
    const noProgress: AgentEvent[] = [{ type: 'system', threadId: 'thread-1' },
      { type: 'usage', inputTokens: 100, outputTokens: 1 },
      { type: 'text', delta: '' }, { type: 'text', delta: ' \n' },
      { type: 'thinking', delta: '' }, { type: 'thinking', delta: ' \n' },
      { type: 'final_text', content: '' }, { type: 'final_text', content: ' \n' }, rateLimit];
    const h = harness([...Array.from({ length: 101 }, () => noProgress), [done]]);
    const run = await h.executor.submit({ scopeId: 's', policy: h.policy });
    const output = collect(run.subscribe());
    await vi.advanceTimersByTimeAsync(11_850_000);
    const events = await output;
    expect(events.filter(e => e.type === 'retry' && e.delayMs > 0).map(e => e.type === 'retry' && e.delayMs))
      .toEqual([30_000, 60_000, ...Array(98).fill(120_000)]);
    expect(events.filter(e => e.type === 'error')).toEqual([rateLimit]);
    expect(h.agent.runs).toHaveLength(101);
    expect(await run.result).toBe('failed');
  });

  it.each(['execution', 'scope', 'abort', 'all'] as const)('cancels the pending timer via %s without another spawn', async kind => {
    const h = harness([[rateLimit], [done]]);
    const controller = new AbortController();
    const run = await h.executor.submit({ scopeId: 's', policy: h.policy, signal: controller.signal });
    const output = collect(run.subscribe());
    await vi.advanceTimersByTimeAsync(1);
    if (kind === 'execution') await run.stop();
    if (kind === 'scope') h.activeRuns.interrupt('s');
    if (kind === 'abort') controller.abort();
    if (kind === 'all') await h.activeRuns.stopAll();
    await output;
    expect(await run.result).toBe('stopped');
    await vi.advanceTimersByTimeAsync(300_000);
    expect(h.agent.runs).toHaveLength(1);
    expect(h.pool.snapshot().active).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('enforces the original deadline during backoff', async () => {
    const h = harness([[rateLimit], [done]]);
    const run = await h.executor.submit({ scopeId: 's', policy: h.policy, deadlineAt: Date.now() + 10_000 });
    const output = collect(run.subscribe());
    await vi.advanceTimersByTimeAsync(10_000);
    await output;
    expect(await run.result).toBe('expired');
    expect(h.agent.runs).toHaveLength(1);
    expect(h.pool.snapshot().active).toBe(0);
  });

  it.each([
    'HTTP 429 insufficient_quota', 'HTTP 429 budget_exceeded', 'HTTP 429 credit balance is too low',
    '401 Unauthorized', '429 authentication failed', '429 delivery is unknown', 'permission denied',
  ])('does not retry %s', async message => {
    const error: AgentEvent = { type: 'error', terminationReason: 'failed', message };
    const h = harness([[error], [done]]);
    const run = await h.executor.submit({ scopeId: 's', policy: h.policy });
    expect(await collect(run.subscribe())).toEqual([error]);
    expect(h.agent.runs).toHaveLength(1);
    expect(await run.result).toBe('failed');
  });

  it.each(['interrupted', 'timeout'] as const)('does not retry a %s termination containing 429', async terminationReason => {
    const h = harness([[{ type: 'error', message: '429', terminationReason }], [done]]);
    const run = await h.executor.submit({ scopeId: 's', policy: h.policy });
    await collect(run.subscribe());
    expect(h.agent.runs).toHaveLength(1);
  });

  it('does not replay partial work against an old session when the attempt emitted no session id', async () => {
    const h = harness([[{ type: 'text', delta: 'progress' }, rateLimit], [done]]);
    const run = await h.executor.submit({ scopeId: 's', policy: h.policy, threadId: 'old' });
    expect(await collect(run.subscribe())).toContainEqual(rateLimit);
    expect(h.agent.runs).toHaveLength(1);
  });

  it('does not attempt to resume ephemeral forked work', async () => {
    const h = harness([[{ type: 'system', threadId: 'fork' }, rateLimit], [done]]);
    const run = await h.executor.submit({ scopeId: 's', policy: h.policy, threadId: 'parent', forkSession: true });
    expect(await collect(run.subscribe())).toContainEqual(rateLimit);
    expect(h.agent.runs).toHaveLength(1);
  });

  it('waits for a failed child to exit before spawning and refuses overlap if stop does not finish', async () => {
    const h = harness([[rateLimit], [done]]);
    h.agent.setWaitForExit([false, true]);
    const run = await h.executor.submit({ scopeId: 's', policy: h.policy });
    expect(await collect(run.subscribe())).toEqual([rateLimit]);
    expect(h.agent.runs[0]?.stopped).toBe(true);
    expect(h.agent.runs).toHaveLength(1);
  });

  it('rechecks cancellation after asynchronous retry preparation', async () => {
    const h = harness([[rateLimit], [done]]);
    let releasePrepare!: () => void;
    const prepare = vi.fn().mockResolvedValueOnce(undefined).mockImplementationOnce(() => new Promise<void>(resolve => { releasePrepare = resolve; }));
    Object.assign(h.agent, { prepareRun: prepare });
    const run = await h.executor.submit({ scopeId: 's', policy: h.policy });
    const output = collect(run.subscribe());
    await vi.advanceTimersByTimeAsync(30_000);
    expect(prepare).toHaveBeenCalledTimes(2);
    await run.stop();
    releasePrepare();
    await output;
    expect(h.agent.runs).toHaveLength(1);
    expect(await run.result).toBe('stopped');
  });

  it('reports retry preparation failures and frees the slot', async () => {
    const h = harness([[rateLimit], [done]]);
    Object.assign(h.agent, { prepareRun: vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('binary disappeared')) });
    const run = await h.executor.submit({ scopeId: 's', policy: h.policy });
    const output = collect(run.subscribe());
    await vi.advanceTimersByTimeAsync(30_000);
    expect((await output).at(-1)).toMatchObject({ type: 'error', message: 'Error: binary disappeared' });
    expect(await run.result).toBe('failed');
    expect(h.pool.snapshot().active).toBe(0);
  });

  it('routes steering and stop to the current attempt, and never delivers steering during backoff', async () => {
    const h = harness([[{ type: 'system', threadId: 'thread' }, rateLimit], []]);
    const spawn = h.agent.run.bind(h.agent);
    const steers: ReturnType<typeof vi.fn>[] = [];
    h.agent.run = options => {
      const raw = spawn(options);
      const steer = vi.fn().mockResolvedValue('accepted');
      steers.push(steer);
      if (h.agent.runs.length === 2) {
        let release!: () => void;
        const stopped = new Promise<void>(resolve => { release = resolve; });
        return { runId: raw.runId, steer, waitForExit: raw.waitForExit.bind(raw),
          stop: async () => { await raw.stop(); release(); },
          events: { async *[Symbol.asyncIterator]() {
            yield { type: 'system', threadId: 'thread' };
            await stopped;
            yield { type: 'done', terminationReason: 'interrupted' };
          } } };
      }
      return Object.assign(raw, { steer });
    };
    const run = await h.executor.submit({ scopeId: 's', policy: h.policy });
    expect(await run.run.steer!('supplement', 'm1')).toBe('accepted');
    const events = run.subscribe()[Symbol.asyncIterator]();
    expect((await events.next()).value.type).toBe('system');
    expect((await events.next()).value.type).toBe('retry');
    expect(await run.run.steer!('later', 'm2')).toBe('inactive');
    const next = events.next();
    await vi.advanceTimersByTimeAsync(30_000);
    expect((await next).value).toMatchObject({ type: 'retry', delayMs: 0 });
    expect(h.agent.runOptions[1]?.prompt).toContain('中途补充');
    expect(await run.run.steer!('new attempt', 'm3')).toBe('accepted');
    expect(steers[0]).toHaveBeenCalledTimes(1);
    expect(steers[1]).toHaveBeenCalledWith('new attempt', 'm3');
    await run.stop();
    expect(h.agent.runs[1]?.stopped).toBe(true);
  });

  it('does not treat an exited attempt as the end of the logical run while waiting to retry', async () => {
    const h = harness([[rateLimit], [done]]);
    const run = await h.executor.submit({ scopeId: 's', policy: h.policy });
    const output = collect(run.subscribe());
    await vi.advanceTimersByTimeAsync(1);
    const exited = run.run.waitForExit(10);
    await vi.advanceTimersByTimeAsync(10);
    expect(await exited).toBe(false);
    await vi.advanceTimersByTimeAsync(30_000);
    await output;
    expect(await run.run.waitForExit(10)).toBe(true);
  });

  it('shows retry progress in both renderers without ending the run or polluting the answer', () => {
    const state = reduce(initialState, { type: 'retry', attempt: 2, maxAttempts: 3, delayMs: 60_000 });
    expect(state.terminal).toBe('running');
    expect(renderText(state)).toContain('60 秒后自动重试（2/3）');
    expect(JSON.stringify(renderCard(state))).toContain('60 秒后自动重试（2/3）');
    expect(JSON.stringify(renderCard(state))).toContain('终止');
    const resumed = reduce(state, { type: 'final_text', content: 'answer' });
    expect(resumed.retry).toBeUndefined();
    expect(renderText(reduce(resumed, done))).not.toContain('重试');
  });
});
