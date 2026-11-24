import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { callWorkflow, WorkflowRuntime, type WorkerRun, type WorkerRunSpec, type WorkflowRoot } from '../src';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });

const root = (scopeId: string): WorkflowRoot => ({ scopeId, profile: 'embedded', agentKind: 'custom-agent', cwdRealpath: '/repo',
  policyFingerprint: 'policy', catalogBinding: 'main', modelSettings: {} });

async function start(scopeId: string, runner: { start(spec: WorkerRunSpec): Promise<WorkerRun> },
  extra: { stallMs?: number; toolStallMs?: number; script?: string } = {}) {
  const runtime = new WorkflowRuntime({
    path: ':memory:', resolveRoot: async () => root(scopeId), wakeMain: async () => {},
    retryDelaysMs: [10], ...(extra.stallMs === undefined ? {} : { stallMs: extra.stallMs }),
    ...(extra.toolStallMs === undefined ? {} : { toolStallMs: extra.toolStallMs }), runner,
  });
  await runtime.start();
  cleanup.push(() => runtime.close());
  const main = runtime.bindMain(scopeId, 'start');
  await callWorkflow('run_script', { operationId: randomUUID(), goal: 'health', plan: 'One worker answers.',
    script: extra.script ?? 'return await agent("do the work", {key:"a"});' }, main.env);
  main.release();
  return runtime;
}

/** Advances the scheduler until `done()` holds; ticks are what run the stall watchdog and retry timers. */
async function until(runtime: WorkflowRuntime, done: () => boolean, timeoutMs = 4_000): Promise<void> {
  const limit = Date.now() + timeoutMs;
  while (Date.now() < limit) {
    await runtime.tick();
    if (done()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('condition not reached');
}

describe('worker health', () => {
  it('retries a transient failure instead of failing the task', async () => {
    const specs: WorkerRunSpec[] = [];
    const runtime = await start('chat-retry', {
      async start(spec) {
        specs.push(spec);
        await spec.validateBeforeRun();
        const first = specs.length === 1;
        return {
          runId: `run-${specs.length}`, result: Promise.resolve(first ? 'failed' : 'completed'),
          stop: async () => {}, waitForExit: async () => true, stopReason: () => undefined,
          async *events() {
            yield { type: 'session', nativeSessionId: 'native-1' };
            if (first) yield { type: 'error', message: 'API Error: 429 Too Many Requests' };
            else yield { type: 'final_text', text: 'done' };
            yield { type: 'done', normal: !first };
          },
        };
      },
    });
    await until(runtime, () => specs.length === 2 && runtime.kernel.state('chat-retry')?.tasks[0]?.status === 'result_ready');
    const state = runtime.kernel.state('chat-retry')!;
    expect(state.tasks[0]!.attempts).toHaveLength(2);
    expect(state.tasks[0]!.retryCount).toBe(1);
    expect(state.tasks[0]!.attempts[0]!.failureKind).toBe('transient');
    expect(state.script?.status).toBe('result_ready');
  });

  it('retries in the session the failed attempt left, and accepts a new one from a backend that could not resume', async () => {
    const specs: WorkerRunSpec[] = [];
    const runtime = await start('chat-resume', {
      async start(spec) {
        specs.push(spec);
        await spec.validateBeforeRun();
        const attempt = specs.length;
        return {
          runId: `run-${attempt}`, result: Promise.resolve(attempt < 3 ? 'failed' : 'completed'),
          stop: async () => {}, waitForExit: async () => true, stopReason: () => undefined,
          async *events() {
            // The second attempt's backend ignores the resume and opens another conversation.
            yield { type: 'session', nativeSessionId: attempt === 1 ? 'native-1' : 'native-2' };
            if (attempt < 3) yield { type: 'error', message: 'API Error: 503 upstream unavailable' };
            else yield { type: 'final_text', text: 'done' };
            yield { type: 'done', normal: attempt === 3 };
          },
        };
      },
    });
    await until(runtime, () => specs.length === 3 && runtime.kernel.state('chat-resume')?.tasks[0]?.status === 'result_ready');
    expect(specs[0]!.resume).toBeUndefined();
    expect(specs[1]!.resume).toEqual({ kind: 'sessionId', id: 'native-1' });
    expect(specs[2]!.resume).toEqual({ kind: 'sessionId', id: 'native-2' });
    expect(specs[0]!.prompt).not.toContain('another attempt at the same task');
    expect(specs[1]!.prompt).toContain('another attempt at the same task');
    expect(runtime.kernel.state('chat-resume')!.sessions[0]!.nativeSessionId).toBe('native-2');
  });

  it('stops a silent worker and retries it, then gives up after the retry budget', async () => {
    const specs: WorkerRunSpec[] = [];
    const runtime = await start('chat-stall', {
      async start(spec) {
        specs.push(spec);
        await spec.validateBeforeRun();
        let finish!: () => void;
        const stopped = new Promise<void>(resolve => { finish = resolve; });
        const aborted = new Promise<void>(resolve => spec.signal.addEventListener('abort', () => { finish(); resolve(); }, { once: true }));
        return {
          runId: `run-${specs.length}`, result: stopped.then(() => 'stopped' as const),
          stop: async () => { finish(); }, waitForExit: async () => true, stopReason: () => 'cancelled',
          async *events() { yield { type: 'session', nativeSessionId: 'native-1' }; await aborted; },
        };
      },
    }, { stallMs: 40 });
    await until(runtime, () => specs.length === 4 && runtime.kernel.state('chat-stall')?.tasks[0]?.status === 'failed');
    const task = runtime.kernel.state('chat-stall')!.tasks[0]!;
    expect(task.attempts).toHaveLength(4);
    expect(task.retryCount).toBe(3);
    expect(task.attempts[0]!.failureKind).toBe('stall');
    expect(task.error).toMatch(/no output for \d+ minutes/);
  });

  it('does not treat a turn with a tool in flight as stalled', async () => {
    let aborted = false;
    const runtime = await start('chat-busy', {
      async start(spec) {
        await spec.validateBeforeRun();
        let finish!: () => void;
        const stopped = new Promise<'stopped'>(resolve => { finish = () => resolve('stopped'); });
        spec.signal.addEventListener('abort', () => { aborted = true; finish(); }, { once: true });
        return {
          runId: 'run-1', result: stopped,
          stop: async () => { finish(); }, waitForExit: async () => true, stopReason: () => undefined,
          async *events() {
            yield { type: 'session', nativeSessionId: 'native-1' };
            yield { type: 'activity', busy: true };
            await new Promise(resolve => setTimeout(resolve, 200));
          },
        };
      },
    }, { stallMs: 40 });
    await until(runtime, () => runtime.kernel.state('chat-busy')?.tasks[0]?.status === 'running');
    await new Promise(resolve => setTimeout(resolve, 150));
    await runtime.tick();
    expect(aborted).toBe(false);
    expect(runtime.kernel.state('chat-busy')!.tasks[0]!.attempts).toHaveLength(1);
  });

  /** A worker whose only output is one activity event, after which it stays silent until it is stopped. */
  const silentAfter = (specs: WorkerRunSpec[], activity: () => { type: 'activity'; busy: boolean; busyUntil?: number }) => ({
    async start(spec: WorkerRunSpec): Promise<WorkerRun> {
      specs.push(spec);
      await spec.validateBeforeRun();
      let finish!: () => void;
      const stopped = new Promise<void>(resolve => { finish = resolve; });
      const aborted = new Promise<void>(resolve => spec.signal.addEventListener('abort', () => { finish(); resolve(); }, { once: true }));
      return {
        runId: `run-${specs.length}`, result: stopped.then(() => 'stopped' as const),
        stop: async () => { finish(); }, waitForExit: async () => true, stopReason: () => 'cancelled',
        async *events() { yield { type: 'session', nativeSessionId: 'native-1' }; yield activity(); await aborted; },
      };
    },
  });

  it('stops and retries a turn whose tool call is still out after the time the host gave for it', async () => {
    const specs: WorkerRunSpec[] = [];
    // The idle limit is far away: only the call's own due time can stop the turn.
    const runtime = await start('chat-overdue', silentAfter(specs, () => ({ type: 'activity', busy: true, busyUntil: Date.now() + 40 })),
      { stallMs: 60_000 });
    await until(runtime, () => specs.length === 4 && runtime.kernel.state('chat-overdue')?.tasks[0]?.status === 'failed');
    const task = runtime.kernel.state('chat-overdue')!.tasks[0]!;
    expect(task.attempts).toHaveLength(4);
    expect(task.attempts[0]!.failureKind).toBe('stall');
    expect(task.error).toMatch(/tool call did not return within its time limit/);
  });

  it('leaves a tool that is not yet due alone, however long the idle limit has passed', async () => {
    const specs: WorkerRunSpec[] = [];
    const runtime = await start('chat-due-later', silentAfter(specs, () => ({ type: 'activity', busy: true, busyUntil: Date.now() + 60_000 })),
      { stallMs: 40, toolStallMs: 40 });
    await until(runtime, () => runtime.kernel.state('chat-due-later')?.tasks[0]?.status === 'running');
    await new Promise(resolve => setTimeout(resolve, 150));
    await runtime.tick();
    expect(specs).toHaveLength(1);
    expect(specs[0]!.signal.aborted).toBe(false);
  });

  it('stops a turn that stays silent past the tool limit when its tool has no due time', async () => {
    const specs: WorkerRunSpec[] = [];
    const runtime = await start('chat-tool-limit', silentAfter(specs, () => ({ type: 'activity', busy: true })),
      { stallMs: 60_000, toolStallMs: 40 });
    await until(runtime, () => specs.length === 4 && runtime.kernel.state('chat-tool-limit')?.tasks[0]?.status === 'failed');
    const task = runtime.kernel.state('chat-tool-limit')!.tasks[0]!;
    expect(task.attempts[0]!.failureKind).toBe('stall');
    expect(task.error).toMatch(/no output for \d+ minutes with a tool call in flight/);
  });

  it('keeps an over-long answer, truncated and marked, instead of failing the task', async () => {
    const runtime = await start('chat-long', {
      async start(spec) {
        await spec.validateBeforeRun();
        return {
          runId: 'run-1', result: Promise.resolve('completed'),
          stop: async () => {}, waitForExit: async () => true, stopReason: () => undefined,
          async *events() {
            yield { type: 'session', nativeSessionId: 'native-1' };
            yield { type: 'final_text', text: 'x'.repeat(100_005) };
            yield { type: 'done', normal: true };
          },
        };
      },
    }, { script: 'const answer = await agent("do the work", {key:"a"}); return answer.length;' });
    await until(runtime, () => runtime.kernel.state('chat-long')?.tasks[0]?.status === 'result_ready');
    const state = runtime.kernel.state('chat-long')!;
    const artifact = state.artifacts.find(item => item.kind === 'agent-result')!;
    expect(artifact.truncated).toBe(true);
    // The cut leaves room for the JSON encoding the script VM counts.
    expect(artifact.text.length).toBeLessThanOrEqual(100_000);
    expect(artifact.text.length).toBeGreaterThan(99_000);
    expect(state.script?.status).toBe('result_ready');
  });

  it('does not retry a read-only permission denial even when error mentions "no output produced"', async () => {
    const specs: WorkerRunSpec[] = [];
    const denialMessage = 'Tool permission denied for run_command: jetski: no output produced — a tool required the "command" permission that headless mode cannot prompt for, so it was auto-denied.';
    const runtime = await start('chat-permission-denial', {
      async start(spec) {
        specs.push(spec);
        await spec.validateBeforeRun();
        return {
          runId: `run-${specs.length}`, result: Promise.resolve('failed'),
          stop: async () => {}, waitForExit: async () => true, stopReason: () => undefined,
          async *events() {
            yield { type: 'session', nativeSessionId: 'native-perm-1' };
            yield { type: 'error', message: denialMessage };
            yield { type: 'done', normal: false };
          },
        };
      },
    }, { script: 'return await agent("run check", {key:"a", readOnly:true});' });
    await until(runtime, () => runtime.kernel.state('chat-permission-denial')?.tasks[0]?.status === 'failed');
    await new Promise(resolve => setTimeout(resolve, 40));
    await runtime.tick();
    expect(specs).toHaveLength(1);
    const task = runtime.kernel.state('chat-permission-denial')!.tasks[0]!;
    expect(task.attempts).toHaveLength(1);
    expect(task.attempts[0]!.failureKind).toBe('permission_denied');
    expect(task.error).toBe(denialMessage);
  });
});
