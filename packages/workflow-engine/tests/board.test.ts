import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { callWorkflow, WorkflowRuntime, type WorkerRunSpec } from '../src';
import { WorkflowKernel } from '../src/engine/kernel';
import type { WorkflowRoot, WorkflowWorkerRequest, WorkflowWorkerResult } from '../src/engine/types';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

function harness() {
  const root: WorkflowRoot = { scopeId: 'board', profile: 'default', agentKind: 'codex', cwdRealpath: '/workspace',
    policyFingerprint: 'policy', catalogBinding: 'root', modelSettings: {} };
  const requests: WorkflowWorkerRequest[] = [];
  const finishers = new Map<string, (result: WorkflowWorkerResult) => void>();
  const host = { resolveRoot: async () => root, wakeMain: async () => {}, execute: async (request: WorkflowWorkerRequest) => {
    requests.push(request); request.onRun('run-' + request.attemptId);
    request.onSession(request.session.nativeSessionId ?? 'native-' + request.session.actorId);
    return new Promise<WorkflowWorkerResult>(resolve => {
      finishers.set(request.attemptId, resolve);
      request.signal.addEventListener('abort', () => resolve({ status: 'stopped' }), { once: true });
    });
  } };
  const kernel = new WorkflowKernel(':memory:', host, () => 1_000_000);
  cleanup.push(async () => { for (const finish of finishers.values()) finish({ status: 'stopped' }); await kernel.close(); });
  const state = () => kernel.state(root.scopeId)!;
  const call = (method: string, args: Record<string, unknown> = {}) => kernel.call({ kind: 'main', scopeId: root.scopeId, allowStart: true }, method,
    { operationId: randomUUID(), workflowId: state()?.workflowId, expectedStateVersion: state()?.stateVersion, ...args });
  const worker = (request: WorkflowWorkerRequest, method: string, args: Record<string, unknown> = {}) => kernel.call(
    { kind: 'worker', scopeId: root.scopeId, workflowId: state().workflowId, taskId: request.task.taskId, attemptId: request.attemptId }, method, args);
  const run = async () => { const count = requests.length; await kernel.tick(); await vi.waitFor(() => expect(requests).toHaveLength(count + 1)); return requests.at(-1)!; };
  const finish = async (request: WorkflowWorkerRequest, result: WorkflowWorkerResult = { status: 'completed', text: 'ready' }) => {
    finishers.get(request.attemptId)!(result);
    await vi.waitFor(() => expect(['starting', 'running', 'cancelling']).not.toContain(state().tasks.find(task => task.taskId === request.task.taskId)!.status));
  };
  const agent = (member: string, key: string) => kernel.scriptAgent(root.scopeId, state().workflowId, state().script!.runId, { member, key, prompt: 'Authorized member work' });
  const mail = (args: Record<string, unknown>) => kernel.scriptMailbox(root.scopeId, state().workflowId, state().script!.runId, args);
  const wait = (key: string, any: unknown[]) => kernel.scriptControl(root.scopeId, state().workflowId, state().script!.runId, { kind: 'wait', key, any });
  const result = (pending: { kind: string; taskId?: string; waitId?: string }) => kernel.scriptControlResult(root.scopeId, state().workflowId, state().script!.runId, pending);
  return { kernel, state, call, worker, run, finish, agent, mail, wait, result, requests,
    start: async () => { await call('run_script', { goal: 'Coordinate authorized work', plan: 'Members coordinate on the board', script: 'return null;' }); kernel.beginScript(root.scopeId, state().workflowId); },
    bootstrap: async (name: string) => { await agent(name, name + '-init'); await finish(await run()); },
  };
}

describe('workflow message board', () => {
  it('keeps one ordered feed, delivers posts to the members they name and leaves the rest unwoken', async () => {
    const h = harness(); await h.start(); await h.bootstrap('lead'); await h.bootstrap('dev'); await h.bootstrap('qa');
    expect(await h.call('post_board', { text: 'Kickoff: no one needs to act yet' })).toMatchObject({ seq: 1, to: [] });
    expect(await h.call('post_board', { text: '@dev implement the parser; mail a@qa.example is not a mention', to: ['lead'] })).toMatchObject({ seq: 2, to: ['lead', 'dev'] });
    expect((await h.mail({ kind: 'post', key: 'announce', text: 'Freeze at noon', to: 'all' })).result).toMatchObject({ seq: 3, to: ['lead', 'dev', 'qa'] });
    await expect(h.call('post_board', { text: 'hello', to: ['ghost'] })).rejects.toThrow('Unknown member');
    await expect(h.call('post_board', { text: '   ' })).rejects.toThrow('empty');

    // As with direct messages, a receive hands the batch to the member's next turn.
    await h.mail({ kind: 'receive', member: 'dev', key: 'dev-inbox' });
    await h.agent('dev', 'dev-work'); const turn = await h.run();
    const context = await h.worker(turn, 'read_context') as { member: { messages: Array<Record<string, unknown>> } };
    expect(context.member.messages).toMatchObject([
      { from: 'main', post: 2, to: ['lead', 'dev'], topic: 'board', text: expect.stringContaining('implement the parser') },
      { from: 'script', post: 3, all: true, text: 'Freeze at noon' }]);
    const posted = await h.worker(turn, 'post_board', { operationId: 'done', text: 'Parser done, @qa please verify' });
    expect(posted).toMatchObject({ seq: 4, to: ['qa'] });
    // A retried tool call repeats the recorded answer instead of posting twice; the sender is never its own recipient.
    expect(await h.worker(turn, 'post_board', { operationId: 'done', text: 'Parser done, @qa please verify' })).toEqual(posted);
    expect(await h.worker(turn, 'post_board', { operationId: 'self', text: 'note to @dev and @all' })).toMatchObject({ seq: 5, to: ['lead', 'qa'] });
    await h.finish(turn);

    const feed = await h.call('read_board', { after: 1, limit: 2 }) as { posts: Array<Record<string, unknown>>; lastSeq: number; hasMore: boolean };
    expect(feed).toMatchObject({ lastSeq: 5, hasMore: true, posts: [{ seq: 2, from: 'main' }, { seq: 3, from: 'script', all: true }] });
    expect(await h.call('read_board', { member: 'qa', limit: 50 })).toMatchObject({ posts: [{ seq: 3 }, { seq: 4, from: 'dev', to: ['qa'] }, { seq: 5 }] });
    // Deliveries do not copy the text and do not spend the direct-message budget.
    const box = h.state().mailbox!;
    expect(box.messages).toHaveLength(8);
    expect(box.messages.every(message => message.text === '' && message.post !== undefined)).toBe(true);
    expect(box.messages.filter(message => message.consumedByTurnId).map(message => message.post)).toEqual([2, 3]);
  });

  it('lets one-off workers read but not post, and replays a script read against the recorded feed position', async () => {
    const h = harness(); await h.start(); await h.bootstrap('dev');
    await h.call('post_board', { text: 'first' });
    await h.kernel.scriptAgent('board', h.state().workflowId, h.state().script!.runId, { key: 'oneoff', prompt: 'look around' });
    const oneoff = await h.run();
    expect(await h.worker(oneoff, 'read_board')).toMatchObject({ posts: [{ seq: 1, text: 'first' }] });
    await expect(h.worker(oneoff, 'post_board', { operationId: 'x', text: 'hi' })).rejects.toThrow('persistent member');
    await h.finish(oneoff);
    expect((await h.mail({ kind: 'board', key: 'snapshot' })).result).toMatchObject({ lastSeq: 1, posts: [{ seq: 1 }] });
    await h.call('post_board', { text: 'second' });
    await h.call('pause'); await h.call('replay_script'); h.kernel.beginScript('board', h.state().workflowId);
    expect((await h.mail({ kind: 'board', key: 'snapshot' })).result).toMatchObject({ lastSeq: 1, posts: [{ seq: 1 }] });
    expect((await h.mail({ kind: 'board', key: 'later' })).result).toMatchObject({ lastSeq: 2 });
    await expect(h.mail({ kind: 'post', key: 'bad', text: 'x', member: 'dev' })).rejects.toThrow('Unsupported mailbox option');
  });

  it('wakes a waiting member on a post and reports quiet only when every member is parked with nothing to read', async () => {
    const h = harness(); await h.start(); await h.bootstrap('dev'); await h.bootstrap('qa');
    const quiet = { kind: 'quiet', members: ['dev', 'qa'] };
    await expect(h.wait('bad', [{ kind: 'quiet', members: ['dev', 'dev'] }])).rejects.toThrow('unique');
    await expect(h.wait('bad', [{ kind: 'quiet', members: ['ghost'] }])).rejects.toThrow('Unknown member');
    await h.call('post_board', { text: '@qa review the plan' });
    const dev = await h.wait('dev/1', [{ kind: 'message', member: 'dev' }, quiet]);
    // qa is not waiting yet, so dev cannot conclude that the team is done.
    expect(h.result(dev)).toBeUndefined();
    const qa = await h.wait('qa/1', [{ kind: 'message', member: 'qa' }, quiet]);
    expect(h.result(qa)).toMatchObject({ index: 0, kind: 'message', value: [{ from: 'main', post: 1, text: '@qa review the plan' }] });
    expect(h.result(dev)).toBeUndefined();
    await h.agent('qa', 'qa/turn1'); const turn = await h.run();
    await h.worker(turn, 'post_board', { operationId: 'ask', text: 'Plan is fine', to: ['dev'] });
    expect(h.result(dev)).toMatchObject({ kind: 'message', value: [{ from: 'qa', text: 'Plan is fine' }] });
    await h.finish(turn);
    await h.agent('dev', 'dev/turn1'); await h.finish(await h.run());
    const devAgain = await h.wait('dev/2', [{ kind: 'message', member: 'dev' }, quiet]);
    expect(h.result(devAgain)).toBeUndefined();
    const qaAgain = await h.wait('qa/2', [{ kind: 'message', member: 'qa' }, quiet]);
    // The last member to fall asleep settles every wait watching the group in the same commit.
    expect(h.result(qaAgain)).toEqual({ index: 1, kind: 'quiet', value: { members: ['dev', 'qa'] } });
    expect(h.result(devAgain)).toEqual({ index: 1, kind: 'quiet', value: { members: ['dev', 'qa'] } });
  });

  it('does not wait for a member whose turn failed', async () => {
    const h = harness(); await h.start(); await h.bootstrap('dev'); await h.bootstrap('qa');
    await h.agent('qa', 'qa/turn1'); const turn = await h.run();
    const dev = await h.wait('dev/1', [{ kind: 'message', member: 'dev' }, { kind: 'quiet', members: ['dev', 'qa'] }]);
    expect(h.result(dev)).toBeUndefined();
    await h.finish(turn, { status: 'failed', error: 'model refused' });
    await h.kernel.tick();
    expect(h.state().tasks.find(task => task.taskId === turn.task.taskId)!.status).toBe('failed');
    expect(h.result(dev)).toMatchObject({ kind: 'quiet' });
  });
});

describe('swarm', () => {
  type Action = { post?: { text: string; to?: string[] }; call?: [string, Record<string, unknown>]; calls?: Array<[string, Record<string, unknown>]>; fail?: boolean; work?: boolean; hold?: Promise<void> };
  /** Runs a script whose members act out `plan`: what each does on its nth turn (opening turn first). */
  async function play(script: string, plan: Record<string, Action[]>) {
    const root: WorkflowRoot = { scopeId: 'chat', profile: 'embedded', agentKind: 'custom-agent', cwdRealpath: '/repo',
      policyFingerprint: 'policy', catalogBinding: 'main', modelSettings: { model: 'm1' } };
    const order: string[] = [];
    const specs: WorkerRunSpec[] = [];
    const errors: string[] = [];
    const results: unknown[] = [];
    const seen: Record<string, number> = {};
    const runtime = new WorkflowRuntime({
      path: ':memory:', resolveRoot: async () => root, wakeMain: async () => {},
      runner: {
        async start(spec) {
          specs.push(spec);
          await spec.validateBeforeRun();
          const name = spec.resume?.id ?? /You are member "([^"]+)"/.exec(spec.prompt)![1]!;
          const turn = seen[name] = (seen[name] ?? 0) + 1;
          order.push(name + turn);
          const action = plan[name]?.[turn - 1] ?? {};
          return {
            runId: `run-${specs.length}`, result: Promise.resolve(action.fail ? 'failed' : 'completed'),
            stop: async () => {}, waitForExit: async () => true, stopReason: () => undefined,
            async *events() {
              yield { type: 'session', nativeSessionId: name };
              try {
                for (let n = 0; action.work; n++) {
                  const grant = await callWorkflow('claim_work', { operationId: 'claim' + n }, spec.env) as { claimId: string; generation: number } | null;
                  if (!grant) break;
                  await callWorkflow('complete_work', { operationId: 'done' + n, claimId: grant.claimId, generation: grant.generation, result: name }, spec.env);
                }
                if (action.call) await callWorkflow(action.call[0], { operationId: 'call', ...action.call[1] }, spec.env);
                for (const [index, [method, input]] of (action.calls ?? []).entries()) {
                  try { results.push(await callWorkflow(method, { operationId: 'calls' + index, ...input }, spec.env)); } catch (error) { errors.push(String(error)); }
                }
                if (action.post) await callWorkflow('post_board', { operationId: 'post', ...action.post }, spec.env);
                // Keeps the turn running until the test lets it end.
                if (action.hold) await action.hold;
              } catch (error) { errors.push(String(error)); }
              if (action.fail) { yield { type: 'error', message: 'model refused' }; yield { type: 'done', normal: false }; return; }
              yield { type: 'final_text', text: `${name} turn ${turn}` };
              yield { type: 'done', normal: true };
            },
          };
        },
      },
    });
    await runtime.start(); cleanup.push(() => runtime.close());
    const main = runtime.bindMain(root.scopeId, 'start');
    await callWorkflow('run_script', { operationId: randomUUID(), goal: 'ship the parser', plan: 'A swarm coordinates on the board.', maxAgents: 40, script }, main.env);
    main.release();
    const settled = async () => {
      await vi.waitFor(async () => { await runtime.tick(); expect(runtime.kernel.state(root.scopeId)?.script?.status).not.toMatch(/running|queued/); }, { timeout: 10_000 });
      const state = runtime.kernel.state(root.scopeId)!;
      const ref = state.script?.resultRef;
      return { state, result: ref ? JSON.parse(state.artifacts.find(artifact => artifact.ref === ref)!.text) : undefined };
    };
    return { runtime, root, order, specs, errors, results, settled };
  }
  const posts = (result: { posts: Array<{ from: string; to: string[] }> }) => result.posts.map(post => [post.from, post.to]);

  it('wakes members as posts name them and ends when a swarm without a lead goes quiet', async () => {
    const h = await play('return await swarm("Ship the parser", {key:"ship", maxTurns: 4, members:[{name:"dev", role:"Implement"},{name:"qa", role:"Verify; wait until asked"}]});', {
      dev: [{ post: { text: 'Parser implemented', to: ['qa'] } }, { post: { text: 'Fixed the empty-input case, @qa' } }],
      qa: [{}, { post: { text: 'Empty input crashes', to: ['dev'] } }, {}],
    });
    const { state, result } = await h.settled();
    expect(state.script).toMatchObject({ status: 'result_ready' });
    expect(result).toMatchObject({ stop: 'quiet', turns: 5, hasMore: false, members: [
      { name: 'dev', turns: 1, status: 'idle', note: 'dev turn 2' }, { name: 'qa', turns: 2, status: 'idle', note: 'qa turn 3' }] });
    expect(result).not.toHaveProperty('result');
    expect(posts(result)).toEqual([['script', []], ['dev', ['qa']], ['qa', ['dev']], ['dev', ['qa']]]);
    expect(h.order.slice(2)).toEqual(['qa2', 'dev2', 'qa3']);
    expect(h.specs[0]!.prompt).toContain('post_board');
    // No script-side waits: the kernel schedules every turn.
    expect(state.waits ?? []).toHaveLength(0);

    // Replaying the finished script rejoins the swarm from the journal: no member runs again and nothing is posted twice.
    const again = h.runtime.bindMain(h.root.scopeId, 'continue');
    await callWorkflow('replay_script', { operationId: randomUUID(), workflowId: state.workflowId, expectedStateVersion: state.stateVersion }, again.env);
    again.release();
    const replayed = await h.settled();
    expect(replayed.state.script).toMatchObject({ status: 'result_ready', revision: 1 });
    expect(replayed.result).toEqual(result);
    expect(h.specs).toHaveLength(5);
    expect(replayed.state.board!.posts).toHaveLength(4);
  });

  it('lets the lead add and retire members, tells it about failures and idleness, and ends on its verdict', async () => {
    const h = await play('return await swarm("Fix three modules", {key:"fix", maxTurns: 6, lead:{name:"lead", role:"Assign and judge"}, members:[{name:"parser", harness:"custom-agent", model:"m2"},{name:"docs"}]});', {
      lead: [
        { post: { text: '@parser fix the parser. @docs update the docs.' } },
        // parser reported a fourth module: add a member for it, then brief it on the board.
        { call: ['staff_swarm', { add: ['lexer'], role: 'Own src/lexer/**', brief: 'Same empty-input bug as the parser', like: 'parser' }], post: { text: '@lexer go ahead; report to me' } },
        { call: ['staff_swarm', { retire: ['docs'] }] },  // woken by the system post about the docs failure
        { call: ['swarm_finish', { result: 'parser and lexer fixed; docs dropped' }], post: { text: '@parser thanks, we are done' } },
      ],
      parser: [{}, { post: { text: '@lead the lexer has the same bug' } }],
      docs: [{}, { fail: true }],
      lexer: [{}, { post: { text: 'Lexer fixed', to: ['lead'] } }],
    });
    const { state, result } = await h.settled();
    expect(h.errors).toEqual([]);
    expect(state.script).toMatchObject({ status: 'result_ready' });
    expect(result).toMatchObject({ stop: 'finished', result: 'parser and lexer fixed; docs dropped', members: [
      { name: 'lead', lead: true }, { name: 'parser' }, { name: 'docs', status: 'failed', error: 'model refused' }, { name: 'lexer', added: true, turns: 1 }] });
    const feed = result.posts as Array<{ from: string; to: string[]; text: string }>;
    expect(feed.find(post => post.from === 'system')).toMatchObject({ to: ['lead'], text: expect.stringContaining('Member "docs" failed') });
    // The verdict stops all waking: the post that names parser after swarm_finish starts no turn.
    expect(h.order.filter(name => name.startsWith('parser'))).toEqual(['parser1', 'parser2']);
    expect(h.specs.find(spec => /You are member "lexer"/.test(spec.prompt))).toMatchObject({
      prompt: expect.stringContaining('Same empty-input bug as the parser'), execution: { modelSettings: { model: 'm2' } } });
    expect(h.specs[0]!.prompt).toContain('swarm_finish');
  });

  it('reminds an idle lead, then reports a stall to the main agent and keeps waiting; only the lead may manage', async () => {
    const h = await play('return await swarm("Idle", {key:"idle", lead:{name:"lead"}, members:[{name:"dev"}]});', {
      // The lead answers the first reminder by handing out work, which earns it a fresh pair of reminders afterwards.
      lead: [{}, { post: { text: 'check the parser', to: ['dev'] } }],
      dev: [{ call: ['swarm_finish', { result: 'not mine to call' }] }],
    });
    const state = () => h.runtime.kernel.state(h.root.scopeId)!;
    await vi.waitFor(async () => { await h.runtime.tick(); expect(state().swarms![0]!.stalled).toBe(true); }, { timeout: 10_000 });
    for (let pass = 0; pass < 3; pass++) await h.runtime.tick();
    expect(h.errors).toEqual([expect.stringContaining('Only the lead of a swarm can manage it')]);
    expect(h.order).toEqual(['lead1', 'dev1', 'lead2', 'dev2', 'lead3', 'lead4']);
    expect(state().script!.status).toBe('running');
    expect(state().swarms![0]).toMatchObject({ status: 'running', nudges: 2 });
    expect(state().board!.posts.filter(post => post.author === 'system')).toHaveLength(3);
    // One event for the stall, however often the idle swarm is looked at again.
    expect(state().events.filter(event => event.kind === 'swarm_stalled')).toMatchObject([{ summary: expect.stringContaining('swarm "idle" 停滞') }]);
  });

  it('does not bound the lead by maxTurns, and gathers the posts that name it while other members work', async () => {
    // Read through a spy installed before the runtime exists, so the test can move the kernel's clock.
    let ahead = 0;
    const real = Date.now.bind(Date);
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => real() + ahead);
    cleanup.push(async () => clock.mockRestore());
    let release!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    const h = await play('return await swarm("Coordinate", {key:"long", maxTurns: 1, lead:{name:"lead"}, members:[{name:"dev"},{name:"slow"}]});', {
      lead: [{}, { post: { text: 'answer one', to: ['dev'] } }, {}, { call: ['swarm_finish', { result: 'done' }] }],
      dev: [{ post: { text: 'question one', to: ['lead'] } }, { post: { text: 'question two', to: ['lead'] } }],
      slow: [{ hold }],
    });
    const state = () => h.runtime.kernel.state(h.root.scopeId)!;
    const leadTurns = () => h.order.filter(name => name.startsWith('lead'));
    const ticks = async (count: number) => { for (let pass = 0; pass < count; pass++) { await h.runtime.tick(); await new Promise(resolve => setTimeout(resolve, 5)); } };
    await vi.waitFor(async () => { await h.runtime.tick(); expect(h.order).toContain('dev1'); expect(state().board!.posts.some(post => post.text === 'question one')).toBe(true); }, { timeout: 10_000 });
    // slow is still working, so the post waits for the lead's gap (three members: 90 seconds) instead of waking it at once.
    await ticks(5);
    expect(leadTurns()).toEqual(['lead1']);
    expect(state().swarms![0]).toMatchObject({ status: 'running', nudges: 0 });
    expect(state().swarms![0]!.stalled).toBeUndefined();
    ahead += 91_000;
    await vi.waitFor(async () => { await h.runtime.tick(); expect(h.order).toContain('dev2'); expect(state().board!.posts.some(post => post.text === 'question two')).toBe(true); }, { timeout: 10_000 });
    // dev has used its one wake-up; its second question is gathered again while slow works.
    await ticks(5);
    expect(leadTurns()).toEqual(['lead1', 'lead2']);
    // With nobody else working the lead is woken at once, beyond maxTurns, and it ends the swarm.
    release();
    const { result } = await h.settled();
    expect(h.errors).toEqual([]);
    expect(leadTurns()).toEqual(['lead1', 'lead2', 'lead3', 'lead4']);
    expect(result).toMatchObject({ stop: 'finished', result: 'done', members: [{ name: 'lead', turns: 3, status: 'idle' }, { name: 'dev', turns: 1, status: 'max_turns' }, { name: 'slow', turns: 0 }] });
    expect(h.specs.find(spec => /You are member "lead"/.test(spec.prompt))!.prompt).toContain('Your wake-ups are not limited');
    expect(h.specs.find(spec => /You are member "dev"/.test(spec.prompt))!.prompt).toContain('woken at most 1 times');
  });

  it('lets members add the work they find, once per key, and ends only on the lead\'s verdict', async () => {
    const found = { key: 'bug-lexer-empty', title: 'Lexer drops the last token', input: { repro: 'lex("")' } };
    const h = await play('await enqueueWork({key:"seed", title:"Seed", input:{}});'
      + 'return await swarm("Fix what you find", {key:"hunt", lead:{name:"lead"}, members:[{name:"builder", queue:"default"}, {name:"scout"}]});', {
      scout: [{ calls: [['enqueue_work', found], ['enqueue_work', { ...found, title: 'Same bug, reported again' }], ['enqueue_work', { ...found, key: 'elsewhere', queue: 'nobody' }]] }],
      builder: [{ work: true }, { work: true }],
      lead: [{}, { call: ['swarm_finish', { result: 'seed and the lexer bug are fixed' }] }],
    });
    const { state, result } = await h.settled();
    expect(h.errors).toEqual([expect.stringContaining('Unknown work queue')]);
    expect(h.results).toMatchObject([{ key: found.key }, { key: found.key, existing: true }]);
    expect(state.workQueue!.items.map(item => [item.key, item.by, item.status])).toEqual([['seed', undefined, 'completed'], [found.key, 'scout', 'completed']]);
    expect(result).toMatchObject({ stop: 'finished', result: 'seed and the lexer bug are fixed', queues: { default: { completed: 2, closed: false } } });
  });

  it('fails when the lead fails, and keeps swarm members away from script calls', async () => {
    const failed = await play('return await swarm("Doomed", {key:"doomed", onError:"throw", lead:{name:"lead"}, members:[{name:"dev"}]});', { lead: [{ fail: true }] });
    expect((await failed.settled()).state.script).toMatchObject({ status: 'failed', error: expect.stringContaining('The lead failed') });
    const soft = await play('const a = await swarm("Doomed", {key:"doomed", lead:{name:"lead"}, members:[{name:"dev"}]}); return {a, b: await agent("x", {key:"k", member:"dev"})};', { lead: [{ fail: true }] });
    expect((await soft.settled()).state.script).toMatchObject({ status: 'failed', error: expect.stringContaining('scheduled by their swarm') });
  });

  it('mixes queue consumers with members that only answer posts', async () => {
    const h = await play([
      'await enqueueWork({key:"a",title:"A",input:1}); await enqueueWork({key:"b",title:"B",input:2});',
      'const out = swarm("Build and verify", {key:"mix", members:[{name:"builder", queue:"default"},{name:"idle", queue:"default"},{name:"qa", role:"Verify when asked"}]});',
      'await enqueueWork({key:"c",title:"C",input:3}); await closeWorkQueue({key:"closed"});',
      'return await out;',
    ].join('\n'), {
      builder: [{ work: true, post: { text: 'Items built, @qa please verify' } }, { work: true }],
      idle: [{ work: true }],
      qa: [{}, { post: { text: 'Verified' } }],
    });
    const { state, result } = await h.settled();
    expect(h.errors).toEqual([]);
    expect(state.script).toMatchObject({ status: 'result_ready' });
    expect(result).toMatchObject({ stop: 'quiet', queues: { default: { completed: 3, closed: true } },
      members: [{ name: 'builder', queue: 'default' }, { name: 'idle', queue: 'default' }, { name: 'qa', turns: 1 }] });
    expect(state.workQueue!.items.every(item => item.status === 'completed')).toBe(true);
    // qa answers posts only: it took its opening turn and one wake-up, and never touched the queue.
    expect(h.order.filter(name => name.startsWith('qa'))).toEqual(['qa1', 'qa2']);
    expect(h.specs.find(spec => /You are member "builder"/.test(spec.prompt))!.prompt).toContain('claim_work');
    expect(h.specs.find(spec => /You are member "qa"/.test(spec.prompt))!.prompt).not.toContain('claim_work');
  });

  it('rejects malformed swarms before starting any member', async () => {
    const run = async (options: unknown) => {
      const h = await play('return await swarm("task",' + JSON.stringify({ onError: 'throw', ...(options as object) }) + ');', {});
      const { state } = await h.settled();
      expect(h.specs).toHaveLength(0);
      return state.script!.error;
    };
    expect(await run({ key: 't', members: [] })).toContain('needs members');
    expect(await run({ key: 't', members: [{ name: 'a' }, { name: 'all' }] })).toContain('cannot be all');
    expect(await run({ key: 't', members: [{ name: 'a' }, { name: 'a' }] })).toContain('unique');
    expect(await run({ key: 't', members: [{ name: 'a', queue: 'parent' }, { name: 'b' }] })).toContain('Invalid work queue name');
  });
});

describe('append-only main operations', () => {
  it('land without the workflow state version while other changes still require it', async () => {
    const h = harness();
    await h.start();
    await h.bootstrap('alice');
    const main = (method: string, args: Record<string, unknown>) => h.kernel.call({ kind: 'main', scopeId: 'board' }, method,
      { operationId: randomUUID(), workflowId: h.state().workflowId, ...args });
    const stale = h.state().stateVersion - 1;

    const posted = await main('post_board', { text: 'note for everyone' }) as { seq: number; stateVersion: number };
    expect(posted.stateVersion).toBe(h.state().stateVersion);
    await expect(main('post_board', { text: 'sent with an old version', expectedStateVersion: stale })).resolves.toMatchObject({ seq: posted.seq + 1 });
    await expect(main('send_message', { member: 'alice', text: 'please look' })).resolves.toMatchObject({ stateVersion: expect.any(Number) });
    await expect(main('enqueue_work', { key: 'item-1', title: 'First item', input: 'do it' })).resolves.toMatchObject({ itemId: expect.any(String) });

    // A repeated operationId returns the recorded response instead of appending twice.
    const operationId = randomUUID();
    const first = await main('post_board', { operationId, text: 'once' });
    expect(await main('post_board', { operationId, text: 'once' })).toEqual(first);
    await expect(main('post_board', { operationId, text: 'different' })).rejects.toThrow('operationId conflict');

    await expect(main('retry_work', { itemId: 'missing' })).rejects.toThrow('stateVersion conflict');
    await expect(main('pause', { expectedStateVersion: stale })).rejects.toThrow('stateVersion conflict');
  });
});
