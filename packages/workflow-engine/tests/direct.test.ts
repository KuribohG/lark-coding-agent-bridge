import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { callWorkflow, WorkflowRuntime, type WorkerRunSpec, type WorkflowRoot } from '../src';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });

/** A worker that stays in its turn until told to finish, and records what the main agent sends into it. */
async function harness(canReceive = true) {
  const root: WorkflowRoot = { scopeId: 'chat', profile: 'embedded', agentKind: 'custom-agent', cwdRealpath: '/repo', policyFingerprint: 'policy', catalogBinding: 'main', modelSettings: {} };
  const workers: Array<{ spec: WorkerRunSpec; received: string[]; finish(text: string): void }> = [];
  const wakeMain = vi.fn(async () => {});
  const runtime = new WorkflowRuntime({ path: ':memory:', resolveRoot: async () => root, wakeMain,
    runner: { async start(spec) {
      await spec.validateBeforeRun();
      let finish!: (text: string) => void;
      const answer = new Promise<string>(resolve => { finish = resolve; });
      const worker = { spec, received: [] as string[], finish };
      workers.push(worker);
      return { runId: randomUUID(), result: answer.then(() => 'completed' as const), stop: async () => finish('stopped'), waitForExit: async () => true, stopReason: () => undefined,
        ...(canReceive ? { send: async (text: string) => { worker.received.push(text); return 'accepted' as const; } } : {}),
        async *events() {
          yield { type: 'session' as const, nativeSessionId: 'native-' + workers.length };
          yield { type: 'final_text' as const, text: await answer };
          yield { type: 'done' as const, normal: true };
        } };
    } } });
  await runtime.start(); cleanup.push(() => runtime.close());
  const main = runtime.bindMain(root.scopeId, 'start'); cleanup.push(async () => main.release());
  const state = () => runtime.kernel.state(root.scopeId)!;
  const call = (method: string, args: Record<string, unknown> = {}) => callWorkflow(method, args, main.env);
  await call('run_script', { operationId: randomUUID(), goal: 'talk', plan: 'One member and one one-off worker run side by side.',
    script: 'return await parallel([() => agent("fix the parser", {key:"turn", member:"fixer"}), () => agent("audit", {key:"audit"})]);' });
  await vi.waitFor(async () => { await runtime.tick(); expect(workers).toHaveLength(2); });
  const worker = (prompt: string) => workers.find(item => item.spec.prompt.includes(prompt))!;
  return { runtime, state, call, wakeMain, fixer: worker('fix the parser'), audit: worker('audit') };
}

describe('the main agent talking to a running worker', () => {
  it('delivers a message into the running turn, takes one reply and wakes the main agent with it', async () => {
    const h = await harness();
    const told = await h.call('tell_worker', { target: 'fixer', text: 'Skip the lexer, it is already fixed. Which file are you in?' }) as { status: string; worker: string; messageId: string };
    expect(told).toMatchObject({ status: 'accepted', worker: 'fixer' });
    expect(h.fixer.received).toHaveLength(1);
    expect(h.fixer.received[0]).toContain('Skip the lexer');
    expect(h.fixer.received[0]).toContain('reply_main');
    expect(h.audit.received).toEqual([]);

    await expect(callWorkflow('reply_main', { text: 'nobody asked' }, h.audit.spec.env)).rejects.toThrow('none is waiting');
    expect(await callWorkflow('reply_main', { text: 'In parser.rs, halfway through.' }, h.fixer.spec.env)).toMatchObject({ messageId: expect.any(String) });
    await expect(callWorkflow('reply_main', { text: 'and another thing' }, h.fixer.spec.env)).rejects.toThrow('none is waiting');

    expect(h.state().events).toMatchObject([{ kind: 'worker_reply', summary: expect.stringContaining('In parser.rs') }]);
    await h.runtime.tick();
    await vi.waitFor(() => expect(h.wakeMain).toHaveBeenCalledWith('chat'));
    expect(await h.call('worker_messages', { target: 'fixer' })).toMatchObject({ total: 2,
      messages: [{ from: 'main', worker: 'fixer', delivery: 'accepted', text: expect.stringContaining('Skip the lexer') }, { from: 'worker', text: 'In parser.rs, halfway through.' }] });

    // A one-off worker is addressed by its script key; the turn goes on and its answer is unaffected.
    expect(await h.call('tell_worker', { target: 'audit', text: 'Also check the lockfile.' })).toMatchObject({ status: 'accepted', worker: 'audit' });
    expect(h.audit.received[0]).toContain('lockfile');
    h.fixer.finish('parser fixed'); h.audit.finish('audited');
    await vi.waitFor(async () => { await h.runtime.tick(); expect(h.state().script?.status).toBe('result_ready'); });
    expect(await h.call('tell_worker', { target: 'fixer', text: 'too late' })).toMatchObject({ status: 'inactive', taskStatus: 'result_ready' });
    expect(await h.call('worker_messages')).toMatchObject({ total: 3 });
  });

  it('reports a harness that cannot take input mid-turn, and unknown targets', async () => {
    const h = await harness(false);
    expect(await h.call('tell_worker', { target: 'fixer', text: 'hello' })).toMatchObject({ status: 'unsupported' });
    await expect(h.call('tell_worker', { target: 'nobody', text: 'hello' })).rejects.toThrow('Unknown worker');
    await expect(h.call('tell_worker', { target: 'fixer', text: ' ' })).rejects.toThrow('empty');
    expect(await h.call('worker_messages')).toMatchObject({ total: 0 });
    h.fixer.finish('x'); h.audit.finish('y');
  });
});
