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

  it('files posts under topics, filters reads by them and hands new announcements to a member without waking it', async () => {
    const h = harness(); await h.start(); await h.bootstrap('dev'); await h.bootstrap('qa');
    expect(await h.call('post_board', { text: 'Parser plan: split the lexer first', topic: 'Parser' })).toMatchObject({ seq: 1, topic: 'parser', to: [] });
    expect(await h.call('post_board', { text: 'Rule: land through submit_work only', topic: 'announce' })).toMatchObject({ seq: 2, topic: 'announce', to: [] });
    expect((await h.mail({ kind: 'post', key: 'note', text: 'Rule drafts live in docs/' })).result).not.toHaveProperty('topic');
    await expect(h.call('post_board', { text: 'hello', topic: 'two words' })).rejects.toThrow('A board topic is');

    expect(await h.call('read_board', { topic: 'parser' })).toMatchObject({ posts: [{ seq: 1, topic: 'parser' }], lastSeq: 3,
      topics: expect.arrayContaining([{ topic: 'general', posts: 1, lastSeq: 3 }, { topic: 'parser', posts: 1, lastSeq: 1 }, { topic: 'announce', posts: 1, lastSeq: 2 }]) });
    expect((await h.call('read_board', { topic: 'general' }) as { posts: unknown[] }).posts).toMatchObject([{ seq: 3, from: 'script' }]);
    expect(await h.call('search_board', { query: 'rule' })).toMatchObject({ matches: 2 });
    expect(await h.call('search_board', { query: 'rule', topic: 'announce' })).toMatchObject({ matches: 1, posts: [{ seq: 2, topic: 'announce' }] });
    // A script read is replayed against a recorded position, so it does not carry the topic list of the moment.
    expect((await h.mail({ kind: 'board', key: 'read-parser', topic: 'parser' })).result).toEqual({ posts: [expect.objectContaining({ seq: 1 })], lastSeq: 3, hasMore: false });

    type Digest = { board: { since: number; lastSeq: number; topics: Array<Record<string, unknown>>; announcements: Array<Record<string, unknown>>; moreAnnouncements?: number } };
    // Nobody named dev, yet its next turn is told about the announcement and what each topic gained.
    await h.agent('dev', 'dev-2'); const second = await h.run();
    const told = await h.worker(second, 'read_context') as Digest & { member: { messages: unknown[] } };
    expect(told.member.messages).toEqual([]);
    expect(told.board).toMatchObject({ since: 0, lastSeq: 3, announcements: [{ seq: 2, from: 'main', topic: 'announce', text: 'Rule: land through submit_work only' }] });
    expect(told.board.topics).toEqual(expect.arrayContaining([{ topic: 'parser', posts: 1, lastSeq: 1, new: 1 }, { topic: 'general', posts: 1, lastSeq: 3, new: 1 }]));
    // Rules come from the main agent, the script and a swarm's lead; any member may post in the other topics.
    await expect(h.worker(second, 'post_board', { operationId: 'rule', text: 'Rule: mine', topic: 'announce' })).rejects.toThrow('Topic "announce" is for rules and rulings');
    expect(await h.worker(second, 'post_board', { operationId: 'progress', text: 'Lexer split', topic: 'parser' })).toMatchObject({ seq: 4, topic: 'parser' });
    await h.finish(second);

    for (let n = 0; n < 7; n++) await h.call('post_board', { text: 'Ruling ' + n, topic: 'announce' });
    await h.agent('dev', 'dev-3'); const third = await h.run();
    const later = (await h.worker(third, 'read_context') as Digest).board;
    // Only what came after the previous turn was scheduled is new; the latest five rulings are given in full.
    expect(later).toMatchObject({ since: 3, lastSeq: 11, moreAnnouncements: 2 });
    expect(later.announcements.map(post => post.text)).toEqual(['Ruling 2', 'Ruling 3', 'Ruling 4', 'Ruling 5', 'Ruling 6']);
    expect(later.topics).toEqual(expect.arrayContaining([{ topic: 'announce', posts: 8, lastSeq: 11, new: 7 }, { topic: 'parser', posts: 2, lastSeq: 4, new: 1 }, { topic: 'general', posts: 1, lastSeq: 3, new: 0 }]));
    await h.finish(third);

    for (let n = 0; n < 64; n++) await h.call('post_board', { text: 'stream ' + n, topic: 'stream-' + n }).catch(error => expect(String(error)).toContain('Board topic limit reached (64)'));
    expect(Object.keys(h.state().board!.topics!)).toHaveLength(65);
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
  type Action = { post?: { text: string; to?: string[]; topic?: string }; call?: [string, Record<string, unknown>]; calls?: Array<[string, Record<string, unknown>]>; fail?: boolean; work?: boolean; result?: string; giveUp?: boolean; claim?: boolean; hold?: Promise<void> };
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
                  await callWorkflow('complete_work', { operationId: 'done' + n, claimId: grant.claimId, generation: grant.generation, result: action.result ?? name }, spec.env);
                }
                if (action.giveUp || action.claim) {
                  // Takes one item and gives it up for good, or keeps it claimed for as long as the turn runs.
                  const grant = await callWorkflow('claim_work', { operationId: 'take' }, spec.env) as { claimId: string; generation: number } | null;
                  if (grant && action.giveUp) await callWorkflow('fail_work', { operationId: 'drop', claimId: grant.claimId, generation: grant.generation, error: 'cannot build it' }, spec.env);
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
    expect(state.script, state.script?.error).toMatchObject({ status: 'result_ready' });
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
    expect(replayed.state.script, replayed.state.script?.error).toMatchObject({ status: 'result_ready', revision: 1 });
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
      // A failed turn is retried once in the member's session before the member stops.
      docs: [{}, { fail: true }, { fail: true }],
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

  it('lets the main agent add members on another model, which a lead cannot, and lets the lead announce', async () => {
    let release!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    const h = await play('return await swarm("Prove and build", {key:"crew", lead:{name:"lead"}, members:[{name:"dev", reasoningEffort:"low"}]});', {
      lead: [{ hold }, { calls: [['staff_swarm', { add: ['thief'], model: 'big' }], ['post_board', { text: 'Ruling: proofs come first', topic: 'announce' }], ['swarm_finish', { result: 'staffed' }]] }],
      dev: [{ calls: [['post_board', { text: 'Ruling: mine', topic: 'announce' }]] }],
    });
    const state = () => h.runtime.kernel.state(h.root.scopeId)!;
    const staff = async (args: Record<string, unknown>): Promise<unknown> => {
      for (;;) {
        try { return await h.runtime.kernel.call({ kind: 'main', scopeId: h.root.scopeId }, 'staff_swarm', { operationId: randomUUID(), workflowId: state().workflowId, expectedStateVersion: state().stateVersion, ...args }); }
        catch (error) { if (!(error instanceof Error && error.message.startsWith('stateVersion conflict'))) throw error; }
      }
    };
    await vi.waitFor(async () => { await h.runtime.tick(); expect(h.order).toEqual(expect.arrayContaining(['lead1', 'dev1'])); });

    await expect(staff({ model: 'big' })).rejects.toThrow('bind the members that add names');
    await expect(staff({ add: ['x'], model: 'default' })).rejects.toThrow('explicit nonempty model');
    await expect(staff({ add: ['x'], harness: 'other-agent' })).rejects.toThrow('cross-harness');
    // What is not named comes from the member the newcomers are bound like: dev runs at low effort.
    expect(await staff({ add: ['prover'], model: 'big', reasoningEffort: 'high', brief: 'Prove the reduction sound' })).toMatchObject({
      added: ['prover'], execution: { agentKind: 'custom-agent', model: 'big', reasoningEffort: 'high' } });
    expect(await staff({ add: ['checker'], model: 'big' })).toMatchObject({ execution: { model: 'big', reasoningEffort: 'low' } });
    expect(await staff({ add: ['dev2'] })).not.toHaveProperty('execution');
    await vi.waitFor(async () => { await h.runtime.tick(); expect(h.order).toEqual(expect.arrayContaining(['prover1', 'checker1', 'dev21'])); });
    release();
    await h.runtime.kernel.call({ kind: 'main', scopeId: h.root.scopeId }, 'post_board', { operationId: randomUUID(), workflowId: state().workflowId, text: '@lead wrap up' });

    const { result } = await h.settled();
    expect(result).toMatchObject({ stop: 'finished', result: 'staffed' });
    // Only the members bound unlike the usual one show their model.
    expect(result.members).toMatchObject([{ name: 'lead' }, { name: 'dev' }, { name: 'prover', added: true, model: 'big' }, { name: 'checker', model: 'big' }, { name: 'dev2', added: true }]);
    expect(result.members[1]).not.toHaveProperty('model');
    expect(result.members[4]).not.toHaveProperty('model');
    expect(h.specs.find(spec => /You are member "prover"/.test(spec.prompt))).toMatchObject({
      prompt: expect.stringContaining('Prove the reduction sound'), execution: { modelSettings: { model: 'big', reasoningEffort: 'high' } } });
    expect(h.specs.find(spec => /You are member "dev2"/.test(spec.prompt))).toMatchObject({ execution: { modelSettings: { model: 'm1', reasoningEffort: 'low' } } });
    expect(h.errors).toEqual(expect.arrayContaining([expect.stringContaining('Topic "announce" is for rules and rulings'), expect.stringContaining('Only the main agent can choose the harness or model')]));
    expect(h.errors).toHaveLength(2);
    expect(state().swarms![0]!.members.map(member => member.name)).not.toContain('thief');
    expect(state().board!.posts.find(post => post.topic === 'announce')).toMatchObject({ text: 'Ruling: proofs come first' });
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

  it('tells the lead, then the main agent, when a queue runs dry while other members work', async () => {
    let ahead = 0;
    const real = Date.now.bind(Date);
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => real() + ahead);
    cleanup.push(async () => clock.mockRestore());
    let release!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    cleanup.push(async () => release());
    // "b" waits on an item of a queue nobody consumes, so queue "q" has a pending item and nothing to claim.
    const h = await play([
      'await enqueueWork({key:"gate", title:"Gate", input:0, queue:"other"});',
      'await enqueueWork({key:"b", title:"B", input:1, queue:"q", dependsOn:["gate"]});',
      'return await swarm("Drain q", {key:"dry", lead:{name:"lead"}, members:[{name:"w1", queue:"q"},{name:"w2", queue:"q"},{name:"busy"}]});',
    ].join('\n'), { busy: [{ hold }], w1: [{ work: true }], w2: [{ work: true }] });
    const state = () => h.runtime.kernel.state(h.root.scopeId)!;
    const swarm = () => state().swarms![0]!;
    const told = () => state().board!.posts.filter(post => post.author === 'system' && post.text.includes('has run dry'));
    const leadTurns = () => h.order.filter(name => name.startsWith('lead'));
    const ticks = async (count: number) => { for (let pass = 0; pass < count; pass++) { await h.runtime.tick(); await new Promise(resolve => setTimeout(resolve, 5)); } };
    await vi.waitFor(async () => { await h.runtime.tick(); expect(h.order).toEqual(expect.arrayContaining(['lead1', 'busy1'])); expect(swarm().starved?.q).toBeDefined(); }, { timeout: 10_000 });
    // A queue that has only just run dry is not reported: its members may be between two items.
    await ticks(3);
    expect(told()).toHaveLength(0);
    const main = h.runtime.bindMain(h.root.scopeId, 'continue'); cleanup.push(async () => main.release());
    const status = await callWorkflow('status', { workflowId: state().workflowId }, main.env) as { swarms: Array<{ queues: Record<string, unknown> }>; workQueue: Record<string, unknown> };
    expect(status.swarms[0]!.queues).toMatchObject({ q: { claimable: 0, blocked: 1, claimed: 0, members: 2, running: 0, idle: 2, starvedSince: expect.any(Number) } });
    expect(status.workQueue).toMatchObject({ pending: 2, claimable: 1, blocked: 1 });
    expect(await callWorkflow('work_status', { workflowId: state().workflowId, queue: 'q' }, main.env)).toMatchObject({ total: 1, pending: 1, claimable: 0, blocked: 1 });

    ahead += 121_000;
    // The notice does not wait for the lead's gathering gap, although "busy" is still working.
    await vi.waitFor(async () => { await h.runtime.tick(); expect(leadTurns()).toEqual(['lead1', 'lead2']); }, { timeout: 10_000 });
    expect(told()).toMatchObject([{ text: expect.stringContaining('2 of its 2 members are idle') }]);
    expect(told()[0]!.text).toContain('1 pending items wait on dependencies');
    // It is repeated to the lead only after a quarter of an hour, and the main agent hears of it once the lead has had its time.
    ahead += 5 * 60_000;
    await ticks(3);
    expect(told()).toHaveLength(1);
    expect(state().events.filter(event => event.kind === 'swarm_attention')).toHaveLength(0);
    ahead += 16 * 60_000;
    await vi.waitFor(async () => { await h.runtime.tick(); expect(state().events.filter(event => event.kind === 'swarm_attention')).toHaveLength(1); }, { timeout: 10_000 });
    expect(state().events.find(event => event.kind === 'swarm_attention')).toMatchObject({ summary: expect.stringContaining('队列 q 已断粮') });
    expect(told()).toHaveLength(2);

    // Work that can be claimed ends the spell. Once a member has done it the queue is dry again, which is a new
    // spell: nobody has been told of it yet.
    await callWorkflow('enqueue_work', { operationId: randomUUID(), workflowId: state().workflowId, key: 'c', title: 'C', input: 2, queue: 'q' }, main.env);
    await vi.waitFor(async () => { await h.runtime.tick(); expect(state().workQueue!.items.find(item => item.key === 'c')).toMatchObject({ status: 'completed' }); expect(swarm().starved?.q).toEqual({ since: expect.any(Number) }); }, { timeout: 10_000 });
    expect(h.errors).toEqual([]);
    // The spell that ended is on the queue's record, with what entered and left the queue in the last hours.
    expect(swarm().dry).toEqual({ q: { spells: 1, ms: expect.any(Number), longest: expect.any(Number) } });
    expect(swarm().dry!.q!.ms).toBeGreaterThan(22 * 60_000);
    const later = await callWorkflow('status', { workflowId: state().workflowId }, main.env) as { swarms: Array<{ queues: Record<string, { dry: { minutes: number } }>; members: unknown[] }>; workQueue: unknown };
    expect(later.swarms[0]!.queues.q).toMatchObject({ dry: { spells: 1, longestMinutes: later.swarms[0]!.queues.q!.dry.minutes }, flow: { enqueued: [0, 0, 0, 0, 0, 2], completed: [0, 0, 0, 0, 0, 1] }, starvedSince: expect.any(Number) });
    expect(later.swarms[0]!.queues.q!.dry.minutes).toBeGreaterThan(22);
    expect(later.workQueue).toMatchObject({ flow: { enqueued: [0, 0, 0, 0, 0, 3], completed: [0, 0, 0, 0, 0, 1] } });
    expect(later.swarms[0]!.members).toEqual(expect.arrayContaining([expect.objectContaining({ itemsDone: 1 })]));
    release();
    await h.runtime.kernel.call({ kind: 'main', scopeId: h.root.scopeId }, 'cancel_workflow', { operationId: randomUUID(), workflowId: state().workflowId, expectedStateVersion: state().stateVersion });
  }, 30_000);

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
    const failed = await play('return await swarm("Doomed", {key:"doomed", onError:"throw", lead:{name:"lead"}, members:[{name:"dev"}]});', { lead: [{ fail: true }, { fail: true }] });
    expect((await failed.settled()).state.script).toMatchObject({ status: 'failed', error: expect.stringContaining('The lead failed') });
    const soft = await play('const a = await swarm("Doomed", {key:"doomed", lead:{name:"lead"}, members:[{name:"dev"}]}); return {a, b: await agent("x", {key:"k", member:"dev"})};', { lead: [{ fail: true }, { fail: true }] });
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
    // Without a lead nobody planned the items, so their outcomes are handed to no one.
    expect(state.board!.posts.filter(post => post.topic === 'handoff')).toEqual([]);
    expect(state.swarms![0]!.handoffs).toBeUndefined();
    // qa answers posts only: it took its opening turn and one wake-up, and never touched the queue.
    expect(h.order.filter(name => name.startsWith('qa'))).toEqual(['qa1', 'qa2']);
    expect(h.specs.find(spec => /You are member "builder"/.test(spec.prompt))!.prompt).toContain('claim_work');
    expect(h.specs.find(spec => /You are member "qa"/.test(spec.prompt))!.prompt).not.toContain('claim_work');
  });

  it('gives every turn the charter in force, tells the lead when the main agent replaces it, and lets only them set it', async () => {
    let release!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    cleanup.push(async () => release());
    const h = await play('return await swarm("Build the parser", {key:"crew", lead:{name:"lead"}, members:[{name:"dev"}]});', {
      lead: [{ hold }, { calls: [['read_context', {}], ['set_charter', { text: 'Parser first; no reports.' }]] }, { call: ['swarm_finish', { result: 'done' }] }],
      dev: [{ calls: [['set_charter', { text: 'not mine to set' }]] }],
    });
    const state = () => h.runtime.kernel.state(h.root.scopeId)!;
    const main = (method: string, args: Record<string, unknown>) => h.runtime.kernel.call({ kind: 'main', scopeId: h.root.scopeId }, method,
      { operationId: randomUUID(), workflowId: state().workflowId, ...args });
    await vi.waitFor(async () => { await h.runtime.tick(); expect(h.order).toContain('lead1'); expect(h.errors).toHaveLength(1); }, { timeout: 10_000 });
    expect(h.errors).toEqual([expect.stringContaining('Only the main agent and the lead of a running swarm can set the charter')]);
    await expect(main('set_charter', { text: '   ' })).rejects.toThrow('empty');
    await expect(main('set_charter', { text: 'x'.repeat(6001) })).rejects.toThrow('at most 6000 characters');
    // The main agent needs no state version, and the lead is told on the board, which wakes it once its turn ends.
    expect(await main('set_charter', { text: 'Match the reference at the same constraints; 1.10x is a floor, not the goal.' })).toMatchObject({ charterVersion: 1, notified: ['lead'] });
    expect(state().board!.posts.at(-1)).toMatchObject({ author: 'system', text: expect.stringContaining('The charter was replaced (version 1, set by the main agent)') });
    release();
    const { result } = await h.settled();
    expect(result).toMatchObject({ stop: 'finished', result: 'done' });
    const prompt = (turn: string) => h.specs[h.order.indexOf(turn)]!.prompt;
    expect(prompt('lead1')).not.toContain('现行目标单');
    expect(prompt('lead2')).toContain('现行目标单（第 1 版，由主 agent设定；自你上一轮以来已更新');
    expect(prompt('lead2')).toContain('1.10x is a floor, not the goal.');
    expect(h.results[0]).toMatchObject({ charter: { version: 1, by: 'main', changed: true } });
    // The lead's own revision names no one: it is the only lead, and members read it at their next turn.
    expect(h.results[1]).toMatchObject({ charterVersion: 2, notified: [] });
    expect(prompt('lead3')).toContain('现行目标单（第 2 版，由 lead lead 设定');
    expect(prompt('lead3')).toContain('Parser first; no reports.');
    expect(state().charter).toMatchObject({ version: 2, by: 'lead', text: 'Parser first; no reports.' });
    expect(prompt('lead1')).toContain('replace it with set_charter instead of adding another announcement');
  });

  it('wakes a member when the wake-up it set is due, and keeps the swarm open until then', async () => {
    let ahead = 0;
    const real = Date.now.bind(Date);
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => real() + ahead);
    cleanup.push(async () => clock.mockRestore());
    const h = await play('return await swarm("Wait for the build", {key:"timed", maxTurns: 3, members:[{name:"dev"},{name:"qa"}]});', {
      dev: [{ calls: [['wake_me', { afterMinutes: 30, note: 'check the build' }]] }, { calls: [['wake_me', { afterMinutes: 5 }], ['wake_me', { afterMinutes: 0 }]] }],
      qa: [{ calls: [['wake_me', { afterMinutes: 0 }], ['wake_me', { afterMinutes: 1441 }], ['wake_me', {}]] }],
    });
    const state = () => h.runtime.kernel.state(h.root.scopeId)!;
    const dev = () => state().swarms![0]!.members.find(member => member.name === 'dev')!;
    const ticks = async (count: number) => { for (let pass = 0; pass < count; pass++) { await h.runtime.tick(); await new Promise(resolve => setTimeout(resolve, 5)); } };
    await vi.waitFor(async () => { await h.runtime.tick(); expect(dev().wakeAt).toBeDefined(); expect(state().tasks.every(task => task.status === 'result_ready')).toBe(true); }, { timeout: 10_000 });
    // Nobody is named and nobody is working, yet a swarm without a lead does not end while a wake-up is pending.
    await ticks(5);
    expect([...h.order].sort()).toEqual(['dev1', 'qa1']);
    expect(state().swarms![0]).toMatchObject({ status: 'running' });
    expect(dev()).toMatchObject({ wakeNote: 'check the build' });
    ahead += 29 * 60_000;
    await ticks(5);
    expect(h.order).toHaveLength(2);
    ahead += 61_000;
    const { result } = await h.settled();
    expect(h.order).toEqual(expect.arrayContaining(['dev2']));
    expect(h.specs[h.order.indexOf('dev2')]!.prompt).toContain('The wake-up you set with wake_me is due: check the build.');
    // Its second turn set a wake-up and cancelled it, so the swarm went quiet.
    expect(result).toMatchObject({ stop: 'quiet', members: [{ name: 'dev', turns: 1 }, { name: 'qa', turns: 0 }] });
    expect(dev().wakeAt).toBeUndefined();
    expect(h.results.filter(item => (item as { wakeAt: string | null }).wakeAt === null)).toHaveLength(2);
    expect(h.results).toHaveLength(4);
    expect(h.errors.sort()).toEqual([expect.stringContaining('between 0 and 1440'), expect.stringContaining('Give afterMinutes')].sort());
    expect(h.specs[0]!.prompt).toContain('wake_me wakes you after a delay');
  });

  it('wakes the main agent for a review on the schedule it set, one pending review at a time', async () => {
    let ahead = 0;
    const real = Date.now.bind(Date);
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => real() + ahead);
    cleanup.push(async () => clock.mockRestore());
    // An idle swarm with a lead keeps the script running with no turn in flight, which the moving clock could stall.
    const h = await play('return await swarm("Long work", {key:"long", lead:{name:"lead"}, members:[{name:"dev"}]});', {});
    const state = () => h.runtime.kernel.state(h.root.scopeId)!;
    const main = (method: string, args: Record<string, unknown>) => h.runtime.kernel.call({ kind: 'main', scopeId: h.root.scopeId }, method,
      { operationId: randomUUID(), workflowId: state().workflowId, ...args });
    const reviews = () => state().events.filter(event => event.kind === 'review_due');
    const ticks = async (count: number) => { for (let pass = 0; pass < count; pass++) { await h.runtime.tick(); await new Promise(resolve => setTimeout(resolve, 5)); } };
    await vi.waitFor(async () => { await h.runtime.tick(); expect(state().swarms![0]!.stalled).toBe(true); }, { timeout: 10_000 });
    await expect(main('wake_me', {})).rejects.toThrow('Give afterMinutes, everyMinutes or both');
    await expect(main('wake_me', { everyMinutes: 5 })).rejects.toThrow('between 10 and 1440');
    expect(await main('wake_me', { everyMinutes: 30, note: 'parity first' })).toMatchObject({ everyMinutes: 30, wakeAt: expect.any(String) });
    await ticks(3);
    expect(reviews()).toHaveLength(0);
    ahead += 31 * 60_000;
    await vi.waitFor(async () => { await h.runtime.tick(); expect(reviews()).toHaveLength(1); }, { timeout: 10_000 });
    expect(reviews()[0]).toMatchObject({ acknowledged: false, summary: expect.stringContaining('定时复盘（parity first）') });
    expect(reviews()[0]!.summary).toContain('尚未设置目标单');
    // The next one is due while the first still waits for the main agent: it is rearmed but not raised again.
    ahead += 31 * 60_000;
    await ticks(3);
    expect(reviews()).toHaveLength(1);
    expect(state().mainWake!.at).toBeGreaterThan(Date.now());
    await vi.waitFor(() => main('ack_events', { eventIds: [reviews()[0]!.id], expectedStateVersion: state().stateVersion }), { timeout: 5000 });
    ahead += 31 * 60_000;
    await vi.waitFor(async () => { await h.runtime.tick(); expect(reviews()).toHaveLength(2); }, { timeout: 10_000 });
    // A single wake-up replaces the recurring one and leaves nothing behind once it has fired.
    expect(await main('wake_me', { afterMinutes: 10 })).not.toHaveProperty('everyMinutes');
    ahead += 11 * 60_000;
    await vi.waitFor(async () => { await h.runtime.tick(); expect(state().mainWake).toBeUndefined(); }, { timeout: 10_000 });
    expect(await main('wake_me', { everyMinutes: 60 })).toMatchObject({ everyMinutes: 60 });
    expect(await main('wake_me', { everyMinutes: 0 })).toMatchObject({ wakeAt: null });
    expect(state().mainWake).toBeUndefined();
    expect(state().script!.status).toBe('running');
  }, 30_000);

  it('hands the outcome of an item to the lead that planned it: its author, else the lead of its queue, else the swarm lead', async () => {
    const h = await play([
      'await enqueueWork({key:"p1", title:"P1", input:0, queue:"p"});',
      'return await swarm("Build", {key:"tree", lead:{name:"lead"}, maxTurns:2, members:[{name:"ql", leads:"q"},{name:"w1", queue:"q"},{name:"o1", queue:"p"}]});',
    ].join('\n'), {
      lead: [{ call: ['enqueue_work', { key: 'q2', title: 'Q2', input: 2, queue: 'q' }] }],
      ql: [{ call: ['enqueue_work', { key: 'q1', title: 'Q1', input: 1, queue: 'q' }] }],
      w1: [{ work: true, result: 'done, ask @o1 about the rest' }, { work: true, result: 'done, ask @o1 about the rest' }],
      o1: [{ work: true }],
    });
    const state = () => h.runtime.kernel.state(h.root.scopeId)!;
    const name = (id: string) => state().agents!.find(agent => agent.agentId === id)!.key;
    const handoffs = () => (state().board?.posts ?? []).filter(post => post.topic === 'handoff');
    // Each outcome with who was handed it. A lead's turn takes what has come back by then, so the posts vary; the items do not.
    const handed = () => handoffs().flatMap(post => post.text.split('\n').filter(line => line.startsWith('- ')).map(line => [line, post.to.map(name).join(), post.author]));
    await vi.waitFor(async () => { await h.runtime.tick(); expect(handed()).toHaveLength(3); expect(h.order).toEqual(expect.arrayContaining(['lead2', 'ql2'])); }, { timeout: 10_000 });
    expect(h.errors).toEqual([]);
    // The script's item goes to the swarm lead, since queue "p" has no lead of its own; the item the lead of "q" added
    // goes to it; and the item the swarm lead put into "q" comes back to the swarm lead.
    expect(handed()).toEqual(expect.arrayContaining([
      ['- completed "p1" (o1): P1', 'lead', 'system'],
      ['- completed "q1" (w1): Q1', 'ql', 'system'],
      ['- completed "q2" (w1): Q2', 'lead', 'system'],
    ]));
    expect(state().swarms![0]!.handoffs).toBeUndefined();
    // The result is quoted, so the member it mentions is not woken by it.
    const toQl = handoffs().find(post => post.text.includes('"q1"'))!.text;
    expect(toQl).toBe('Outcomes of a work item that came back since your last turn. work_status({key}) has an item in full.\nQueue "q":\n- completed "q1" (w1): Q1\n  Result: done, ask @o1 about the rest');
    expect(h.order.filter(turn => turn.startsWith('o1'))).toEqual(['o11']);
    const prompt = (member: string) => h.specs.find(spec => spec.prompt.includes(`You are member "${member}"`))!.prompt;
    expect(prompt('ql')).toContain('You lead queue "q" under @lead');
    expect(prompt('ql')).toContain('Your wake-ups are not limited');
    expect(prompt('ql')).toContain('you do not do the work');
    expect(prompt('w1')).toContain('@ql leads your queue "q"');
    expect(prompt('w1')).toContain('The system hands it to the lead that planned the item');
    expect(prompt('o1')).toContain('@lead is the lead');
    expect(prompt('lead')).toContain('These members lead parts of the work under you: ql (queue "q")');
    expect(prompt('lead')).toContain('you do not do the work');
    expect(prompt('lead')).toContain('@ql (leads "q")');
    expect(prompt('lead')).toContain('each queue should hold at least one claimable item for every member that consumes it');
    expect(prompt('w1')).toContain('Stay inside your item');
    expect(prompt('w1')).toContain('you withdraw with update_work({key, cancel: true})');
    for (const member of ['lead', 'ql']) expect(prompt(member)).toContain('update_work({key, ...}) moves one ahead or back (priority)');
    expect(prompt('lead')).toContain('at your next turn the system posts the outcomes in topic "handoff", gathered');
    // The rules of a first turn do not last a long run: every later turn of a lead restates its part and shows how its queues stand.
    expect(h.specs[h.order.indexOf('lead2')]!.prompt).toMatch(/You are the lead: you plan and judge and do not do the work yourself\..* leave each queue that has no lead of its own with at least one claimable item .*Queues now: .*"q" \d+ claimable, \d+ of 1 members idle, \d+ items completed in the last hour \(lead ql\)/);
    expect(h.specs[h.order.indexOf('ql2')]!.prompt).toMatch(/You lead queue "q": you plan and judge .* leave each queue of yours with .*Queues now: "q" \d+ claimable, \d+ of 1 members idle, \d+ items completed in the last hour\./);
    expect(h.specs[h.order.indexOf('ql2')]!.prompt).not.toContain('"p"');
    const main = h.runtime.bindMain(h.root.scopeId, 'continue'); cleanup.push(async () => main.release());
    const status = await callWorkflow('status', { workflowId: state().workflowId }, main.env) as { swarms: Array<{ queues: Record<string, { lead?: string }>; members: unknown[] }> };
    expect(status.swarms[0]!.members).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'ql', leads: ['q'] }), expect.objectContaining({ name: 'lead', lead: true })]));
    expect(status.swarms[0]!.queues.q!.lead).toBe('ql');
    expect(status.swarms[0]!.queues.p!.lead).toBeUndefined();
  });

  it('tells the lead of a queue, not the swarm lead, when its queue runs dry or its member fails, and does not bound it by maxTurns', async () => {
    let ahead = 0;
    const real = Date.now.bind(Date);
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => real() + ahead);
    cleanup.push(async () => clock.mockRestore());
    let release!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    cleanup.push(async () => release());
    // "b" waits on an item of a queue nobody consumes, so queue "q" has a pending item and nothing to claim.
    const h = await play([
      'await enqueueWork({key:"gate", title:"Gate", input:0, queue:"other"});',
      'await enqueueWork({key:"b", title:"B", input:1, queue:"q", dependsOn:["gate"]});',
      'await enqueueWork({key:"x", title:"X", input:2, queue:"r"});',
      'return await swarm("Drain", {key:"dry", maxTurns:1, lead:{name:"lead"}, members:[{name:"ql", leads:["r","q"]},{name:"w1", queue:"q"},{name:"w2", queue:"q"},{name:"bad", queue:"r"},{name:"busy"}]});',
    ].join('\n'), { busy: [{ hold }], bad: [{ fail: true }, { fail: true }] });
    const state = () => h.runtime.kernel.state(h.root.scopeId)!;
    const swarm = () => state().swarms![0]!;
    const name = (id: string) => state().agents!.find(agent => agent.agentId === id)!.key;
    const told = (text: string) => (state().board?.posts ?? []).filter(post => post.author === 'system' && post.text.includes(text));
    await vi.waitFor(async () => { await h.runtime.tick(); expect(swarm().members.find(member => member.name === 'bad')!.stopped).toBe('failed'); expect(swarm().starved?.q).toBeDefined(); }, { timeout: 10_000 });
    expect(swarm().members.find(member => member.name === 'ql')).toMatchObject({ leads: ['q', 'r'] });
    // Members of the same standing share a line of the roster, so a large swarm does not repeat a role a hundred times.
    expect(h.specs.find(spec => spec.prompt.includes('You are member "lead"'))!.prompt).toContain('@w1, @w2 (queue "q")\n');
    expect(told('Member "bad" of queue "r" failed and has stopped').map(post => post.to.map(name))).toEqual([['ql']]);
    expect(told('Member "bad"')[0]!.text).toContain('Ask the lead (lead) for a replacement');
    ahead += 121_000;
    await vi.waitFor(async () => { await h.runtime.tick(); expect(h.order).toContain('ql2'); expect(told('has run dry')).toHaveLength(1); }, { timeout: 10_000 });
    expect(told('has run dry').map(post => post.to.map(name))).toEqual([['ql']]);
    expect(told('has run dry')[0]!.text).toContain('Queue "q" has run dry: 2 of its 2 members are idle');
    expect(told('has run dry')[0]!.text).toContain('Add at least 2 items for it with enqueue_work now; if there is no more work for it, tell the lead (lead).');
    // ql has used the one wake-up maxTurns allows the other members, and is woken again all the same.
    const main = h.runtime.bindMain(h.root.scopeId, 'continue'); cleanup.push(async () => main.release());
    await callWorkflow('post_board', { operationId: randomUUID(), workflowId: state().workflowId, text: 'What is left?', to: ['ql'] }, main.env);
    ahead += 16 * 60_000;
    await vi.waitFor(async () => { await h.runtime.tick(); expect(h.order).toContain('ql3'); }, { timeout: 10_000 });
    // The swarm lead heard of neither: the part is ql's to plan.
    expect(h.order.filter(turn => turn.startsWith('lead'))).toEqual(['lead1']);
    expect(h.errors).toEqual([]);
    release();
    await h.runtime.kernel.call({ kind: 'main', scopeId: h.root.scopeId }, 'cancel_workflow', { operationId: randomUUID(), workflowId: state().workflowId, expectedStateVersion: state().stateVersion });
  }, 30_000);

  it('lets the main agent, and only it, give a queue a lead of its own while the swarm runs', async () => {
    let ahead = 0;
    const real = Date.now.bind(Date);
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => real() + ahead);
    cleanup.push(async () => clock.mockRestore());
    let release!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    cleanup.push(async () => release());
    const h = await play('return await swarm("Build", {key:"grow", lead:{name:"lead"}, members:[{name:"w1", queue:"q", role:"builder"},{name:"busy"}]});',
      { busy: [{ hold }], lead: [{ calls: [['staff_swarm', { add: ['x'], leads: ['q'] }]] }], w1: [{ work: true }] });
    const state = () => h.runtime.kernel.state(h.root.scopeId)!;
    const name = (id: string) => state().agents!.find(agent => agent.agentId === id)!.key;
    await vi.waitFor(async () => { await h.runtime.tick(); expect(h.errors).toHaveLength(1); }, { timeout: 10_000 });
    expect(h.errors[0]).toContain('Only the main agent can give a queue a lead of its own');
    const main = h.runtime.bindMain(h.root.scopeId, 'continue'); cleanup.push(async () => main.release());
    const staff = (args: Record<string, unknown>) => callWorkflow('staff_swarm', { operationId: randomUUID(), workflowId: state().workflowId, ...args }, main.env);
    await expect(staff({ add: ['a', 'b'], leads: ['q'] })).rejects.toThrow('add that member alone');
    await expect(staff({ add: ['a'], leads: ['q'], queue: 'q' })).rejects.toThrow('does not consume a queue');
    await expect(staff({ leads: ['q'] })).rejects.toThrow('leads binds the member that add names');
    expect(await staff({ add: ['ql'], leads: 'q', role: 'plans q' })).toMatchObject({ added: ['ql'], leads: ['q'] });
    await expect(staff({ add: ['other'], leads: ['q'] })).rejects.toThrow('Queue "q" already has a lead: ql');
    // The new lead takes over neither the queue nor the role of the member it is bound like.
    const ql = state().swarms![0]!.members.find(member => member.name === 'ql')!;
    expect(ql).toMatchObject({ leads: ['q'], role: 'plans q', added: true });
    expect(ql.queue).toBeUndefined();
    // The members already running learn of it from an announcement, which also names the swarm lead.
    const announced = state().board!.posts.find(post => post.topic === 'announce' && post.text.includes('Member "ql" now leads queue "q"'))!;
    expect(announced).toMatchObject({ author: 'system' });
    expect(announced.to.map(name)).toEqual(['lead']);
    await vi.waitFor(async () => { await h.runtime.tick(); expect(h.order).toContain('ql1'); }, { timeout: 10_000 });
    expect(h.specs.find(spec => spec.prompt.includes('You are member "ql"'))!.prompt).toContain('You lead queue "q" under @lead');
    // From then on the outcomes of the queue's items go to it.
    await callWorkflow('enqueue_work', { operationId: randomUUID(), workflowId: state().workflowId, key: 'i1', title: 'I1', input: 1, queue: 'q' }, main.env);
    await vi.waitFor(async () => { await h.runtime.tick(); expect(state().swarms![0]!.handoffs).toHaveLength(1); }, { timeout: 10_000 });
    // "busy" is still at work, so the outcome waits out the gap in which what comes back for a lead is gathered.
    ahead += 31_000;
    await vi.waitFor(async () => { await h.runtime.tick(); expect(state().board!.posts.filter(post => post.topic === 'handoff')).toHaveLength(1); }, { timeout: 10_000 });
    expect(state().board!.posts.filter(post => post.topic === 'handoff').map(post => [post.text.split('\n').slice(1).join('|'), post.to.map(name)])).toEqual([['Queue "q":|- completed "i1" (w1): I1|  Result: w1', ['ql']]]);
    release();
    await h.runtime.kernel.call({ kind: 'main', scopeId: h.root.scopeId }, 'cancel_workflow', { operationId: randomUUID(), workflowId: state().workflowId, expectedStateVersion: state().stateVersion });
  }, 30_000);

  it('gathers the outcomes a lead is owed into posts when its turn starts: a dozen items to a post, a few posts to a turn', async () => {
    let release!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    cleanup.push(async () => release());
    const h = await play('return await swarm("Build", {key:"many", lead:{name:"lead"}, members:[{name:"w1", queue:"a"},{name:"w2", queue:"b"}]});',
      { lead: [{ hold }], w1: [{ work: true, result: 'r'.repeat(3000) }], w2: [{ work: true }, { giveUp: true }] });
    const state = () => h.runtime.kernel.state(h.root.scopeId)!;
    const swarm = () => state().swarms![0]!;
    const item = (key: string) => state().workQueue?.items.find(found => found.key === key);
    const handoffs = () => (state().board?.posts ?? []).filter(post => post.topic === 'handoff');
    const main = h.runtime.bindMain(h.root.scopeId, 'continue'); cleanup.push(async () => main.release());
    const enqueue = (key: string, queue: string) => callWorkflow('enqueue_work', { operationId: randomUUID(), workflowId: state().workflowId, key, title: 'Item ' + key, input: key, queue }, main.env);
    await vi.waitFor(async () => { await h.runtime.tick(); expect(h.order).toContain('lead1'); }, { timeout: 10_000 });
    // Queue "b" first: one item completed, then one given up. Then fifty items of queue "a".
    await enqueue('b2', 'b');
    await vi.waitFor(async () => { await h.runtime.tick(); expect(item('b2')!.status).toBe('completed'); }, { timeout: 10_000 });
    await enqueue('b1', 'b');
    await vi.waitFor(async () => { await h.runtime.tick(); expect(item('b1')!.status).toBe('failed'); }, { timeout: 10_000 });
    for (let n = 0; n < 50; n++) await enqueue('a' + n, 'a');
    // While the lead is in its turn nothing is posted: the outcomes wait for its next one.
    await vi.waitFor(async () => { await h.runtime.tick(); expect(swarm().handoffs).toHaveLength(52); }, { timeout: 20_000 });
    expect(handoffs()).toEqual([]);
    release();
    await vi.waitFor(async () => { await h.runtime.tick(); expect(h.order).toContain('lead3'); expect(swarm().handoffs).toBeUndefined(); }, { timeout: 10_000 });
    expect(h.errors).toEqual([]);
    const lines = (text: string) => text.split('\n').filter(line => line.startsWith('- '));
    const posts = handoffs().map(post => post.text);
    // The second turn took four posts of twelve; the four items left over woke the lead for its third.
    expect(posts.map(text => lines(text).length)).toEqual([12, 12, 12, 12, 4]);
    expect(posts[0]!.split('\n')[0]).toBe('Outcomes of 48 work items that came back since your last turn, 12 of them here. work_status({key}) has an item in full.');
    expect(posts[3]!.split('\n')[0]).toBe('Outcomes of 48 work items that came back since your last turn, 12 of them here; 4 more follow at your next turn. work_status({key}) has an item in full.');
    expect(posts[4]!.split('\n')[0]).toBe('Outcomes of 4 work items that came back since your last turn. work_status({key}) has an item in full.');
    expect(new Set(posts.flatMap(lines).map(line => /"([^"]+)"/.exec(line)![1])).size).toBe(52);
    // By queue, what failed ahead of what was completed, although it came back later.
    expect(posts[0]).toContain('Queue "b":\n- failed "b1" (w2): Item b1\n  Error: cannot build it\n- completed "b2" (w2): Item b2\n  Result: w2\nQueue "a":\n- completed "a0" (w1): Item a0\n  Result: rrr');
    // A dozen items share the room of a post, so a long result is cut to a line and the whole stays in the item.
    expect(posts.every(text => text.length <= 4000)).toBe(true);
    const quote = posts[1]!.split('\n').find(line => line.startsWith('  Result: '))!;
    expect(quote.length).toBeLessThan(320);
    expect(quote).toContain('…[truncated]');
    expect(await callWorkflow('work_status', { workflowId: state().workflowId, key: 'a7' }, main.env)).toMatchObject({ key: 'a7', status: 'completed', result: 'r'.repeat(3000) });
    // The lead's turns were told how its queues stand, and the status shows who did what and how the queues moved.
    expect(h.specs[h.order.indexOf('lead2')]!.prompt).toContain('"a" 0 claimable, 1 of 1 members idle, 50 items completed in the last hour');
    const status = await callWorkflow('status', { workflowId: state().workflowId }, main.env) as { swarms: Array<{ queues: Record<string, unknown>; members: unknown[] }> };
    expect(status.swarms[0]!.members).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'w1', itemsDone: 50 }), expect.objectContaining({ name: 'w2', itemsDone: 1, itemsFailed: 1 })]));
    expect(status.swarms[0]!.queues).toMatchObject({ a: { flow: { enqueued: [0, 0, 0, 0, 0, 50], completed: [0, 0, 0, 0, 0, 50] } },
      b: { flow: { enqueued: [0, 0, 0, 0, 0, 2], completed: [0, 0, 0, 0, 0, 1], failed: [0, 0, 0, 0, 0, 1] } } });
    await h.runtime.kernel.call({ kind: 'main', scopeId: h.root.scopeId }, 'cancel_workflow', { operationId: randomUUID(), workflowId: state().workflowId, expectedStateVersion: state().stateVersion });
  }, 60_000);

  it('hands a lead the item that failed for good because its member lost the claim, not only what a member settled itself', async () => {
    // w1 ends its turn holding the claim, which was the item's only attempt.
    const h = await play([
      'await enqueueWork({key:"k", title:"K", input:1, queue:"q", maxAttempts:1});',
      'return await swarm("Build", {key:"lost", lead:{name:"lead"}, members:[{name:"w1", queue:"q"}]});',
    ].join('\n'), { w1: [{ claim: true }], lead: [{}, { call: ['swarm_finish', { result: 'k is lost' }] }] });
    const { state } = await h.settled();
    expect(h.errors).toEqual([]);
    expect(state.workQueue!.items[0]).toMatchObject({ key: 'k', status: 'failed', error: expect.stringContaining('Attempt budget exhausted') });
    const handed = state.board!.posts.filter(post => post.topic === 'handoff');
    expect(handed).toHaveLength(1);
    expect(handed[0]!.text).toMatch(/^Outcomes of a work item that came back since your last turn\. work_status\(\{key\}\) has an item in full\.\nQueue "q":\n- failed "k" \(w1\): K\n  Error: Attempt budget exhausted: /);
    expect(state.swarms![0]).toMatchObject({ stop: 'finished', members: expect.arrayContaining([expect.objectContaining({ name: 'w1', itemsFailed: 1 })]) });
    expect(state.swarms![0]!.handoffs).toBeUndefined();
  });

  it('lets whoever plans a queue reorder, hold, withdraw and retry its items, and a member withdraw what it added', async () => {
    let release!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    cleanup.push(async () => release());
    // Nobody consumes queue "q", so its items stay where they can be changed.
    const h = await play([
      'await enqueueWork({key:"a", title:"A", input:1, queue:"q"}); await enqueueWork({key:"b", title:"B", input:2, queue:"q"});',
      'await enqueueWork({key:"x", title:"X", input:3, queue:"q"}); await enqueueWork({key:"y", title:"Y", input:4, queue:"q", dependsOn:["x"]});',
      'await enqueueWork({key:"p1", title:"P1", input:5, queue:"p"}); await enqueueWork({key:"f", title:"F", input:6, queue:"r", maxAttempts:1});',
      'return await swarm("Build", {key:"plan", lead:{name:"lead"}, members:[{name:"ql", leads:"q"},{name:"w2", queue:"r"},{name:"scout"}]});',
    ].join('\n'), {
      // w2 gives "f" up; the lead, handed that outcome, retries it, and w2 then holds it claimed.
      w2: [{ giveUp: true }, { claim: true, hold }],
      lead: [{ calls: [['update_work', { key: 'b', priority: 50 }], ['update_work', { key: 'x', cancel: true, reason: 'superseded' }]] }, { calls: [['retry_work', { key: 'f' }]] }],
      ql: [{ calls: [['update_work', { key: 'a', hold: true }], ['update_work', { key: 'p1', priority: 5 }], ['retry_work', { key: 'p1' }]] }],
      scout: [{ calls: [['enqueue_work', { key: 'mine', title: 'Mine', input: 0, queue: 'q' }], ['update_work', { key: 'mine', priority: 9 }], ['update_work', { key: 'b', cancel: true }], ['update_work', { key: 'mine', cancel: true }]] }],
    });
    const state = () => h.runtime.kernel.state(h.root.scopeId)!;
    const item = (key: string) => state().workQueue!.items.find(found => found.key === key)!;
    await vi.waitFor(async () => { await h.runtime.tick(); expect(h.order).toContain('w22'); expect(item('f').status).toBe('claimed'); }, { timeout: 10_000 });
    expect(h.results).toEqual(expect.arrayContaining([
      { itemId: item('b').id, key: 'b', queue: 'q', status: 'pending', priority: 50 },
      { itemId: item('x').id, key: 'x', queue: 'q', status: 'cancelled', priority: 0, blocks: ['y'] },
      { itemId: item('a').id, key: 'a', queue: 'q', status: 'pending', priority: 0, hold: true },
      expect.objectContaining({ key: 'mine', status: 'cancelled' }),
      expect.objectContaining({ itemId: item('f').id, maxAttempts: 2 }),
    ]));
    // The lead of "q" plans "q" alone; a member plans nothing, and withdraws only what it added.
    expect(h.errors.sort()).toEqual([
      expect.stringContaining('A member can only withdraw (cancel) an item it added'),
      expect.stringContaining('Only the main agent, the swarm lead or the lead of its queue can retry a work item'),
      expect.stringContaining('Only the main agent, the swarm lead, the lead of its queue or, to cancel it, the member that added it can change a work item'),
      expect.stringContaining('Only the main agent, the swarm lead, the lead of its queue or, to cancel it, the member that added it can change a work item'),
    ]);
    expect(item('x')).toMatchObject({ status: 'cancelled', error: 'Cancelled by lead: superseded' });
    expect(item('mine')).toMatchObject({ status: 'cancelled', error: 'Cancelled by scout', by: 'scout' });
    expect(item('f')).toMatchObject({ status: 'claimed', maxAttempts: 2, generation: 2 });

    const main = h.runtime.bindMain(h.root.scopeId, 'continue'); cleanup.push(async () => main.release());
    const op = (method: string, args: Record<string, unknown>) => callWorkflow(method, { operationId: randomUUID(), workflowId: state().workflowId, ...args }, main.env);
    const queue = () => callWorkflow('work_status', { workflowId: state().workflowId, queue: 'q' }, main.env) as Promise<{ items: Array<{ key: string; hold?: boolean }> }>;
    // An item on hold, like one behind a withdrawn item, is pending and cannot be claimed.
    expect(await queue()).toMatchObject({ pending: 3, cancelled: 2, claimable: 1, blocked: 2, onHold: 1 });
    expect((await queue()).items.find(found => found.key === 'a')).toMatchObject({ hold: true, priority: 0 });
    const released = await op('update_work', { key: 'a', hold: false, priority: 80 });
    expect(released).toMatchObject({ itemId: item('a').id, key: 'a', queue: 'q', status: 'pending', priority: 80 });
    expect(released).not.toHaveProperty('hold');
    expect(item('a').hold).toBeUndefined();
    expect(await queue()).toMatchObject({ claimable: 2, blocked: 1 });
    expect(await queue()).not.toHaveProperty('onHold');
    expect(await op('update_work', { itemId: item('b').id, priority: 0 })).toMatchObject({ key: 'b', priority: 0 });
    expect(item('b').priority).toBeUndefined();
    // A claimed item is its member's to stop; a finished or withdrawn one no longer changes.
    await expect(op('update_work', { key: 'f', cancel: true })).rejects.toThrow('Work item is claimed by w2');
    await expect(op('update_work', { key: 'x', hold: true })).rejects.toThrow('Work item is already cancelled');
    expect(await op('update_work', { key: 'x', cancel: true })).toMatchObject({ key: 'x', status: 'cancelled' });
    await expect(op('update_work', { key: 'b' })).rejects.toThrow('Give priority, hold or cancel');
    await expect(op('update_work', { key: 'b', cancel: true, hold: true })).rejects.toThrow('do not combine it with priority or hold');
    await expect(op('update_work', { key: 'b', hold: true, reason: 'why' })).rejects.toThrow('reason belongs to cancel');
    await expect(op('update_work', { key: 'b', itemId: item('b').id, hold: true })).rejects.toThrow('Name the work item by itemId or by key');
    await expect(op('update_work', { key: 'nope', hold: true })).rejects.toThrow('Unknown work item');
    await expect(op('retry_work', { key: 'b' })).rejects.toThrow('Only failed work items can be retried');
    release();
    await h.runtime.kernel.call({ kind: 'main', scopeId: h.root.scopeId }, 'cancel_workflow', { operationId: randomUUID(), workflowId: state().workflowId, expectedStateVersion: state().stateVersion });
  }, 30_000);

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
    expect(await run({ key: 't', members: [{ name: 'a', leads: 'q' }, { name: 'b', queue: 'q' }] })).toContain('need a swarm lead');
    expect(await run({ key: 't', lead: { name: 'l', leads: 'q' }, members: [{ name: 'b', queue: 'q' }] })).toContain('leads is for other members');
    expect(await run({ key: 't', lead: { name: 'l' }, members: [{ name: 'a', leads: 'q', queue: 'q' }] })).toContain('does not consume a queue');
    expect(await run({ key: 't', lead: { name: 'l' }, members: [{ name: 'a', leads: 'q' }, { name: 'b', leads: ['q'] }] })).toContain('A queue has one lead');
    expect(await run({ key: 't', lead: { name: 'l' }, members: [{ name: 'a', leads: [] }] })).toContain('leads is a queue name or an array');
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
    await expect(main('set_charter', { text: 'Ship the fix; tests must pass.' })).resolves.toMatchObject({ stateVersion: expect.any(Number), charterVersion: 1 });
    await expect(main('enqueue_work', { key: 'item-1', title: 'First item', input: 'do it' })).resolves.toMatchObject({ itemId: expect.any(String) });

    // A repeated operationId returns the recorded response instead of appending twice.
    const operationId = randomUUID();
    const first = await main('post_board', { operationId, text: 'once' });
    expect(await main('post_board', { operationId, text: 'once' })).toEqual(first);
    await expect(main('post_board', { operationId, text: 'different' })).rejects.toThrow('operationId conflict');

    // Staffing and an item's attempts are checked against the state the change commits on, not against a version.
    await expect(main('retry_work', { itemId: 'missing' })).rejects.toThrow('Unknown work item');
    await expect(main('staff_swarm', { add: ['x'] })).rejects.toThrow('none is running');
    await expect(main('close_work_queue', {})).rejects.toThrow('stateVersion conflict');
    await expect(main('pause', { expectedStateVersion: stale })).rejects.toThrow('stateVersion conflict');
  });
});
