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

  it('leaves the message on the board for a member whose harness takes no input mid-turn, and reports a one-off worker it cannot reach', async () => {
    const h = await harness(false);
    // The member has a next turn to read a post in; the one-off worker has none.
    const told = await h.call('tell_worker', { target: 'fixer', text: 'hello, and tell @audit' }) as { seq: number };
    expect(told).toMatchObject({ status: 'posted', worker: 'fixer', seq: expect.any(Number) });
    expect(await h.call('read_board')).toMatchObject({ posts: [{ seq: told.seq, from: 'main', to: ['fixer'], text: 'hello, and tell @audit' }] });
    expect(await h.call('tell_worker', { target: 'audit', text: 'hello' })).toMatchObject({ status: 'unsupported', worker: 'audit' });
    await expect(h.call('tell_worker', { target: 'nobody', text: 'hello' })).rejects.toThrow('Unknown worker');
    await expect(h.call('tell_worker', { target: 'fixer', text: ' ' })).rejects.toThrow('empty');
    expect(await h.call('worker_messages')).toMatchObject({ total: 0 });
    h.fixer.finish('x'); h.audit.finish('y');
  });
});

describe('a lead talking to the members it leads', () => {
  /** A swarm whose members stay in their turns until the test ends them, and record what is put into them. */
  async function swarm(cannotReceive: string[] = []) {
    const root: WorkflowRoot = { scopeId: 'chat', profile: 'embedded', agentKind: 'custom-agent', cwdRealpath: '/repo', policyFingerprint: 'policy', catalogBinding: 'main', modelSettings: {} };
    const turns: Array<{ name: string; spec: WorkerRunSpec; received: string[]; finish(): void }> = [];
    const runtime = new WorkflowRuntime({ path: ':memory:', resolveRoot: async () => root, wakeMain: async () => {},
      runner: { async start(spec) {
        await spec.validateBeforeRun();
        const name = spec.resume?.id ?? /You are member "([^"]+)"/.exec(spec.prompt)![1]!;
        let finish!: () => void;
        const done = new Promise<void>(resolve => { finish = resolve; });
        const turn = { name, spec, received: [] as string[], finish };
        turns.push(turn);
        return { runId: randomUUID(), result: done.then(() => 'completed' as const), stop: async () => finish(), waitForExit: async () => true, stopReason: () => undefined,
          ...(cannotReceive.includes(name) ? {} : { send: async (text: string) => { turn.received.push(text); return 'accepted' as const; } }),
          async *events() {
            yield { type: 'session' as const, nativeSessionId: name };
            await done;
            yield { type: 'final_text' as const, text: name + ' is done' };
            yield { type: 'done' as const, normal: true };
          } };
      } } });
    await runtime.start(); cleanup.push(() => runtime.close());
    const main = runtime.bindMain(root.scopeId, 'start'); cleanup.push(async () => main.release());
    await callWorkflow('run_script', { operationId: randomUUID(), goal: 'ship the parser', plan: 'A lead, the lead of one queue and three members.', maxConcurrent: 8, script: [
      'await enqueueWork({key:"q1", title:"Q1", input:1, queue:"q"});',
      'await enqueueWork({key:"p1", title:"P1", input:1, queue:"p"});',
      'return await swarm("Build", {key:"tree", lead:{name:"lead"}, maxTurns:4, members:[{name:"ql", leads:"q"},{name:"w1", queue:"q"},{name:"o1", queue:"p"},{name:"idle"}]});',
    ].join('\n') }, main.env);
    /** The turns of a member, the latest last. */
    const of = (name: string) => turns.filter(turn => turn.name === name);
    const state = () => runtime.kernel.state(root.scopeId)!;
    await vi.waitFor(async () => { await runtime.tick(); expect(new Set(turns.map(turn => turn.name))).toEqual(new Set(['lead', 'ql', 'w1', 'o1', 'idle'])); });
    return { runtime, state, of, cleanupTurns: () => { for (const turn of turns) turn.finish(); },
      main: (method: string, args: Record<string, unknown> = {}) => callWorkflow(method, args, main.env),
      as: (name: string, method: string, args: Record<string, unknown>) => callWorkflow(method, { operationId: randomUUID(), ...args }, of(name).at(-1)!.spec.env),
      /** Ends the member's running turn and waits until the engine has taken its result. */
      end: async (name: string) => {
        const turn = of(name).at(-1)!;
        turn.finish();
        await vi.waitFor(async () => { await runtime.tick(); expect(state().tasks.find(task => task.taskId === state().agents!.find(agent => agent.key === name)!.lastTurnId)?.status).toBe('result_ready'); });
      } };
  }

  it('puts its words into a running turn, as the swarm lead for any member and as the lead of a queue for that queue\'s members', async () => {
    const h = await swarm();
    const told = await h.as('lead', 'tell_worker', { operationId: 'redirect', target: 'w1', text: 'Stop: the parser moved to src/v2. Tell @o1 nothing.' }) as { messageId: string };
    expect(told).toMatchObject({ status: 'accepted', member: 'w1', messageId: expect.any(String) });
    const w1 = h.of('w1')[0]!;
    expect(w1.received).toHaveLength(1);
    expect(w1.received[0]).toMatch(/^\[Message from lead lead /);
    expect(w1.received[0]).toContain('the parser moved to src/v2');
    expect(w1.received[0]).toContain('lead, the lead of your swarm, sent this');
    expect(w1.received[0]).toContain('name lead in a post with post_board');
    // A repeated call answers as the first one did, without speaking twice.
    expect(await h.as('lead', 'tell_worker', { operationId: 'redirect', target: 'w1', text: 'Stop: the parser moved to src/v2. Tell @o1 nothing.' })).toEqual(told);
    await expect(h.as('lead', 'tell_worker', { operationId: 'redirect', target: 'w1', text: 'something else' })).rejects.toThrow('conflict');
    expect(w1.received).toHaveLength(1);

    expect(await h.as('ql', 'tell_worker', { target: '@w1', text: 'Q1 also covers the lexer.' })).toMatchObject({ status: 'accepted', member: 'w1' });
    expect(w1.received[1]).toContain('ql, the lead of your queue, sent this');
    await expect(h.as('ql', 'tell_worker', { target: 'o1', text: 'x' })).rejects.toThrow('does not consume a queue you lead');
    await expect(h.as('ql', 'tell_worker', { target: 'lead', text: 'x' })).rejects.toThrow('does not consume a queue you lead');
    await expect(h.as('w1', 'tell_worker', { target: 'o1', text: 'x' })).rejects.toThrow('for the lead of a running swarm and the leads of its queues');
    await expect(h.as('lead', 'tell_worker', { target: 'lead', text: 'x' })).rejects.toThrow('another member');
    await expect(h.as('lead', 'tell_worker', { target: 'nobody', text: 'x' })).rejects.toThrow('Unknown member');
    await expect(h.as('lead', 'tell_worker', { target: 'w1', text: ' ' })).rejects.toThrow('empty');
    expect(h.of('o1')[0]!.received).toEqual([]);
    expect(h.state().board?.posts.filter(post => !post.author) ?? []).toEqual([]);

    // The main agent reads what the leads said; a member answers a lead on the board, not with reply_main.
    expect(await h.main('worker_messages')).toMatchObject({ total: 2, messages: [
      { from: 'lead', by: 'lead', worker: 'w1', delivery: 'accepted', text: expect.stringContaining('src/v2') }, { from: 'lead', by: 'ql', worker: 'w1' }] });
    await expect(h.as('w1', 'reply_main', { text: 'understood' })).rejects.toThrow('none is waiting');
    h.cleanupTurns();
  });

  it('leaves its words on the board for a member that is not in a turn or cannot take them, which wakes the member', async () => {
    const h = await swarm(['o1']);
    await h.end('idle');
    const posted = await h.as('lead', 'tell_worker', { target: 'idle', text: 'Review what w1 lands, and ignore @o1.' }) as { seq: number };
    expect(posted).toMatchObject({ status: 'posted', member: 'idle', seq: expect.any(Number) });
    const names = (ids: readonly string[]) => ids.map(id => h.state().agents!.find(agent => agent.agentId === id)!.key);
    const post = h.state().board!.posts.find(item => item.seq === posted.seq)!;
    // The words were for one member: the @name in them names nobody else.
    expect([names([post.from!]), names(post.to), post.text]).toEqual([['lead'], ['idle'], 'Review what w1 lands, and ignore @o1.']);
    await vi.waitFor(async () => { await h.runtime.tick(); expect(h.of('idle')).toHaveLength(2); });
    expect(h.of('idle')[0]!.received).toEqual([]);

    // A member in a turn whose harness takes no input mid-turn reads the post at its next turn.
    expect(await h.as('lead', 'tell_worker', { target: 'o1', text: 'P1 is cancelled.' })).toMatchObject({ status: 'posted', member: 'o1' });
    expect(await h.main('worker_messages')).toMatchObject({ total: 0 });

    // So does the main agent's message; a member that was retired has no turn to come, and the sender is told.
    await h.end('idle');
    expect(await h.main('tell_worker', { target: 'idle', text: 'Also check the lockfile.' })).toMatchObject({ status: 'posted', worker: 'idle' });
    await vi.waitFor(async () => { await h.runtime.tick(); expect(h.of('idle')).toHaveLength(3); });
    await h.as('lead', 'staff_swarm', { retire: ['idle'] });
    await h.end('idle');
    expect(await h.as('lead', 'tell_worker', { target: 'idle', text: 'One more thing.' })).toMatchObject({ status: 'inactive', member: 'idle' });
    expect(await h.main('tell_worker', { target: 'idle', text: 'One more thing.' })).toMatchObject({ status: 'inactive', worker: 'idle' });
    h.cleanupTurns();
  });
});
