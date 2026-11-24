import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { callWorkflow, WorkflowRuntime, type WorkerRunSpec } from '../src';
import { WorkflowKernel } from '../src/engine/kernel';
import type { WorkflowRoot, WorkflowState, WorkflowWorkerRequest, WorkflowWorkerResult } from '../src/engine/types';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

function harness(clock: () => number = () => 1_000_000) {
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
  const kernel = new WorkflowKernel(':memory:', host, clock);
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
  it('keeps one ordered feed: a note names nobody and wakes nobody, a script\'s post reaches the members it names', async () => {
    const h = harness(); await h.start(); await h.bootstrap('lead'); await h.bootstrap('dev'); await h.bootstrap('qa');
    expect(await h.call('note', { text: 'Kickoff: no one needs to act yet' })).toMatchObject({ seq: 1 });
    // Whatever its text says, a note is delivered to nobody; a name in `to` is refused instead of being dropped.
    expect(await h.call('note', { text: '@dev implement the parser; mail a@qa.example is not a mention' })).toMatchObject({ seq: 2 });
    await expect(h.call('note', { text: 'hello', to: ['dev'] })).rejects.toThrow('A note names nobody');
    await expect(h.call('note', { text: '   ' })).rejects.toThrow('empty');
    expect(h.state().mailbox?.messages ?? []).toEqual([]);
    expect((await h.mail({ kind: 'post', key: 'announce', text: 'Freeze at noon', to: 'all' })).result).toMatchObject({ seq: 3, to: ['lead', 'dev', 'qa'] });
    expect((await h.mail({ kind: 'post', key: 'named', text: '@dev implement the parser', to: ['lead'] })).result).toMatchObject({ seq: 4, to: ['lead', 'dev'] });
    await expect(h.mail({ kind: 'post', key: 'ghost', text: 'hello', to: ['ghost'] })).rejects.toThrow('Unknown member');

    // As with direct messages, a receive hands the batch to the member's next turn.
    await h.mail({ kind: 'receive', member: 'dev', key: 'dev-inbox' });
    await h.agent('dev', 'dev-work'); const turn = await h.run();
    const context = await h.worker(turn, 'read_context') as { member: { messages: Array<Record<string, unknown>> } };
    expect(context.member.messages).toMatchObject([
      { from: 'script', post: 3, all: true, text: 'Freeze at noon' },
      { from: 'script', post: 4, to: ['lead', 'dev'], topic: 'board', text: '@dev implement the parser' }]);
    const noted = await h.worker(turn, 'note', { operationId: 'done', text: 'Parser done, @qa please verify' });
    expect(noted).toEqual({ seq: 5 });
    // A retried tool call repeats the recorded answer instead of noting twice.
    expect(await h.worker(turn, 'note', { operationId: 'done', text: 'Parser done, @qa please verify' })).toEqual(noted);
    await expect(h.worker(turn, 'post_board', { operationId: 'old', text: 'hi' })).rejects.toThrow('post_board is no longer an operation: ask({to,text})');
    await h.finish(turn);

    const feed = await h.call('read_board', { after: 1, limit: 2 }) as { posts: Array<Record<string, unknown>>; lastSeq: number; hasMore: boolean };
    expect(feed).toMatchObject({ lastSeq: 5, hasMore: true, posts: [{ seq: 2, from: 'main', to: [] }, { seq: 3, from: 'script', all: true }] });
    expect((await h.call('read_board', { member: 'qa', limit: 50 }) as typeof feed).posts.map(post => post.seq)).toEqual([3]);
    expect((await h.call('read_board', { member: 'dev', limit: 50 }) as typeof feed).posts.map(post => post.seq)).toEqual([3, 4, 5]);
    // Deliveries do not copy the text and do not spend the direct-message budget.
    const box = h.state().mailbox!;
    expect(box.messages).toHaveLength(5);
    expect(box.messages.every(message => message.text === '' && message.post !== undefined)).toBe(true);
    expect(box.messages.filter(message => message.consumedByTurnId).map(message => message.post)).toEqual([3, 4]);
  });

  it('files posts under topics, filters reads by them and hands new rulings to a member without waking it', async () => {
    const h = harness(); await h.start(); await h.bootstrap('dev'); await h.bootstrap('qa');
    expect(await h.call('note', { text: 'Parser plan: split the lexer first', topic: 'Parser' })).toMatchObject({ seq: 1, topic: 'parser' });
    expect(await h.call('note', { text: 'Rule: land through submit_work only', topic: 'announce' })).toMatchObject({ seq: 2, topic: 'announce' });
    expect((await h.mail({ kind: 'post', key: 'note', text: 'Rule drafts live in docs/' })).result).not.toHaveProperty('topic');
    await expect(h.call('note', { text: 'hello', topic: 'two words' })).rejects.toThrow('A board topic is');

    expect(await h.call('read_board', { topic: 'parser' })).toMatchObject({ posts: [{ seq: 1, topic: 'parser' }], lastSeq: 3,
      topics: expect.arrayContaining([{ topic: 'general', posts: 1, lastSeq: 3 }, { topic: 'parser', posts: 1, lastSeq: 1 }, { topic: 'announce', posts: 1, lastSeq: 2 }]) });
    expect((await h.call('read_board', { topic: 'general' }) as { posts: unknown[] }).posts).toMatchObject([{ seq: 3, from: 'script' }]);
    expect(await h.call('search_board', { query: 'rule' })).toMatchObject({ matches: 2 });
    expect(await h.call('search_board', { query: 'rule', topic: 'announce' })).toMatchObject({ matches: 1, posts: [{ seq: 2, topic: 'announce' }] });
    // A script read is replayed against a recorded position, so it does not carry the topic list of the moment.
    expect((await h.mail({ kind: 'board', key: 'read-parser', topic: 'parser' })).result).toEqual({ posts: [expect.objectContaining({ seq: 1 })], lastSeq: 3, hasMore: false });

    type Digest = { board: { since: number; lastSeq: number; topics: Array<Record<string, unknown>>; announcements: Array<Record<string, unknown>>; moreAnnouncements?: number } };
    // Nobody named dev, yet its next turn is told about the ruling and what each topic gained.
    await h.agent('dev', 'dev-2'); const second = await h.run();
    const told = await h.worker(second, 'read_context') as Digest & { member: { messages: unknown[] } };
    expect(told.member.messages).toEqual([]);
    expect(told.board).toMatchObject({ since: 0, lastSeq: 3, announcements: [{ seq: 2, from: 'main', topic: 'announce', text: 'Rule: land through submit_work only' }] });
    expect(told.board.topics).toEqual(expect.arrayContaining([{ topic: 'parser', posts: 1, lastSeq: 1, new: 1 }, { topic: 'general', posts: 1, lastSeq: 3, new: 1 }]));
    // Rules come from the main agent, the script and a swarm's lead; any member may note in the other topics.
    await expect(h.worker(second, 'note', { operationId: 'rule', text: 'Rule: mine', topic: 'announce' })).rejects.toThrow('Topic "announce" is for rules and rulings');
    expect(await h.worker(second, 'note', { operationId: 'progress', text: 'Lexer split', topic: 'parser' })).toEqual({ seq: 4, topic: 'parser' });
    await h.finish(second);

    for (let n = 0; n < 7; n++) await h.call('note', { text: 'Ruling ' + n, topic: 'announce' });
    await h.agent('dev', 'dev-3'); const third = await h.run();
    const later = (await h.worker(third, 'read_context') as Digest).board;
    // Only what came after the previous turn was scheduled is new; the latest five rulings are given in full.
    expect(later).toMatchObject({ since: 3, lastSeq: 11, moreAnnouncements: 2 });
    expect(later.announcements.map(post => post.text)).toEqual(['Ruling 2', 'Ruling 3', 'Ruling 4', 'Ruling 5', 'Ruling 6']);
    expect(later.topics).toEqual(expect.arrayContaining([{ topic: 'announce', posts: 8, lastSeq: 11, new: 7 }, { topic: 'parser', posts: 2, lastSeq: 4, new: 1 }, { topic: 'general', posts: 1, lastSeq: 3, new: 0 }]));
    await h.finish(third);

    for (let n = 0; n < 64; n++) await h.call('note', { text: 'stream ' + n, topic: 'stream-' + n }).catch(error => expect(String(error)).toContain('Board topic limit reached (64)'));
    expect(Object.keys(h.state().board!.topics!)).toHaveLength(65);
  });

  it('lets one-off workers read but not write, and replays a script read against the recorded feed position', async () => {
    const h = harness(); await h.start(); await h.bootstrap('dev');
    await h.call('note', { text: 'first' });
    await h.kernel.scriptAgent('board', h.state().workflowId, h.state().script!.runId, { key: 'oneoff', prompt: 'look around' });
    const oneoff = await h.run();
    expect(await h.worker(oneoff, 'read_board')).toMatchObject({ posts: [{ seq: 1, text: 'first' }] });
    await expect(h.worker(oneoff, 'note', { operationId: 'x', text: 'hi' })).rejects.toThrow('persistent member');
    await expect(h.worker(oneoff, 'ask', { operationId: 'y', to: 'dev', text: 'hi' })).rejects.toThrow('persistent member');
    await h.finish(oneoff);
    expect((await h.mail({ kind: 'board', key: 'snapshot' })).result).toMatchObject({ lastSeq: 1, posts: [{ seq: 1 }] });
    await h.call('note', { text: 'second' });
    await h.call('pause'); await h.call('replay_script'); h.kernel.beginScript('board', h.state().workflowId);
    expect((await h.mail({ kind: 'board', key: 'snapshot' })).result).toMatchObject({ lastSeq: 1, posts: [{ seq: 1 }] });
    expect((await h.mail({ kind: 'board', key: 'later' })).result).toMatchObject({ lastSeq: 2 });
    await expect(h.mail({ kind: 'post', key: 'bad', text: 'x', member: 'dev' })).rejects.toThrow('Unsupported mailbox option');
  });

  it('marks posts resolved: reads skip them, searches still find them, and only those concerned may mark one', async () => {
    const h = harness(); await h.start(); await h.bootstrap('dev'); await h.bootstrap('qa'); await h.bootstrap('ops');
    await h.call('note', { text: 'Kickoff' });
    await h.mail({ kind: 'post', key: 'which', text: '@dev which parser do we keep?', topic: 'parser' });
    await h.call('note', { text: 'Rule: land through submit_work only', topic: 'announce' });
    await h.mail({ kind: 'post', key: 'freeze', text: 'Freeze at noon', to: 'all' });

    await h.agent('dev', 'dev-1'); const dev = await h.run();
    expect(await h.worker(dev, 'note', { operationId: 'answer', text: 'Keep the recursive descent parser', topic: 'parser' })).toMatchObject({ seq: 5 });
    expect(await h.worker(dev, 'ask', { operationId: 'ask', to: 'qa', text: 'is the fuzz corpus ready?', topic: 'parser' })).toMatchObject({ ask: 6, to: 'qa' });
    // A resolution says how the post ended, and names posts that exist.
    await expect(h.worker(dev, 'resolve_post', { operationId: 'bare', seq: 2 })).rejects.toThrow('Say how the post was resolved');
    await expect(h.worker(dev, 'resolve_post', { operationId: 'self', seq: 2, see: 2 })).rejects.toThrow('not the post itself');
    await expect(h.worker(dev, 'resolve_post', { operationId: 'ghost', seq: 7, note: 'done' })).rejects.toThrow('Unknown board post: 7; the board has 6 posts');
    await expect(h.worker(dev, 'resolve_post', { operationId: 'none', seq: [], note: 'done' })).rejects.toThrow('seq must be');
    // A member resolves what it wrote and what names it: not a post for nobody, not one for everybody, not a rule.
    await expect(h.worker(dev, 'resolve_post', { operationId: 'other', seq: 1, note: 'done' })).rejects.toThrow('neither yours nor addressed to you by name');
    await expect(h.worker(dev, 'resolve_post', { operationId: 'all', seq: [2, 4], note: 'done' })).rejects.toThrow('Post 4 is neither yours');
    await expect(h.worker(dev, 'resolve_post', { operationId: 'rule', seq: 3, note: 'done' })).rejects.toThrow('Post 3 is an announcement');
    expect(h.state().board!.posts.some(post => post.resolved)).toBe(false);
    const resolved = await h.worker(dev, 'resolve_post', { operationId: 'answered', seq: 2, see: 5, note: 'Recursive descent stays' });
    expect(resolved).toEqual({ resolved: [2] });
    // A retried tool call repeats the recorded answer; resolving again leaves the first resolution in place.
    expect(await h.worker(dev, 'resolve_post', { operationId: 'answered', seq: 2, see: 5, note: 'Recursive descent stays' })).toEqual(resolved);
    expect(await h.worker(dev, 'resolve_post', { operationId: 'more', seq: [2, 6, 6], note: 'Found it myself' })).toEqual({ resolved: [6], unchanged: [2] });
    expect(h.state().board).toMatchObject({ posts: { 1: { resolved: { from: h.state().agents!.find(agent => agent.key === 'dev')!.agentId, at: 1_000_000, note: 'Recursive descent stays', see: 5 } } },
      topics: { parser: { posts: 3, resolved: 2 } } });
    expect(h.state().board!.asks).toBeUndefined();
    await h.finish(dev);

    // A read returns what is open and says how much it passed over; resolved posts come on request, with their resolution.
    type Read = { posts: Array<Record<string, unknown>>; hasMore: boolean; resolvedSkipped?: number; topics: Array<Record<string, unknown>> };
    const open = await h.call('read_board', { topic: 'parser' }) as Read;
    expect(open).toMatchObject({ posts: [{ seq: 5 }], resolvedSkipped: 2 });
    expect(open.posts).toHaveLength(1);
    expect(open.topics).toEqual(expect.arrayContaining([{ topic: 'parser', posts: 3, lastSeq: 6, resolved: 2 }, { topic: 'general', posts: 2, lastSeq: 4 }]));
    const every = await h.call('read_board', { topic: 'parser', resolved: true }) as Read;
    expect(every.posts).toMatchObject([{ seq: 2, resolved: { by: 'dev', at: 1_000_000, note: 'Recursive descent stays', see: 5 } }, { seq: 5 }, { seq: 6, resolved: { by: 'dev', note: 'Found it myself' } }]);
    expect(every).not.toHaveProperty('resolvedSkipped');
    expect(every.posts[1]).not.toHaveProperty('resolved');
    expect(await h.call('read_board', { after: 0, limit: 2 })).toMatchObject({ posts: [{ seq: 1 }, { seq: 3 }], hasMore: true, resolvedSkipped: 1 });
    expect(await h.call('read_board', { after: 3, limit: 2 })).toMatchObject({ posts: [{ seq: 4 }, { seq: 5 }], hasMore: false, resolvedSkipped: 1 });
    await expect(h.call('read_board', { resolved: 'yes' })).rejects.toThrow('resolved must be a boolean');
    // A script read is replayed, so it returns the range as posted whatever was resolved since.
    const scripted = (await h.mail({ kind: 'board', key: 'parser-feed', topic: 'parser' })).result as Read;
    expect(scripted).toEqual({ posts: [2, 5, 6].map(seq => expect.objectContaining({ seq })), lastSeq: 6, hasMore: false });
    expect(scripted.posts.some(post => 'resolved' in post)).toBe(false);
    // A search finds resolved posts too, after the open ones, and by the words of their resolution.
    const found = await h.call('search_board', { query: 'parser' }) as { posts: Array<Record<string, unknown>> };
    expect(found).toMatchObject({ matches: 2, posts: [{ seq: 5 }, { seq: 2, resolved: { by: 'dev', see: 5 } }] });
    expect(found.posts[0]).not.toHaveProperty('resolved');
    expect(await h.call('search_board', { query: 'descent STAYS' })).toMatchObject({ matches: 1, posts: [{ seq: 2, snippet: 'Recursive descent stays' }] });

    // qa was asked by a post that its author has since closed: the delivery says so. Its digest counts what is open.
    type Context = { member: { messages: Array<Record<string, unknown>> }; todos: unknown[]; board: { topics: Array<Record<string, unknown>>; announcements: Array<Record<string, unknown>> } };
    await h.mail({ kind: 'receive', member: 'qa', key: 'qa-inbox' });
    await h.agent('qa', 'qa-1'); const qa = await h.run();
    const told = await h.worker(qa, 'read_context') as Context;
    expect(told.member.messages).toMatchObject([{ post: 4, all: true }, { post: 6, ask: true, text: 'is the fuzz corpus ready?', resolved: { by: 'dev', note: 'Found it myself' } }]);
    expect(told.member.messages[0]).not.toHaveProperty('resolved');
    expect(told.todos).toEqual([]);
    expect(told.board.topics).toEqual(expect.arrayContaining([{ topic: 'parser', posts: 3, lastSeq: 6, resolved: 2, new: 1 }, { topic: 'general', posts: 2, lastSeq: 4, new: 2 }]));
    expect(told.board.announcements).toMatchObject([{ seq: 3 }]);
    // Being named is enough to reopen, as it is to resolve; a reopened ask waits on the one asked again.
    await expect(h.worker(qa, 'resolve_post', { operationId: 'why', seq: 6, reopen: true, note: 'still open' })).rejects.toThrow('reopen takes neither note nor see');
    await expect(h.worker(qa, 'resolve_post', { operationId: 'not-mine', seq: 2, reopen: true })).rejects.toThrow('Post 2 is neither yours');
    expect(await h.worker(qa, 'resolve_post', { operationId: 'reopen', seq: 6, reopen: true })).toEqual({ reopened: [6] });
    expect(await h.worker(qa, 'resolve_post', { operationId: 'reopen-again', seq: 6, reopen: true })).toEqual({ unchanged: [6] });
    expect((await h.worker(qa, 'read_board', { topic: 'parser' }) as Read).posts).toMatchObject([{ seq: 5 }, { seq: 6 }]);
    expect(h.state().board!.posts[5]).not.toHaveProperty('resolved');
    expect(h.state().board!.asks).toMatchObject([{ seq: 6 }]);
    await h.finish(qa);

    // The main agent resolves any post, a rule included; a member that has not seen the rule yet is not handed it.
    expect(await h.call('resolve_post', { seq: [1, 3], note: 'Replaced by the landing queue' })).toMatchObject({ resolved: [1, 3], stateVersion: expect.any(Number) });
    expect(h.state().board!.posts[2]!.resolved).toEqual({ at: 1_000_000, note: 'Replaced by the landing queue' });
    await h.agent('ops', 'ops-1'); const ops = await h.run();
    const late = (await h.worker(ops, 'read_context') as Context).board;
    expect(late.announcements).toEqual([]);
    expect(late.topics).toEqual(expect.arrayContaining([{ topic: 'announce', posts: 1, lastSeq: 3, resolved: 1, new: 0 }, { topic: 'general', posts: 2, lastSeq: 4, resolved: 1, new: 1 }]));
    await h.finish(ops);
    // A one-off worker reads the board and changes nothing on it.
    await h.kernel.scriptAgent('board', h.state().workflowId, h.state().script!.runId, { key: 'oneoff', prompt: 'look around' });
    const oneoff = await h.run();
    await expect(h.worker(oneoff, 'resolve_post', { operationId: 'x', seq: 4, note: 'done' })).rejects.toThrow('persistent member');
    expect(await h.worker(oneoff, 'read_board', { resolved: true })).toMatchObject({ posts: [{ seq: 1, resolved: { by: 'main' } }, { seq: 2 }, { seq: 3 }, { seq: 4 }, { seq: 5 }, { seq: 6 }] });
    await h.finish(oneoff);
  });

  it('keeps an ask in front of the one asked until it is answered, brings the answer to the asker, and takes it upward when it stays open', async () => {
    let now = 1_000_000;
    const h = harness(() => now); await h.start(); await h.bootstrap('dev'); await h.bootstrap('qa');
    const notices = (kind: string) => h.state().events.filter(event => event.kind === kind);
    type Todo = { id: number; kind: string; holder: string; text: string; act?: string; leftOpenBy?: string[] };
    type Context = { member: { messages: Array<Record<string, unknown>> }; todos: Todo[]; asked?: Array<Record<string, unknown>> };
    // An ask names the one member that owes the answer, in `to` alone; a script does not ask.
    await expect(h.call('ask', { text: 'Which of you owns the parser?', to: ['dev', 'qa'] })).rejects.toThrow('names in "to" the one member');
    await expect(h.call('ask', { text: '@dev which branch?' })).rejects.toThrow('names in "to" the one member');
    await expect(h.call('ask', { text: 'Which branch?', to: 'all' })).rejects.toThrow('names in "to" the one member');
    await expect(h.call('ask', { text: 'Which branch?', to: 'dev', withinMinutes: 0 })).rejects.toThrow('how long you can wait');
    await expect(h.call('ask', { text: 'Which branch?', to: 'dev', topic: 'announce' })).rejects.toThrow('for everyone');
    await expect(h.call('ask', { text: 'Which branch?', to: 'main' })).rejects.toThrow('You are the main agent');
    await expect(h.call('ask', { text: 'Which branch?', to: 'ghost' })).rejects.toThrow('Unknown member');
    await expect(h.mail({ kind: 'post', key: 'script-ask', text: 'Which branch?', to: ['dev'], ask: true })).rejects.toThrow('Unsupported mailbox option');
    expect(await h.call('ask', { text: 'Which branch does the parser fix go to? @qa is waiting on it.', to: 'dev', withinMinutes: 5 })).toMatchObject({ ask: 1, to: 'dev', withinMinutes: 5 });
    expect(h.state().board!.asks).toMatchObject([{ seq: 1, within: 300_000, excerpt: expect.stringContaining('Which branch') }]);
    expect(h.state().board!.asks![0]).not.toHaveProperty('from');
    // The ask is delivered once, to the one asked and to nobody its text names; from then on it is that member's to-do.
    expect(h.state().mailbox!.messages).toMatchObject([{ post: 1, to: h.state().agents!.find(agent => agent.key === 'dev')!.agentId }]);
    await h.kernel.tick();
    expect(await h.call('status')).toMatchObject({ todos: [{ id: 1, kind: 'ask', holder: 'dev', minutes: 0 }] });

    // The turn it arrives in ends without an answer; the next turn has it again, though no message brought it.
    await h.mail({ kind: 'receive', member: 'dev', key: 'dev-inbox' });
    await h.agent('dev', 'dev-1'); let turn = await h.run();
    expect(await h.worker(turn, 'read_context')).toMatchObject({ member: { messages: [{ post: 1, ask: true }] },
      todos: [{ id: 1, kind: 'ask', holder: 'dev', text: expect.stringContaining('Ask 1 from the main agent: "Which branch'), act: expect.stringContaining('answer({ask: 1, text})') }] });
    await expect(h.worker(turn, 'ask', { operationId: 'own', text: 'Which one?', to: 'dev' })).rejects.toThrow('not yourself');
    await h.finish(turn);
    await h.agent('qa', 'qa-1'); turn = await h.run();
    // Someone else's ask is not qa's to answer or to put off, and an answer is to an ask that is open.
    expect((await h.worker(turn, 'read_context') as Context).todos).toEqual([]);
    await expect(h.worker(turn, 'answer', { operationId: 'meddle', ask: 1, text: 'main, I think' })).rejects.toThrow('not addressed to you');
    await expect(h.worker(turn, 'answer', { operationId: 'none', ask: 7, text: 'Yes' })).rejects.toThrow('No ask has the number 7');
    await expect(h.worker(turn, 'defer_todo', { operationId: 'defer', id: 1, note: 'later' })).rejects.toThrow('To-do 1 is held by dev');
    await h.finish(turn);

    // Its time runs out: nobody stands between dev and the main agent, which asked, so the main agent is told.
    now += 4 * 60_000; await h.kernel.tick();
    expect(notices('todo')).toHaveLength(0);
    now += 60_000; await h.kernel.tick();
    // An asker cannot have the main agent told sooner than a quarter of an hour, however little time it gave.
    expect(notices('todo')).toHaveLength(0);
    now += 10 * 60_000; await h.kernel.tick();
    expect(notices('todo')).toMatchObject([{ acknowledged: false, subject: 'todo:1', summary: expect.stringMatching(/^待办 #1，已 15 分钟（dev 未处理，上报到你）：第 1 帖请求（你 问 dev）已 15 分钟未答复，dev 不在回合中/) }]);
    expect(notices('ask')).toHaveLength(0);
    expect(h.state().todos!.open).toMatchObject([{ id: 1, subject: 'ask:1', told: [{ who: 'dev' }, { who: 'main', at: now }] }]);
    // Nothing repeats it while it stands, until an hour has gone by at the top.
    now += 30 * 60_000; await h.kernel.tick();
    expect(notices('todo')).toHaveLength(1);

    // Going up took the ask from nobody: the one asked still reads it, as its own, and answers. The answer goes to
    // whoever asked and closes the ask in the same step; what told the main agent of it is settled.
    await h.agent('dev', 'dev-2'); turn = await h.run();
    expect(await h.worker(turn, 'read_context')).toMatchObject({ member: { messages: [] }, todos: [{ id: 1, holder: 'main', leftOpenBy: ['dev'], text: expect.stringContaining('Ask 1 from the main agent') }] });
    expect(await h.worker(turn, 'answer', { operationId: 'answer', ask: 1, text: 'It goes to release-2.' })).toEqual({ ask: 1, post: 2, answered: true });
    expect(h.state().board!.asks).toBeUndefined();
    expect(h.state().board!.posts).toMatchObject([{ seq: 1, ask: { within: 300_000 }, resolved: { see: 2 } }, { seq: 2, answers: 1, to: [] }]);
    expect(notices('worker_reply')).toMatchObject([{ summary: expect.stringContaining('dev 答复了你的第 1 帖请求（全文是第 2 帖，read_board 可读）：It goes to release-2.') }]);
    await h.kernel.tick();
    expect(notices('todo')).toMatchObject([{ acknowledged: true }]);
    expect(h.state().todos!.open).toEqual([]);
    await expect(h.worker(turn, 'answer', { operationId: 'again', ask: 1, text: 'Really.' })).rejects.toThrow('Ask 1 is closed already (see post 2)');
    await expect(h.worker(turn, 'answer', { operationId: 'not-ask', ask: 2, text: 'Noted.' })).rejects.toThrow('Post 2 is not an ask');
    expect((await h.call('read_board', { resolved: true }) as { posts: unknown[] }).posts).toMatchObject([{ seq: 1, ask: { withinMinutes: 5 }, resolved: { by: 'dev', see: 2 } }, { seq: 2, answers: 1 }]);

    // Between members with nobody above them but the main agent: it is told once the one asked has had its time.
    expect(await h.worker(turn, 'ask', { operationId: 'ask-qa', text: 'Did the fuzz run pass on release-2?', to: 'qa', withinMinutes: 20 })).toMatchObject({ ask: 3, to: 'qa', withinMinutes: 20 });
    expect(await h.worker(turn, 'read_context')).toMatchObject({ asked: [{ seq: 3, to: 'qa', minutes: 0 }] });
    await h.finish(turn);
    await h.kernel.tick();
    now += 19 * 60_000; await h.kernel.tick();
    expect(notices('todo')).toHaveLength(1);
    now += 60_000; await h.kernel.tick();
    expect(notices('todo')).toMatchObject([{}, { acknowledged: false, summary: expect.stringContaining('第 3 帖请求（dev 问 qa）已 20 分钟未答复，qa 不在回合中') }]);
    // The main agent answers in qa's place: dev is handed the answer, and the notice is settled.
    expect(await h.call('answer', { ask: 3, text: 'It passed; see the nightly report.' })).toMatchObject({ ask: 3, post: 4, answered: true });
    await h.kernel.tick();
    expect(notices('todo')).toMatchObject([{ acknowledged: true }, { acknowledged: true }]);
    await h.mail({ kind: 'receive', member: 'dev', key: 'dev-inbox-2' });
    await h.agent('dev', 'dev-3'); turn = await h.run();
    expect(await h.worker(turn, 'read_context')).toMatchObject({ member: { messages: [{ post: 4, from: 'main', answers: 3, text: 'It passed; see the nightly report.' }] }, todos: [] });

    // A member with nobody above it asks the main agent, which is told at once and as an ask.
    expect(await h.worker(turn, 'ask', { operationId: 'ask-main', text: 'May release-2 ship without the Windows build?', to: 'main' })).toMatchObject({ ask: 5, to: 'main', withinMinutes: 15 });
    await h.kernel.tick();
    expect(notices('ask')).toMatchObject([{ acknowledged: false, summary: expect.stringMatching(/^待办 #\d+：dev 请你答复（第 5 帖，它等 15 分钟）：May release-2 ship without the Windows build\?。用 answer\(\{ask:5,text\}\) 答复/) }]);
    await h.finish(turn);
    // Nobody stands above the main agent in the workflow, so nothing follows when the time runs out.
    now += 16 * 60_000; await h.kernel.tick();
    expect(notices('ask')).toHaveLength(1);
    await h.agent('dev', 'dev-4'); turn = await h.run();
    expect(await h.worker(turn, 'read_context')).toMatchObject({ asked: [{ seq: 5, to: 'main', minutes: 16 }] });
    // Its author withdraws it by answering it itself, which tells nobody; closed by another, the author is told how it ended.
    expect(await h.worker(turn, 'answer', { operationId: 'withdraw', ask: 5, text: 'Windows build came through' })).toEqual({ ask: 5, post: 6, withdrawn: true });
    await h.kernel.tick();
    expect(notices('ask')).toMatchObject([{ acknowledged: true }]);
    expect(notices('worker_reply')).toHaveLength(1);
    expect(await h.worker(turn, 'ask', { operationId: 'ask-qa-2', text: 'Who signs off the changelog?', to: 'qa' })).toMatchObject({ ask: 7 });
    expect(await h.call('resolve_post', { seq: 7, note: 'The user signs it off; nothing for qa to do' })).toMatchObject({ resolved: [7] });
    expect(h.state().board!.posts).toHaveLength(7);
    expect(h.state().mailbox!.messages.at(-1)).toMatchObject({ from: 'system', text: 'Your ask 7 to qa was closed by the main agent without an answer of its own: The user signs it off; nothing for qa to do' });
    expect(h.state().board!.asks).toBeUndefined();
    // Reopened, it is owed again from then on, and waits on the one asked like a new one.
    expect(await h.worker(turn, 'resolve_post', { operationId: 'reopen', seq: 7, reopen: true })).toEqual({ reopened: [7] });
    expect(h.state().board!.asks).toMatchObject([{ seq: 7, at: now }]);
    await h.kernel.tick();
    expect(h.state().todos!.open).toMatchObject([{ subject: 'ask:7', since: now, told: [{ who: 'qa', at: now }] }]);
    await h.finish(turn);
    // An ask is for what its author waits on, so one author has only so many open.
    for (let count = 0; count < 8; count++) await h.call('ask', { text: `Question ${count}`, to: 'qa' });
    await expect(h.call('ask', { text: 'One more', to: 'qa' })).rejects.toThrow('You have 8 asks open');
    expect(await h.call('note', { text: 'One more, for whoever reads it' })).toMatchObject({ seq: 16 });
    expect(h.state().board!.asks).toHaveLength(9);
  });

  it('wakes a waiting member on a post that names it and reports quiet only when every member is parked with nothing to read', async () => {
    const h = harness(); await h.start(); await h.bootstrap('dev'); await h.bootstrap('qa');
    const quiet = { kind: 'quiet', members: ['dev', 'qa'] };
    await expect(h.wait('bad', [{ kind: 'quiet', members: ['dev', 'dev'] }])).rejects.toThrow('unique');
    await expect(h.wait('bad', [{ kind: 'quiet', members: ['ghost'] }])).rejects.toThrow('Unknown member');
    await h.mail({ kind: 'post', key: 'plan', text: '@qa review the plan' });
    const dev = await h.wait('dev/1', [{ kind: 'message', member: 'dev' }, quiet]);
    // qa is not waiting yet, so dev cannot conclude that the team is done.
    expect(h.result(dev)).toBeUndefined();
    const qa = await h.wait('qa/1', [{ kind: 'message', member: 'qa' }, quiet]);
    expect(h.result(qa)).toMatchObject({ index: 0, kind: 'message', value: [{ from: 'script', post: 1, text: '@qa review the plan' }] });
    expect(h.result(dev)).toBeUndefined();
    await h.agent('qa', 'qa/turn1'); const turn = await h.run();
    // A note reaches nobody's wait; an ask reaches the one asked.
    await h.worker(turn, 'note', { operationId: 'note', text: 'Plan is fine, @dev' });
    expect(h.result(dev)).toBeUndefined();
    await h.worker(turn, 'ask', { operationId: 'ask', text: 'Plan is fine; shall I start?', to: 'dev' });
    expect(h.result(dev)).toMatchObject({ kind: 'message', value: [{ from: 'qa', ask: true, text: 'Plan is fine; shall I start?' }] });
    await h.finish(turn);
    await h.agent('dev', 'dev/turn1'); const devTurn = await h.run();
    await h.worker(devTurn, 'answer', { operationId: 'go', ask: 3, text: 'Go ahead.' });
    await h.finish(devTurn);
    const devAgain = await h.wait('dev/2', [{ kind: 'message', member: 'dev' }, quiet]);
    expect(h.result(devAgain)).toBeUndefined();
    const qaAgain = await h.wait('qa/2', [{ kind: 'message', member: 'qa' }, quiet]);
    // The answer was delivered to qa, which therefore is not parked: its wait takes the message.
    expect(h.result(qaAgain)).toMatchObject({ index: 0, kind: 'message', value: [{ from: 'dev', answers: 3, text: 'Go ahead.' }] });
    await h.agent('qa', 'qa/turn2'); await h.finish(await h.run());
    const last = await h.wait('qa/3', [{ kind: 'message', member: 'qa' }, quiet]);
    // The last member to fall asleep settles every wait watching the group in the same commit.
    expect(h.result(last)).toEqual({ index: 1, kind: 'quiet', value: { members: ['dev', 'qa'] } });
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
  type Action = {
    /** Claims and completes items until the queue has none for the member. */
    work?: boolean; result?: string;
    /** Takes one item and keeps it for the turn, gives it up for good, hands it back, or completes it once `hold` is over. */
    claim?: boolean; giveUp?: boolean; release?: { reason: string; waitFor?: string[] }; complete?: boolean;
    call?: [string, Record<string, unknown>]; calls?: Array<[string, Record<string, unknown>]>;
    note?: { text: string; topic?: string }; ask?: { to: string; text: string; withinMinutes?: number };
    /** Answers every open ask made of the member. */
    answer?: string;
    fail?: boolean; hold?: Promise<void>;
    /** The harness of the turn takes input while it runs: what it is sent is collected here, and `receipt` is what it answers (accepted when left out). */
    heard?: string[]; receipt?: 'unknown' | 'inactive';
  };
  type Plan = Action[] | ((turn: number, state: WorkflowState) => Action);
  const held: Array<() => void> = [];
  /** Runs a script whose members act out `plan`: what each does on its nth turn (opening turn first), or as things stand when the turn starts. */
  async function play(script: string, plan: Record<string, Plan>) {
    const root: WorkflowRoot = { scopeId: 'chat', profile: 'embedded', agentKind: 'custom-agent', cwdRealpath: '/repo',
      policyFingerprint: 'policy', catalogBinding: 'main', modelSettings: { model: 'm1' } };
    const order: string[] = [];
    const specs: WorkerRunSpec[] = [];
    const errors: string[] = [];
    const results: unknown[] = [];
    const seen: Record<string, number> = {};
    const taken: Record<string, string[]> = {};
    const born: Record<string, number> = {};
    const holding = new Set<string>();
    const runtime: WorkflowRuntime = new WorkflowRuntime({
      path: ':memory:', resolveRoot: async () => root, wakeMain: async () => {},
      runner: {
        async start(spec) {
          specs.push(spec);
          await spec.validateBeforeRun();
          const name = (spec.resume?.id ?? /You are member "([^"]+)"/.exec(spec.prompt)![1]!).replace(/#\d+$/, '');
          // A session started anew under a name that had one gets a native ID of its own: name#2, name#3.
          const born1 = spec.resume ? 0 : born[name] = (born[name] ?? 0) + 1;
          const native = spec.resume?.id ?? (born1 > 1 ? `${name}#${born1}` : name);
          const turn = seen[name] = (seen[name] ?? 0) + 1;
          order.push(name + turn);
          (taken[name] ??= []).push(name + turn);
          const acts = plan[name];
          const action = (typeof acts === 'function' ? acts(turn, runtime.kernel.state(root.scopeId)!) : acts?.[turn - 1]) ?? {};
          if (action.hold) { holding.add(name); void action.hold.then(() => holding.delete(name)); }
          return {
            runId: `run-${specs.length}`, result: Promise.resolve(action.fail ? 'failed' : 'completed'),
            stop: async () => {}, waitForExit: async () => true, stopReason: () => undefined,
            ...(action.heard ? { send: async (text: string) => { action.heard!.push(text); return action.receipt ?? 'accepted' as const; } } : {}),
            async *events() {
              yield { type: 'session', nativeSessionId: native };
              try {
                for (let n = 0; action.work; n++) {
                  const grant = await callWorkflow('claim_work', { operationId: 'claim' + n }, spec.env) as { claimId: string; generation: number } | null;
                  if (!grant) break;
                  await callWorkflow('complete_work', { operationId: 'done' + n, claimId: grant.claimId, generation: grant.generation, result: action.result ?? name }, spec.env);
                }
                const taken = action.claim || action.giveUp || action.release || action.complete
                  ? await callWorkflow('claim_work', { operationId: 'take' }, spec.env) as { claimId: string; generation: number } | null : null;
                const held = taken && { claimId: taken.claimId, generation: taken.generation };
                if (held && action.giveUp) await callWorkflow('fail_work', { operationId: 'drop', ...held, error: 'cannot build it' }, spec.env);
                if (held && action.release) await callWorkflow('release_claim', { operationId: 'release', ...held, ...action.release }, spec.env);
                if (action.call) await callWorkflow(action.call[0], { operationId: 'call', ...action.call[1] }, spec.env);
                for (const [index, [method, input]] of (action.calls ?? []).entries()) {
                  try { results.push(await callWorkflow(method, { operationId: 'calls' + index, ...input }, spec.env)); } catch (error) { errors.push(String(error)); }
                }
                if (action.note) await callWorkflow('note', { operationId: 'note', ...action.note }, spec.env);
                if (action.ask) await callWorkflow('ask', { operationId: 'ask', ...action.ask }, spec.env);
                if (action.answer !== undefined) {
                  const live = runtime.kernel.state(root.scopeId)!;
                  const me = live.agents!.find(agent => agent.key === name)!.agentId;
                  for (const asked of live.board?.asks?.filter(item => item.to === me) ?? []) await callWorkflow('answer', { operationId: 'answer' + asked.seq, ask: asked.seq, text: action.answer }, spec.env);
                }
                // Keeps the turn running until the test lets it end.
                if (action.hold) await action.hold;
                if (held && action.complete) await callWorkflow('complete_work', { operationId: 'finish', ...held, result: action.result ?? name }, spec.env);
              } catch (error) { errors.push(String(error)); }
              if (action.fail) { yield { type: 'error', message: 'model refused' }; yield { type: 'done', normal: false }; return; }
              yield { type: 'final_text', text: `${name} turn ${turn}` };
              yield { type: 'done', normal: true };
            },
          };
        },
      },
    });
    await runtime.start(); cleanup.push(async () => { for (const release of held.splice(0)) release(); await runtime.close(); });
    const main = runtime.bindMain(root.scopeId, 'start');
    await callWorkflow('run_script', { operationId: randomUUID(), goal: 'ship the parser', plan: 'A swarm coordinates on the board.', maxAgents: 40, script }, main.env);
    main.release();
    const state = () => runtime.kernel.state(root.scopeId)!;
    const settled = async () => {
      await vi.waitFor(async () => { await runtime.tick(); expect(state()?.script?.status).not.toMatch(/running|queued/); }, { timeout: 10_000 });
      const ref = state().script?.resultRef;
      return { state: state(), result: ref ? JSON.parse(state().artifacts.find(artifact => artifact.ref === ref)!.text) : undefined };
    };
    /** A main-agent operation that needs no state version. */
    const asMain = (method: string, args: Record<string, unknown> = {}) => runtime.kernel.call({ kind: 'main', scopeId: root.scopeId }, method, { operationId: randomUUID(), workflowId: state().workflowId, ...args });
    const ticks = async (count: number) => { for (let pass = 0; pass < count; pass++) { await runtime.tick(); await new Promise(resolve => setTimeout(resolve, 5)); } };
    /** Ticks until `check` holds. */
    const until = (check: () => void | Promise<void>, timeout = 10_000) => vi.waitFor(async () => { await runtime.tick(); await check(); }, { timeout });
    /**
     * Ticks until no turn runs but those the test holds. The clock must not be moved under a turn that is ending: the
     * engine would take it for one that has hung.
     */
    const calm = () => until(() => {
      const live = state();
      const members = (live.swarms ?? []).flatMap(swarm => swarm.members);
      expect(live.tasks.filter(task => ['queued', 'starting', 'running', 'cancelling', 'unknown'].includes(task.status))
        .map(task => members.find(member => member.taskId === task.taskId)?.name ?? task.taskId).filter(name => !holding.has(name))).toEqual([]);
    });
    /** The prompts of a member's turns, in order. */
    const prompts = (name: string) => specs.filter(spec => (spec.resume?.id ?? /You are member "([^"]+)"/.exec(spec.prompt)?.[1])?.replace(/#\d+$/, '') === name).map(spec => spec.prompt);
    const turns = (name: string) => taken[name] ?? [];
    const todos = (kind?: string) => (state().todos?.open ?? []).filter(todo => !kind || todo.kind === kind);
    const notices = (kind: string) => state().events.filter(event => event.kind === kind);
    const cancel = () => runtime.kernel.call({ kind: 'main', scopeId: root.scopeId }, 'cancel_workflow', { operationId: randomUUID(), workflowId: state().workflowId, expectedStateVersion: state().stateVersion });
    return { runtime, root, order, specs, errors, results, settled, state, asMain, ticks, until, calm, prompts, turns, todos, notices, cancel };
  }
  const posts = (result: { posts: Array<{ from: string; to: string[] }> }) => result.posts.map(post => [post.from, post.to]);
  /** Moves the clock the engine reads; `ahead.by(ms)` adds to it. */
  function clock() {
    let offset = 0;
    const real = Date.now.bind(Date);
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => real() + offset);
    cleanup.push(async () => spy.mockRestore());
    return { by: (ms: number) => { offset += ms; } };
  }
  const MIN = 60_000;
  /** A turn that runs until the test lets it end, or the test is over. */
  function gate() {
    let release!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    held.push(release);
    return { hold, release };
  }

  it('runs the members of a swarm without a lead side by side, wakes one for an ask and the other for its answer, and ends when all are quiet', async () => {
    const h = await play('return await swarm("Ship the parser", {key:"ship", maxTurns: 4, members:[{name:"dev", role:"Implement"},{name:"qa", role:"Verify"}]});', {
      dev: [{ ask: { to: 'qa', text: 'Parser implemented; does the empty input pass?' }, note: { text: 'Parser lives in src/parser, @qa' } }, {}],
      qa: [{}, { answer: 'Empty input crashes' }],
    });
    const { state, result } = await h.settled();
    expect(state.script, state.script?.error).toMatchObject({ status: 'result_ready' });
    expect(result).toMatchObject({ stop: 'quiet', turns: 4, hasMore: false, members: [
      { name: 'dev', turns: 1, status: 'idle', note: 'dev turn 2' }, { name: 'qa', turns: 1, status: 'idle', note: 'qa turn 2' }] });
    expect(result).not.toHaveProperty('result');
    // The note named nobody; the ask reached qa and its answer dev, and each woke the one it was for.
    expect(posts(result)).toEqual([['script', []], ['dev', []], ['dev', ['qa']], ['qa', ['dev']]]);
    expect(h.order.slice(2)).toEqual(['qa2', 'dev2']);
    expect(h.errors).toEqual([]);
    expect(h.specs[0]!.prompt).toContain('You work on the task side by side with the other members');
    expect(h.specs[0]!.prompt).toContain('ask({to, text}) is a to-do of that member until it answers');
    expect(h.specs[0]!.prompt).not.toContain('post_board');
    // The turn the ask woke qa for has it as a to-do and in its messages; the answer closed it.
    expect(h.prompts('qa')[1]).toContain('1 to-do waits on you; deal with it before other work:');
    expect(h.prompts('qa')[1]).toContain('Ask 3 from dev: "Parser implemented; does the empty input pass?"');
    expect(h.prompts('dev')[1]).toContain('Empty input crashes');
    expect(state.todos?.open ?? []).toEqual([]);
    // No script-side waits: the kernel schedules every turn.
    expect(state.waits ?? []).toHaveLength(0);

    // Replaying the finished script rejoins the swarm from the journal: no member runs again and nothing is posted twice.
    const again = h.runtime.bindMain(h.root.scopeId, 'continue');
    await callWorkflow('replay_script', { operationId: randomUUID(), workflowId: state.workflowId, expectedStateVersion: state.stateVersion }, again.env);
    again.release();
    const replayed = await h.settled();
    expect(replayed.state.script, replayed.state.script?.error).toMatchObject({ status: 'result_ready', revision: 1 });
    expect(replayed.result).toEqual(result);
    expect(h.specs).toHaveLength(4);
    expect(replayed.state.board!.posts).toHaveLength(4);
  });

  const PAIR = 'return await swarm("Ship the parser", {key:"ship", maxTurns: 4, members:[{name:"dev", role:"Implement"},{name:"qa", role:"Verify"}]});';
  const turnOf = (h: { specs: WorkerRunSpec[] }, name: string) => h.specs.find(spec => spec.prompt.includes(`You are member "${name}"`))!;

  it('puts an ask into the turn the member asked is in, and its answer into the turn of whoever asked, so that neither costs a turn', async () => {
    const dev = gate(), qa = gate();
    const heard = { dev: [] as string[], qa: [] as string[] };
    const h = await play(PAIR, {
      dev: [{ hold: dev.hold, heard: heard.dev }],
      qa: [{ ask: { to: 'dev', text: 'Which entry point is public?' }, hold: qa.hold, heard: heard.qa }],
    });
    await h.until(() => expect(heard.dev).toHaveLength(1));
    const ask = h.state().board!.asks![0]!.seq;
    expect(heard.dev[0]).toContain(`[Ask ${ask} from qa, which waits 15 min]\nWhich entry point is public?`);
    expect(heard.dev[0]).toContain('is a to-do of yours until it is answered: answer({ask, text})');
    // The ask is input of the turn it entered: read_context lists it, and it is sent once.
    const context = await callWorkflow('read_context', {}, turnOf(h, 'dev').env) as { member: { messages: Array<Record<string, unknown>> } };
    expect(context.member.messages).toMatchObject([{ from: 'qa', post: ask, ask: true, text: 'Which entry point is public?' }]);
    expect(h.state().mailbox!.messages).toMatchObject([{ post: ask, shownInTurnId: h.state().agents!.find(agent => agent.key === 'dev')!.activeTurnId }]);
    await h.ticks(3);
    expect(heard.dev).toHaveLength(1);

    await callWorkflow('answer', { operationId: 'answer', ask, text: 'parse() only' }, turnOf(h, 'dev').env);
    await h.until(() => expect(heard.qa).toHaveLength(1));
    expect(heard.qa[0]).toContain(`[Answer to your ask ${ask} from dev]\nparse() only`);
    expect(heard.qa[0]).toContain('The answer closed the ask it names.');
    expect(heard.qa[0]).not.toContain('to-do of yours');

    dev.release(); qa.release();
    const { state, result } = await h.settled();
    expect(state.script, state.script?.error).toMatchObject({ status: 'result_ready' });
    // Neither was woken for what its turn had already been shown.
    expect(result).toMatchObject({ stop: 'quiet', turns: 2 });
    expect([...h.order].sort()).toEqual(['dev1', 'qa1']);
    expect(state.mailbox!.messages.map(message => Boolean(message.consumedByTurnId))).toEqual([true, true]);
    expect(state.todos?.open ?? []).toEqual([]);
    expect(h.errors).toEqual([]);
  });

  it('leaves an ask its turn did not answer as a to-do of the next, without the message a second time, and names in a brief the answers the last turn was shown', async () => {
    const ahead = clock();
    const dev = gate(), qa = gate();
    const heard = { dev: [] as string[], qa: [] as string[] };
    const h = await play(PAIR, {
      dev: [{ hold: dev.hold, heard: heard.dev }, { answer: 'parse() only' }],
      qa: [{ ask: { to: 'dev', text: 'Which entry point is public?' }, hold: qa.hold, heard: heard.qa }, { answer: 'all green' }],
    });
    await h.until(() => expect(heard.dev).toHaveLength(1));
    const ask = h.state().board!.asks![0]!.seq;
    dev.release();
    // The turn ended on the ask it was shown: the to-do wakes dev, whose messages do not hold the ask again.
    await h.until(() => expect(heard.qa).toHaveLength(1));
    expect(h.turns('dev')).toEqual(['dev1', 'dev2']);
    expect(h.prompts('dev')[1]).toContain('1 to-do waits on you; deal with it before other work:');
    expect(h.prompts('dev')[1]).toContain(`Ask ${ask} from qa: "Which entry point is public?"`);
    expect(h.prompts('dev')[1]).toContain('"messages":[]');
    expect(h.prompts('dev')[1]).not.toContain('Answered while your last turn ran');

    // The answer entered the turn qa was in, and so does an ask the main agent makes of qa. That turn ends on the ask,
    // so the to-do wakes qa, and the brief of that turn names the answer the last one was shown.
    const answer = h.state().board!.posts.at(-1)!.seq;
    ahead.by(5_000);
    await h.asMain('ask', { to: 'qa', text: 'Is the suite green?' });
    await h.until(() => expect(heard.qa).toHaveLength(2));
    expect(heard.qa[1]).toContain('from the main agent, which waits 15 min]\nIs the suite green?');
    qa.release();
    const { state, result } = await h.settled();
    expect(result).toMatchObject({ stop: 'quiet' });
    expect(h.turns('qa')).toEqual(['qa1', 'qa2']);
    expect(h.prompts('qa')[1]).toContain(`Answered while your last turn ran: your ask ${ask} by dev (post ${answer}).`);
    expect(h.prompts('qa')[1]).toContain('"messages":[]');
    expect(state.todos?.open ?? []).toEqual([]);
    expect(h.errors).toEqual([]);
  });

  it('puts at most four into a turn at once, waits before the next, stops at sixteen in one turn, and leaves the rest for the next turn', async () => {
    const ahead = clock();
    const dev = gate();
    const heard: string[] = [];
    const asks = (who: string) => Array.from({ length: 8 }, (_, n): [string, Record<string, unknown>] => ['ask', { to: 'dev', text: `${who} question ${n + 1}` }]);
    const h = await play('return await swarm("Ship the parser", {key:"ship", maxTurns: 4, members:[{name:"dev"},{name:"qa"},{name:"ops"}]});', {
      dev: [{ hold: dev.hold, heard }, {}], qa: [{ calls: asks('qa') }], ops: [{ calls: asks('ops') }],
    });
    await h.until(() => expect(h.state().board?.asks ?? []).toHaveLength(16));
    await h.asMain('ask', { to: 'dev', text: 'main question 1' });
    await h.asMain('ask', { to: 'dev', text: 'main question 2' });
    for (let round = 1; round <= 4; round++) {
      await h.until(() => expect(heard).toHaveLength(round));
      expect(heard[round - 1]!.match(/^\[Ask \d+ from /gm)).toHaveLength(4);
      // Within the gap nothing more is sent, however often the scheduler passes.
      await h.ticks(3);
      expect(heard).toHaveLength(round);
      ahead.by(5_000);
    }
    await h.ticks(3);
    expect(heard).toHaveLength(4);
    const box = () => h.state().mailbox!.messages;
    expect(box().filter(message => message.shownInTurnId)).toHaveLength(16);
    expect(heard.join('\n')).not.toContain('main question');

    // The two the turn had no room for are unread when it ends, and reach dev in the messages of its next turn.
    dev.release();
    await h.until(() => expect(h.turns('dev')).toEqual(['dev1', 'dev2']));
    expect(h.prompts('dev')[1]).toContain('"text":"main question 1"');
    expect(h.prompts('dev')[1]).toContain('"text":"main question 2"');
    expect(h.prompts('dev')[1]).not.toContain('"text":"qa question 1"');
    await h.cancel();
  });

  it('does not count as shown what the harness gave no receipt for, and offers that turn nothing more', async () => {
    const ahead = clock();
    const dev = gate();
    const heard: string[] = [];
    const h = await play(PAIR, {
      dev: [{ hold: dev.hold, heard, receipt: 'unknown' }, { answer: 'parse() only' }],
      qa: [{ calls: [['ask', { to: 'dev', text: 'Which entry point is public?' }], ['ask', { to: 'dev', text: 'And which one is deprecated?' }]] }, {}],
    });
    await h.until(() => expect(heard).toHaveLength(1));
    ahead.by(5_000);
    await h.ticks(3);
    expect(heard).toHaveLength(1);
    expect(h.state().mailbox!.messages.filter(message => message.shownInTurnId)).toEqual([]);
    // Whether or not the words arrived, the asks are in the messages of the next turn.
    dev.release();
    const { state, result } = await h.settled();
    expect(result).toMatchObject({ stop: 'quiet' });
    expect(h.prompts('dev')[1]).toContain('Which entry point is public?');
    expect(h.prompts('dev')[1]).toContain('And which one is deprecated?');
    expect(state.todos?.open ?? []).toEqual([]);
    expect(h.errors).toEqual([]);
  });

  it('starts the members on the items the lead adds, hands it their results in one brief and ends on its verdict', async () => {
    const h = await play('return await swarm("Fix two modules", {key:"fix", maxTurns: 6, lead:{name:"lead", role:"Assign and judge"}, members:[{name:"parser", harness:"custom-agent", model:"m2"},{name:"docs"}]});', {
      lead: (turn, state) => turn === 1 ? { calls: [['set_status', { text: 'Two modules to fix; nothing tried yet.' }], ['note', { text: 'Ruling: tests before fixes', topic: 'announce' }],
          ['enqueue_work', { key: 'a', title: 'Fix the parser', input: 'src/parser', assignee: 'parser' }], ['enqueue_work', { key: 'b', title: 'Fix the docs', input: 'docs/', assignee: 'docs' }]] }
        : state.workQueue!.items.every(item => item.status === 'completed') ? { calls: [['resolve_post', { seq: [1, 2], note: 'Both fixed; the ruling is withdrawn' }], ['swarm_finish', { result: 'parser and docs fixed' }]] } : {},
      // What only a lead may do is refused to a member that does the work.
      parser: [{ work: true, calls: [['note', { text: 'Ruling: mine', topic: 'announce' }], ['resolve_post', { seq: 1, note: 'read it' }], ['swarm_finish', { result: 'not mine to call' }], ['set_status', { text: 'mine' }], ['set_goal', { text: 'mine' }]] }],
      docs: [{ work: true }],
    });
    const { state, result } = await h.settled();
    expect(result, state.script?.error).toMatchObject({ stop: 'finished', result: 'parser and docs fixed', members: [
      { name: 'lead', lead: true }, { name: 'parser', queue: 'default' }, { name: 'docs', queue: 'default', model: 'm1' }] });
    expect(h.errors).toEqual([expect.stringContaining('Topic "announce" is for rules and rulings'), expect.stringContaining('Post 1 is neither yours nor addressed to you by name'),
      expect.stringContaining('Only the lead of a swarm can manage it'), expect.stringContaining('A status is written by the lead'), expect.stringContaining('set_goal (a main agent operation)')]);
    // The lead is told its part and nothing of operations that no longer exist; a member that does the work starts
    // with the items of its queue, the status of the lead above it and the rulings made so far.
    const lead = h.prompts('lead');
    for (const text of ['You are the lead. You turn the goal into work for the members', 'set_status', 'swarm_finish', 'This is your first turn.', 'Start now: write your status, then hand out the first work.']) expect(lead[0], text).toContain(text);
    for (const text of ['post_board', 'set_charter', 'handoff', 'The charter']) expect(lead[0], text).not.toContain(text);
    const docs = h.prompts('docs')[0]!;
    for (const text of ['You do the work of queue "default"', 'you can claim', 'How the work stands, by @lead', 'Two modules to fix; nothing tried yet.', 'New rulings, which bind you:', '(lead, post 2) Ruling: tests before fixes',
      'above you: ', '@lead (lead of the swarm), then the main agent']) expect(docs.replace('One you leave open goes to whoever stands above you: ', 'above you: '), text).toContain(text);
    expect(docs).not.toContain('set_status({operationId,text})');
    // Both results come back in the brief of one turn of the lead, and nothing was posted for them.
    const judged = lead.find(prompt => prompt.includes('came back since your last turn'))!;
    expect(judged).toContain('2 results came back since your last turn (2 completed, 0 failed)');
    expect(judged).toMatch(/- completed "a" \(parser\): Fix the parser\n {2}Result: parser/);
    expect(judged).toContain('Your status, as you last wrote it');
    expect(state.board!.posts.map(post => post.topic ?? 'general')).toEqual(['general', 'announce']);
    expect(state.board!.posts.map(post => post.resolved?.note)).toEqual(['Both fixed; the ruling is withdrawn', 'Both fixed; the ruling is withdrawn']);
    // What the script gets is the feed as posted: a replay must return the same.
    expect(posts(result)).toEqual([['script', []], ['lead', []]]);
    expect(result.posts.some((post: object) => 'resolved' in post)).toBe(false);
    expect(state.statuses).toMatchObject({ lead: { text: 'Two modules to fix; nothing tried yet.', version: 1 } });
    expect(state.swarms![0]!.results ?? []).toEqual([]);
  });

  it('makes a member that failed and stopped a to-do of the lead, which revives, replaces or gives it up', async () => {
    const h = await play('return await swarm("Fix three modules", {key:"fix", maxTurns: 6, lead:{name:"lead"}, members:[{name:"parser", harness:"custom-agent", model:"m2"},{name:"docs"}]});', {
      lead: (turn, state) => turn === 1 ? { calls: [['enqueue_work', { key: 'a', title: 'Fix the parser', input: 1, assignee: 'parser' }], ['enqueue_work', { key: 'b', title: 'Fix the docs', input: 2, assignee: 'docs' }]] }
        : !state.swarms![0]!.members.some(member => member.name === 'lexer') ? (state.swarms![0]!.members.find(member => member.name === 'docs')!.stopped ? { calls: [
            ['staff_swarm', { add: ['lexer'], role: 'Own src/lexer/**', brief: 'Same empty-input bug as the parser', like: 'parser' }], ['staff_swarm', { retire: ['docs'] }],
            ['enqueue_work', { key: 'c', title: 'Fix the lexer', input: 3, assignee: 'lexer' }]] } : {})
        : state.workQueue!.items.every(item => item.status === 'completed') ? { call: ['swarm_finish', { result: 'parser and lexer fixed; docs dropped' }] } : {},
      parser: [{ work: true }, { work: true }, { work: true }],
      // A failed turn is retried once in the member's session before the member stops.
      docs: [{ fail: true }, { fail: true }],
      lexer: [{ work: true }],
    });
    const { state, result } = await h.settled();
    expect(h.errors).toEqual([]);
    expect(result, state.script?.error).toMatchObject({ stop: 'finished', result: 'parser and lexer fixed; docs dropped', members: [
      { name: 'lead', lead: true }, { name: 'parser' }, { name: 'docs', status: 'retired' }, { name: 'lexer', added: true }] });
    expect(h.turns('docs')).toEqual(['docs1', 'docs2']);
    // The turn that dealt with it was told what happened and what it can do; once docs was given up nothing waits any more.
    const told = h.prompts('lead').find(prompt => prompt.includes('failed and has stopped'))!;
    expect(told).toContain('Member "docs" of queue "default" failed and has stopped: model refused. An item it had claimed is back in its queue.');
    expect(told).toContain('staff_swarm({revive: ["docs"]}) lets it retry its last turn in the session it had, replace gives it a new session under its name when the session is what fails, add brings another member, and retire gives it up');
    expect(state.todos?.open ?? []).toEqual([]);
    expect(h.notices('todo')).toEqual([]);
    // The item that was for docs went to the rest of its queue once docs could not take it.
    expect(state.workQueue!.items.find(item => item.key === 'b')).toMatchObject({ status: 'completed', result: 'parser' });
    expect(h.specs.find(spec => /You are member "lexer"/.test(spec.prompt))).toMatchObject({
      prompt: expect.stringContaining('Same empty-input bug as the parser'), execution: { modelSettings: { model: 'm2' } } });
  });

  it('gives a member whose session fails a new session under its name, which starts from what the old one left and from what waits on the name', async () => {
    const h = await play('return await swarm("Fix two modules", {key:"fix", maxTurns: 6, lead:{name:"lead"}, members:[{name:"parser"},{name:"docs"}]});', {
      lead: (turn, state) => {
        const docs = state.swarms![0]!.members.find(member => member.name === 'docs')!;
        // Before docs has had a turn there is no session to replace, and a lead in its turn cannot replace its own.
        if (turn === 1) return { calls: [['staff_swarm', { replace: ['docs'] }], ['staff_swarm', { replace: ['lead'] }],
          ['enqueue_work', { key: 'a', title: 'Fix the parser', input: 1, assignee: 'parser' }], ['enqueue_work', { key: 'b', title: 'Fix the docs', input: 2, assignee: 'docs' }]] };
        if (docs.stopped) return { calls: [['staff_swarm', { replace: ['docs'], brief: 'The session refused every request. Headings are ATX.' }]] };
        const asked = state.board?.asks?.find(ask => ask.to === state.agents!.find(agent => agent.key === 'lead')!.agentId);
        return asked ? { calls: [['answer', { ask: asked.seq, text: 'Both fixed' }], ['swarm_finish', { result: 'parser and docs fixed' }]] } : {};
      },
      // Once its first ask is answered, which the new session does, parser makes a second one of it.
      parser: (turn, state) => turn === 1 ? { work: true, ask: { to: 'docs', text: 'Which heading style?' } }
        : state.swarms![0]!.members.find(member => member.name === 'docs')!.sessions === 2 && !state.board?.asks?.length && !state.board!.posts.some(post => post.text === 'And the footer?')
          ? { ask: { to: 'docs', text: 'And the footer?' } } : {},
      // The ask wakes docs for a turn that fails, and fails again when it is retried in the same session.
      docs: [{ work: true, calls: [['checkpoint', { expectedCheckpointVersion: 0, state: { done: ['docs/'] } }]] }, { fail: true }, { fail: true }, { answer: 'ATX' }, { answer: 'None' }],
    });
    await h.until(() => { expect(h.turns('docs')).toHaveLength(5); expect(h.turns('parser')).toHaveLength(3); });
    await h.calm();
    // The lead has been told all there is to tell it; the main agent's ask wakes it to close the swarm.
    await h.asMain('ask', { to: 'lead', text: 'Is it done?' });
    const { state, result } = await h.settled();
    expect(result, state.script?.error).toMatchObject({ stop: 'finished', result: 'parser and docs fixed', members: [
      { name: 'lead', lead: true }, { name: 'parser' }, { name: 'docs', status: 'idle', turns: 3, sessions: 2 }] });
    expect(h.errors).toEqual([expect.stringContaining('Member docs has not had a turn yet, so it has no session to replace'),
      expect.stringContaining('Member lead is in a turn; its session is replaced once the turn has ended')]);
    expect(h.results).toContainEqual(expect.objectContaining({ swarm: 'fix', replaced: ['docs'] }));
    expect(h.turns('docs')).toEqual(['docs1', 'docs2', 'docs3', 'docs4', 'docs5']);
    const told = h.prompts('lead').find(prompt => prompt.includes('failed and has stopped'))!;
    expect(told).toContain('replace gives it a new session under its name when the session is what fails');

    // The retry resumed the session that failed; the turn after the replacement resumes nothing, and the one after that the new session.
    const runs = h.specs.filter(spec => (spec.resume?.id ?? 'docs').startsWith('docs') && (spec.resume || spec.prompt.includes('You are member "docs"')));
    expect(runs.map(spec => spec.resume?.id)).toEqual([undefined, 'docs', 'docs', undefined, 'docs#2']);
    expect(state.sessions.find(session => session.actorKey === 'docs')).toMatchObject({ generation: 2, nativeSessionId: 'docs#2' });

    // The new session is told who it is as on a first turn, and what the session before it left behind.
    const first = runs[3]!.prompt;
    for (const text of ['You are member "docs" of swarm "fix".', 'You do the work of queue "default"',
      'This is the first turn of a new session: lead replaced the session that was "docs" before you, which had failed (model refused). Nothing that session had in mind is in front of you. What it left:',
      '- The note it ended its last finished turn with: docs turn 1', '- The checkpoint it saved, in the member context below.',
      '- From lead, for you:\nThe session refused every request. Headings are ATX.',
      'What is addressed to "docs" is yours as before: its messages, the asks made of it, its to-dos and the items kept for it.',
      'Start by finding out where the work stands, then go on with it.']) expect(first, text).toContain(text);
    expect(first).not.toContain('This is your first turn.');
    // What waited on the name waits on the new session: the ask as a to-do, its message, which the failed turn had
    // taken and not consumed, and the checkpoint.
    const ask = state.board!.posts.find(post => post.text === 'Which heading style?')!.seq;
    expect(first).toContain('1 to-do waits on you; deal with it before other work:');
    expect(first).toContain(`Ask ${ask} from parser: "Which heading style?"`);
    expect(first).toContain('"text":"Which heading style?"');
    expect(first).toContain('"state":{"done":["docs/"]}');
    // The turn after it is an ordinary one of the member, which is told nothing of the replacement again.
    expect(h.prompts('docs')[4]).toContain('wake-up 3 of at most 6');
    expect(h.prompts('docs')[4]).not.toContain('new session');
    // The failed turn was given up: it is no call of the run, and nothing it was handed stays with it.
    const given = state.tasks.filter(task => task.agentId === state.agents!.find(agent => agent.key === 'docs')!.agentId && task.status === 'failed');
    expect(given).toHaveLength(1);
    expect(state.script!.calls.some(call => call.taskId === given[0]!.taskId)).toBe(false);
    expect(state.mailbox!.messages.filter(message => message.consumedByTurnId === given[0]!.taskId)).toEqual([]);
    expect(state.todos?.open ?? []).toEqual([]);
  });

  it('lets the main agent replace the session of a member between its turns, whether it failed, is idle or was retired, and replays without running a turn again', async () => {
    const qa = gate();
    const h = await play('return await swarm("Ship the parser", {key:"ship", maxTurns: 3, members:[{name:"dev", role:"Implement"},{name:"qa", role:"Verify"}]});', {
      dev: [{}, { fail: true }, { fail: true }, { answer: 'Parser done' }, {}],
      qa: [{ hold: qa.hold }],
    });
    const staff = (args: Record<string, unknown>) => h.asMain('staff_swarm', args);
    const member = () => h.state().swarms![0]!.members.find(item => item.name === 'dev')!;
    await h.calm();
    expect(h.turns('dev')).toEqual(['dev1']);
    // What cannot be replaced, and what replace cannot be combined with.
    await expect(staff({ replace: ['qa'] })).rejects.toThrow('Member qa is in a turn; its session is replaced once the turn has ended');
    await expect(staff({ replace: ['nobody'] })).rejects.toThrow('Unknown swarm member: nobody');
    await expect(staff({ replace: [] })).rejects.toThrow('replace is an array of member names');
    await expect(staff({ replace: ['dev', 'dev'] })).rejects.toThrow('Member names must be unique');
    await expect(staff({ replace: ['dev'], add: ['dev2'], brief: 'For whom?' })).rejects.toThrow('make the two changes one after the other');
    expect(member()).not.toHaveProperty('takeover');

    // The main agent's ask wakes dev for a turn that fails twice; dev stops, and the main agent is told what it can do.
    await h.asMain('ask', { to: 'dev', text: 'Is the parser done?' });
    await h.until(() => expect(member().stopped).toBe('failed'));
    expect(h.turns('dev')).toEqual(['dev1', 'dev2', 'dev3']);
    expect(await staff({ replace: ['dev'] })).toMatchObject({ swarm: 'ship', replaced: ['dev'] });
    await h.until(() => expect(h.turns('dev')).toHaveLength(4));
    await h.calm();
    const failed = h.prompts('dev')[3]!;
    expect(failed).toContain('This is the first turn of a new session: the main agent replaced the session that was "dev" before you, which had failed (model refused).');
    expect(failed).toContain('- The note it ended its last finished turn with: dev turn 1');
    expect(failed).not.toContain('for you:');
    expect(failed).not.toContain('The checkpoint it saved');
    expect(failed).toContain('from the main agent: "Is the parser done?"');
    expect(failed).toContain('"text":"Is the parser done?"');
    expect(h.state().board?.asks ?? []).toEqual([]);
    expect(member()).toMatchObject({ turns: 2, sessions: 2 });
    expect(member()).not.toHaveProperty('takeover');

    // A member that is idle is replaced the same way, say when its session is full; it starts at once, as a member
    // of a swarm without a lead does, with the note of the turn that just ended.
    expect(await staff({ replace: ['dev'], brief: 'Your context was full.' })).toMatchObject({ swarm: 'ship', replaced: ['dev'] });
    await h.until(() => expect(h.turns('dev')).toHaveLength(5));
    await h.calm();
    const idle = h.prompts('dev')[4]!;
    expect(idle).toContain('This is the first turn of a new session: the main agent replaced the session that was "dev" before you. Nothing that session had in mind');
    expect(idle).toContain('- The note it ended its last finished turn with: dev turn 4');
    expect(idle).toContain('- From the main agent, for you:\nYour context was full.');
    expect(h.specs.filter(spec => spec.prompt.includes('You are member "dev"')).map(spec => spec.resume)).toEqual([undefined, undefined, undefined]);
    expect(h.state().sessions.find(session => session.actorKey === 'dev')).toMatchObject({ generation: 3, nativeSessionId: 'dev#3' });

    // Its wake-ups are used up, the first turns of the new sessions among them: another session would never start.
    expect(member()).toMatchObject({ turns: 3, sessions: 3 });
    await expect(staff({ replace: ['dev'] })).rejects.toThrow('Member dev has no wake-ups left (maxTurns is 3), so a new session would never start; raise maxTurns in the same call');
    // A member that was retired comes back under its name, once it has turns to take.
    await staff({ retire: ['dev'] });
    expect(await staff({ replace: ['dev'], maxTurns: 4 })).toMatchObject({ replaced: ['dev'], maxTurns: 4 });
    await h.until(() => expect(h.turns('dev')).toHaveLength(6));
    expect(h.prompts('dev')[5]).toContain('replaced the session that was "dev" before you, which had been retired.');
    await h.calm();

    qa.release();
    const { state, result } = await h.settled();
    expect(result, state.script?.error).toMatchObject({ stop: 'quiet', members: [{ name: 'dev', turns: 4, sessions: 4, status: 'max_turns' }, { name: 'qa', turns: 0 }] });
    expect(h.errors).toEqual([]);
    // A replay rejoins the swarm from its records: the turn that was given up is not retried, and nobody runs again.
    const turns = h.specs.length;
    const again = h.runtime.bindMain(h.root.scopeId, 'continue');
    await callWorkflow('replay_script', { operationId: randomUUID(), workflowId: state.workflowId, expectedStateVersion: state.stateVersion }, again.env);
    again.release();
    const replayed = await h.settled();
    expect(replayed.state.script, replayed.state.script?.error).toMatchObject({ status: 'result_ready', revision: 1 });
    expect(replayed.result).toEqual(result);
    expect(h.specs).toHaveLength(turns);
  });

  it('does not take a to-do over a lead that has been in one turn since before it came up, until twice its time has passed', async () => {
    const ahead = clock();
    const lead = gate();
    const h = await play('await enqueueWork({key:"x", title:"X", input:1}); return await swarm("Long turn", {key:"long-turn", lead:{name:"lead"}, members:[{name:"dev"}]});',
      { lead: [{ hold: lead.hold }, { call: ['swarm_finish', { result: 'nobody left to do it' }] }], dev: [{ fail: true }, { fail: true }] });
    await h.until(() => expect(h.todos('member')).toMatchObject([{ told: [{ who: 'lead' }] }]));
    // The member's time is up, but the lead's turn began before the to-do came up: it has not been told of it yet,
    // so it has not left it open, and the main agent is not told in its place.
    await h.calm(); ahead.by(16 * MIN);
    await h.ticks(4);
    expect(h.todos('member')).toMatchObject([{ told: [{ who: 'lead' }] }]);
    expect(h.notices('todo')).toEqual([]);
    // A turn that goes on that long keeps nothing back for good: at twice the time the to-do goes up all the same.
    await h.calm(); ahead.by(15 * MIN);
    await h.until(() => expect(h.notices('todo')).toHaveLength(1));
    expect(h.todos('member')).toMatchObject([{ told: [{ who: 'lead' }, { who: 'main' }] }]);
    expect(h.notices('todo')[0]!.summary).toMatch(/^待办 #\d+，已 31 分钟（lead 未处理，上报到你）：swarm "long-turn" 的成员 dev 失败并已停止/);
    // The lead ends the swarm with the to-do open. Once the script is over nothing holds any more: the table is
    // emptied and the main agent's notice settled, instead of staying on its list for good.
    // (A turn that says nothing for half an hour is taken for one that has hung and is run again after a pause.)
    lead.release();
    for (let step = 0; step < 5 && h.state().script!.status === 'running'; step++) { await h.ticks(5); ahead.by(MIN); }
    await h.settled();
    await h.until(() => { expect(h.state().todos?.open ?? []).toEqual([]); expect(h.notices('todo')).toMatchObject([{ acknowledged: true }]); });
    expect(h.state().script!.status).toMatch(/result_ready|failed/);
  }, 30_000);

  it('changes nothing on a pass when nothing has changed: what waits on someone is told once, not at every pass', async () => {
    const ahead = clock();
    // Every kind of thing that waits at once: a gate nobody settles, an item behind it, a queue with nothing to claim,
    // a member that failed, a queue nobody is left to work, an item set aside, and an ask its reader leaves open.
    const h = await play([
      'await enqueueWork({key:"go", title:"Go", input:{}, queue:"q", gate:true});',
      'await enqueueWork({key:"after", title:"After", input:1, queue:"q", dependsOn:["go"]});',
      'await enqueueWork({key:"x", title:"X", input:2, queue:"r"});',
      'await enqueueWork({key:"kept", title:"Kept", input:3, queue:"q"});',
      'return await swarm("Stand still", {key:"still", lead:{name:"lead"}, members:[{name:"w1", queue:"q"},{name:"bad", queue:"r"}]});',
    ].join('\n'), {
      lead: [{ calls: [['update_work', { key: 'kept', hold: true, reason: 'until the format is decided' }]], ask: { to: 'w1', text: 'Which format?' } }],
      bad: [{ fail: true }, { fail: true }],
    });
    /** Passes that find nothing to do leave the state as it is: no event, no turn, no notice. */
    const still = async () => {
      await h.calm();
      await h.ticks(3);
      const before = { version: h.state().stateVersion, turns: h.order.length, notices: h.state().events.length, todos: JSON.stringify(h.state().todos) };
      await h.ticks(12);
      expect({ version: h.state().stateVersion, turns: h.order.length, notices: h.state().events.length, todos: JSON.stringify(h.state().todos) }).toEqual(before);
    };
    const held = () => Object.fromEntries(h.todos().filter(todo => todo.told.length).map(todo => [todo.kind, todo.told.at(-1)!.who]));
    await h.until(() => expect(held()).toMatchObject({ ask: 'w1', member: 'lead' }));
    await still();
    // Past the grace times, and the hour after which an item set aside is asked about.
    await h.calm(); ahead.by(61 * MIN);
    await h.until(() => expect(Object.keys(held()).sort()).toEqual(['aside', 'ask', 'dry', 'gate', 'member', 'unstaffed']));
    await still();
    // Left open by everyone, all of it reaches the main agent, which has one notice for each. The lead's own ask goes
    // no further up than the lead.
    const top = { ask: 'lead', aside: 'main', dry: 'main', gate: 'main', member: 'main', unstaffed: 'main' };
    for (let hop = 0; hop < 4 && JSON.stringify(held()) !== JSON.stringify(top); hop++) { await h.calm(); ahead.by(61 * MIN); await h.ticks(6); }
    await h.until(() => expect(held()).toEqual(top));
    await still();
    const open = h.notices('todo').filter(notice => !notice.acknowledged);
    expect(open.map(notice => notice.subject).sort()).toEqual(h.todos().filter(todo => todo.told.at(-1)?.who === 'main').map(todo => `todo:${todo.id}`).sort());
    expect(open).toHaveLength(5);
    expect(h.errors).toEqual([]);
    await h.cancel();
  }, 60_000);

  it('lets the main agent add members on another model, which a lead cannot, and lets the lead make rulings', async () => {
    const lead = gate();
    const h = await play('await enqueueWork({key:"x", title:"X", input:1}); return await swarm("Prove and build", {key:"crew", lead:{name:"lead"}, members:[{name:"dev", reasoningEffort:"low"}]});', {
      lead: (turn, state) => turn === 1 ? { hold: lead.hold }
        : state.workQueue!.items.every(item => item.status === 'completed') ? { calls: [['staff_swarm', { add: ['thief'], model: 'big' }], ['note', { text: 'Ruling: proofs come first', topic: 'announce' }], ['swarm_finish', { result: 'staffed' }]] } : {},
      dev: [{ work: true, calls: [['note', { text: 'Ruling: mine', topic: 'announce' }]] }],
      prover: [{ work: true }], dev2: [{ work: true }],
    });
    const staff = (args: Record<string, unknown>) => h.asMain('staff_swarm', args);
    await h.until(() => expect(h.order).toEqual(expect.arrayContaining(['lead1', 'dev1'])));

    await expect(staff({ model: 'big' })).rejects.toThrow('bind the members that add names');
    await expect(staff({ add: ['x'], model: 'default' })).rejects.toThrow('explicit nonempty model');
    await expect(staff({ add: ['x'], harness: 'other-agent' })).rejects.toThrow('cross-harness');
    // What is not named comes from the member the newcomers are bound like: dev runs at low effort and consumes "default".
    expect(await staff({ add: ['prover'], model: 'big', reasoningEffort: 'high', brief: 'Prove the reduction sound' })).toMatchObject({
      added: ['prover'], execution: { agentKind: 'custom-agent', model: 'big', reasoningEffort: 'high' } });
    expect(await staff({ add: ['checker'], model: 'big' })).toMatchObject({ execution: { model: 'big', reasoningEffort: 'low' } });
    expect(await staff({ add: ['dev2'] })).not.toHaveProperty('execution');
    // A member that does the work starts with its first item, not when it is added.
    await h.ticks(3);
    expect(h.order).not.toEqual(expect.arrayContaining(['prover1']));
    await h.asMain('enqueue_work', { key: 'proof', title: 'Prove it', input: 1, assignee: 'prover' });
    await h.asMain('enqueue_work', { key: 'build', title: 'Build it', input: 1, assignee: 'dev2' });
    await h.until(() => expect(h.order).toEqual(expect.arrayContaining(['prover1', 'dev21'])));
    lead.release();

    const { state, result } = await h.settled();
    expect(result, state.script?.error).toMatchObject({ stop: 'finished', result: 'staffed' });
    // Only the members bound unlike the usual one show their model.
    expect(result.members).toMatchObject([{ name: 'lead' }, { name: 'dev' }, { name: 'prover', added: true, model: 'big', queue: 'default' }, { name: 'checker', model: 'big' }, { name: 'dev2', added: true }]);
    expect(result.members[1]).not.toHaveProperty('model');
    expect(result.members[4]).not.toHaveProperty('model');
    expect(h.specs.find(spec => /You are member "prover"/.test(spec.prompt))).toMatchObject({
      prompt: expect.stringContaining('Prove the reduction sound'), execution: { modelSettings: { model: 'big', reasoningEffort: 'high' } } });
    expect(h.specs.find(spec => /You are member "dev2"/.test(spec.prompt))).toMatchObject({ execution: { modelSettings: { model: 'm1', reasoningEffort: 'low' } } });
    expect(h.errors).toEqual([expect.stringContaining('Topic "announce" is for rules and rulings'), expect.stringContaining('Only the main agent can choose the harness or model')]);
    expect(state.swarms![0]!.members.map(member => member.name)).not.toContain('thief');
    expect(state.board!.posts.find(post => post.topic === 'announce')).toMatchObject({ text: 'Ruling: proofs come first' });
  });

  it('tells the lead of a queue that has run dry, takes it to the main agent when the lead leaves it, and of an idle swarm once the queue is answered for', async () => {
    const ahead = clock();
    const dev = gate();
    const h = await play('return await swarm("Idle", {key:"idle", lead:{name:"lead"}, members:[{name:"dev"}]});', { lead: [], dev: [{ claim: true, hold: dev.hold, complete: true }] });
    await h.until(() => expect(h.order).toEqual(['lead1']));
    // A queue that has only just run dry is told to nobody: its lead may be about to fill it. Idle members wake nobody.
    await h.ticks(4);
    expect(h.order).toEqual(['lead1']);
    expect(h.todos()).toMatchObject([{ kind: 'dry', subject: expect.stringMatching(/^dry:.*:default$/), told: [] }]);
    await h.calm(); ahead.by(2 * MIN + 1000);
    await h.until(() => expect(h.order).toEqual(['lead1', 'lead2']));
    const brief = h.prompts('lead')[1]!;
    expect(brief).toMatch(/^.*Swarm "idle", wake-up 1\. You are lead, the lead; above you: the main agent\.\n1 to-do waits on you; deal with it before other work:\n- #1 \(2 min\) Queue "default" has run dry: 1 of its 1 members are idle and it has no item they can claim\./m);
    for (const text of ['add that with enqueue_work', 'If there is nothing, do not make any up: defer_todo says that the queue has no work for now', 'When the goal is met or cannot progress, end the swarm with swarm_finish instead.',
      'Queue "default" has nothing you can claim now.'.replace('Queue "default" has nothing you can claim now.', 'Queues now: "default" 0 claimable')]) expect(brief, text).toContain(text);
    // The lead ends its turn without dealing with it. It is not told again while it holds the to-do, and the main
    // agent hears of it only once the lead has had its time.
    await h.calm(); ahead.by(19 * MIN);
    await h.ticks(4);
    expect(h.order).toEqual(['lead1', 'lead2']);
    expect(h.notices('todo')).toEqual([]);
    await h.calm(); ahead.by(2 * MIN);
    await h.until(() => expect(h.notices('todo')).toHaveLength(1));
    expect(h.notices('todo')[0]).toMatchObject({ acknowledged: false, subject: 'todo:1', summary: expect.stringMatching(/^待办 #1，已 2\d 分钟（lead 未处理，上报到你）：swarm "idle" 的队列 default 断粮：1 名成员中 1 名空闲，没有可领工作项/) });
    expect(h.order).toEqual(['lead1', 'lead2']);
    const main = h.runtime.bindMain(h.root.scopeId, 'continue'); cleanup.push(async () => main.release());
    type Status = { todos: Array<Record<string, unknown>>; swarms: Array<{ queues: Record<string, Record<string, unknown>> }> };
    expect(await callWorkflow('status', { workflowId: h.state().workflowId }, main.env)).toMatchObject({ todos: [{ id: 1, kind: 'dry', holder: 'main', leftOpenBy: ['lead'] }],
      swarms: [{ queues: { default: { claimable: 0, blocked: 0, members: 1, running: 0, idle: 1 } } }] });

    // The main agent says that the queue has no work for now: nothing more is said of it, and what is left to say
    // is that nobody in the swarm has anything to do, which is the lead's to settle first.
    await expect(h.asMain('defer_todo', { id: 1 })).rejects.toThrow('note');
    expect(await h.asMain('defer_todo', { id: 1, note: 'Nothing for this queue until the design is settled' })).toMatchObject({ id: 1, deferred: true, until: 'its cause is gone' });
    expect(h.notices('todo')).toMatchObject([{ acknowledged: true }]);
    await h.until(() => expect(h.order).toEqual(['lead1', 'lead2', 'lead3']));
    expect(h.prompts('lead')[2]).toContain('Nobody in the swarm has anything to do: every member is idle, nothing can be claimed and nothing waits to be decided.');
    expect(h.prompts('lead')[2]).toContain('If it is met or cannot progress, call swarm_finish and say which and what remains.');
    expect(h.prompts('lead')[2]).not.toContain('has run dry');
    await h.calm(); ahead.by(11 * MIN);
    await h.until(() => expect(h.notices('todo')).toHaveLength(2));
    expect(h.notices('todo')[1]).toMatchObject({ acknowledged: false, summary: expect.stringContaining('swarm "idle" 停滞：全体成员空闲') });
    expect((await callWorkflow('status', { workflowId: h.state().workflowId }, main.env) as Status).todos).toMatchObject([
      { id: 1, kind: 'dry', holder: 'main', deferred: { by: 'main', note: 'Nothing for this queue until the design is settled' } }, { kind: 'idle', holder: 'main', leftOpenBy: ['lead'] }]);
    expect(h.state().swarms![0]).toMatchObject({ status: 'running' });
    expect(h.state().script!.status).toBe('running');

    // Work for the queue ends both: the notice is settled without the main agent acknowledging it, and the spell
    // is on the queue's record once it has been over for a while.
    await h.asMain('enqueue_work', { key: 'job', title: 'Job', input: 1 });
    await h.until(() => { expect(h.order).toContain('dev1'); expect(h.notices('todo')).toMatchObject([{ acknowledged: true }, { acknowledged: true }]); });
    expect(h.todos('idle')).toEqual([]);
    await h.calm(); ahead.by(4 * MIN);
    await h.until(() => expect(h.todos()).toEqual([]));
    expect(h.state().swarms![0]!.dry).toMatchObject({ default: { spells: 1 } });
    expect(h.state().swarms![0]!.dry!.default!.ms).toBeGreaterThan(30 * MIN);
    expect(h.errors).toEqual([]);
    dev.release();
    await h.cancel();
  }, 30_000);

  it('does not bound a lead by maxTurns, and gathers the results it is owed while other members work', async () => {
    const ahead = clock();
    const slow = gate();
    const h = await play('return await swarm("Coordinate", {key:"long", maxTurns: 1, lead:{name:"lead"}, members:[{name:"dev"},{name:"slow"}]});', {
      lead: (turn, state) => {
        const done = (key: string) => state.workQueue?.items.find(item => item.key === key)?.status === 'completed';
        return turn === 1 ? { calls: [['enqueue_work', { key: 'one', title: 'One', input: 1, assignee: 'dev' }], ['enqueue_work', { key: 'slow-job', title: 'Long', input: 1, assignee: 'slow' }]] }
          : done('slow-job') ? { call: ['swarm_finish', { result: 'done' }] } : done('one') && !state.workQueue!.items.some(item => item.key === 'two') ? { call: ['enqueue_work', { key: 'two', title: 'Two', input: 2, assignee: 'dev' }] } : {};
      },
      dev: [{ work: true }, { work: true }],
      slow: [{ claim: true, hold: slow.hold, complete: true }],
    });
    await h.until(() => { expect(h.order).toEqual(expect.arrayContaining(['dev1', 'slow1'])); expect(h.state().workQueue!.items.find(item => item.key === 'one')).toMatchObject({ status: 'completed' }); })
    // slow is still working, so the result waits for the lead's gap (three members: 90 seconds) instead of waking it at once.
    await h.ticks(5);
    expect(h.turns('lead')).toEqual(['lead1']);
    expect(h.state().swarms![0]!.results).toMatchObject([{ worker: 'dev' }]);
    await h.calm(); ahead.by(91_000);
    await h.until(() => { expect(h.order).toContain('dev2'); expect(h.state().workQueue!.items.find(item => item.key === 'two')).toMatchObject({ status: 'completed' }); });
    expect(h.prompts('lead')[1]).toContain('1 result came back since your last turn (1 completed, 0 failed)');
    // dev has used its one wake-up; its second result is gathered again while slow works.
    await h.ticks(5);
    expect(h.turns('lead')).toEqual(['lead1', 'lead2']);
    // With nobody else working the lead is woken at once, beyond maxTurns, and it ends the swarm.
    slow.release();
    const { state, result } = await h.settled();
    expect(h.errors).toEqual([]);
    expect(result, state.script?.error).toMatchObject({ stop: 'finished', result: 'done', members: [{ name: 'lead', status: 'idle' }, { name: 'dev', turns: 1, status: 'max_turns' }, { name: 'slow', turns: 0 }] });
    expect(result.members[0].turns).toBeGreaterThanOrEqual(2);
    expect(h.prompts('lead').at(-1)).toMatch(/2 results came back since your last turn|1 result came back since your last turn/);
    expect(h.prompts('dev')[0]).toContain('After this first turn you can be woken at most 1 times.');
    expect(h.prompts('lead')[0]).not.toContain('woken at most');
  }, 30_000);

  it('tells the lead of a dry queue while other members work, with what keeps its pending items back, and lets the main agent hand the to-do back', async () => {
    const ahead = clock();
    const busy = gate();
    // "b" waits on the item "busy" is at, so queue "q" has a pending item and nothing to claim.
    const h = await play([
      'await enqueueWork({key:"job", title:"Job", input:0});',
      'await enqueueWork({key:"b", title:"B", input:1, queue:"q", dependsOn:["job"]});',
      'return await swarm("Drain q", {key:"dry", lead:{name:"lead"}, members:[{name:"w1", queue:"q"},{name:"w2", queue:"q"},{name:"busy"}]});',
    ].join('\n'), {
      lead: (_turn, state) => state.todos?.open.some(todo => todo.told.at(-1)?.by === 'main') && !state.workQueue!.items.some(item => item.key === 'c') ? { call: ['enqueue_work', { key: 'c', title: 'C', input: 2, queue: 'q' }] } : {},
      busy: [{ claim: true, hold: busy.hold, complete: true }], w1: () => ({ work: true }), w2: () => ({ work: true }) });
    await h.until(() => { expect(h.order).toEqual(expect.arrayContaining(['lead1', 'busy1'])); expect(h.todos('dry')).toHaveLength(1); });
    // A queue that has only just run dry is told to nobody: its members may be between two items.
    await h.ticks(3);
    expect(h.todos('dry')).toMatchObject([{ id: 1, told: [] }]);
    expect(h.turns('lead')).toEqual(['lead1']);
    const main = h.runtime.bindMain(h.root.scopeId, 'continue'); cleanup.push(async () => main.release());
    type Status = { todos: unknown[]; swarms: Array<{ queues: Record<string, Record<string, unknown>>; members: unknown[] }>; workQueue: Record<string, unknown> };
    const status = async () => await callWorkflow('status', { workflowId: h.state().workflowId }, main.env) as Status;
    const first = await status();
    expect(first.swarms[0]!.queues).toMatchObject({ q: { claimable: 0, blocked: 1, claimed: 0, members: 2, running: 0, idle: 2 } });
    expect(first.workQueue).toMatchObject({ pending: 1, claimable: 0, blocked: 1 });
    // Nobody has been told of it yet, so it is on nobody's list.
    expect(first.todos).toEqual([]);
    expect(await callWorkflow('work_status', { workflowId: h.state().workflowId, queue: 'q' }, main.env)).toMatchObject({ total: 1, pending: 1, claimable: 0, blocked: 1 });

    await h.calm(); ahead.by(2 * MIN + 1000);
    // The to-do does not wait for the lead's gathering gap, although "busy" is still working.
    await h.until(() => expect(h.turns('lead')).toEqual(['lead1', 'lead2']));
    expect(h.prompts('lead')[1]).toContain('Queue "q" has run dry: 2 of its 2 members are idle and it has no item they can claim (1 pending items cannot be claimed: they wait on other items, resources or attempts, or are kept for one member).');
    // The lead is not told again while it holds it, and the main agent hears of it once the lead has had its time.
    await h.calm(); ahead.by(5 * MIN);
    await h.ticks(3);
    expect(h.turns('lead')).toEqual(['lead1', 'lead2']);
    expect(h.notices('todo')).toEqual([]);
    await h.calm(); ahead.by(16 * MIN);
    await h.until(() => expect(h.notices('todo')).toHaveLength(1));
    expect(h.notices('todo')[0]).toMatchObject({ acknowledged: false, summary: expect.stringContaining('swarm "dry" 的队列 q 断粮：2 名成员中 2 名空闲，没有可领工作项（1 项待领但领不了') });
    expect((await status()).todos).toMatchObject([{ id: 1, kind: 'dry', holder: 'main', leftOpenBy: ['lead'] }]);
    expect(h.turns('lead')).toEqual(['lead1', 'lead2']);

    // The main agent hands it back with what it wants done: its notice is settled and the lead is woken for it.
    await expect(h.asMain('pass_todo', { id: 1, to: 'nobody' })).rejects.toThrow('is not a member that will have another turn');
    expect(await h.asMain('pass_todo', { id: 1, to: 'lead', note: 'Fill q from the backlog' })).toMatchObject({ id: 1, holder: 'lead' });
    expect(h.notices('todo')).toMatchObject([{ acknowledged: true }]);
    await h.until(() => expect(h.state().workQueue!.items.find(item => item.key === 'c')).toMatchObject({ status: 'completed' }));
    expect(h.prompts('lead')[2]).toMatch(/- #1 \(2\d min, handed to you by main: Fill q from the backlog\) Queue "q" has run dry/);
    // What was added did not last: the queue is dry again within the same spell, which stays the lead's and is not told anew.
    await h.until(() => expect(h.todos('dry')).toMatchObject([{ id: 1, told: [{ who: 'lead' }, { who: 'main' }, { who: 'lead', by: 'main' }] }]));
    expect(h.todos('dry')[0]).not.toHaveProperty('goneAt');
    expect(h.errors).toEqual([]);
    const later = await status();
    expect(later.swarms[0]!.queues.q).toMatchObject({ flow: { enqueued: [0, 0, 0, 0, 0, 2], completed: [0, 0, 0, 0, 0, 1] } });
    expect(later.workQueue).toMatchObject({ flow: { enqueued: [0, 0, 0, 0, 0, 3], completed: [0, 0, 0, 0, 0, 1] } });
    expect(later.swarms[0]!.members).toEqual(expect.arrayContaining([expect.objectContaining({ itemsDone: 1 })]));
    expect(later.todos).toMatchObject([{ id: 1, kind: 'dry', holder: 'lead', passedBy: 'main', note: 'Fill q from the backlog' }]);
    busy.release();
    await h.cancel();
  }, 30_000);

  it('lets members add the work they find, once per key, and ends only on the lead\'s verdict', async () => {
    const found = { key: 'bug-lexer-empty', title: 'Lexer drops the last token', input: { repro: 'lex("")' } };
    // A member that names no queue does the work of the default queue, and starts with the first item it can take.
    const h = await play('await enqueueWork({key:"seed", title:"Seed", input:{}, assignee:"builder"}); await enqueueWork({key:"survey", title:"Survey the lexer", input:{}, assignee:"scout"});'
      + 'return await swarm("Fix what you find", {key:"hunt", lead:{name:"lead"}, members:[{name:"builder", queue:"default"}, {name:"scout"}]});', {
      scout: turn => turn === 1 ? { work: true, calls: [['enqueue_work', found], ['enqueue_work', { ...found, title: 'Same bug, reported again' }], ['enqueue_work', { ...found, key: 'elsewhere', queue: 'nobody' }]] } : { work: true },
      builder: () => ({ work: true }),
      lead: (_turn, state) => state.workQueue!.items.length === 3 && state.workQueue!.items.every(item => item.status === 'completed') ? { call: ['swarm_finish', { result: 'seed and the lexer bug are fixed' }] } : {},
    });
    const { state, result } = await h.settled();
    expect(h.errors).toEqual([expect.stringContaining('Unknown work queue')]);
    expect(h.results).toMatchObject([{ key: found.key }, { key: found.key, existing: true }]);
    expect(state.workQueue!.items.map(item => [item.key, item.by, item.status])).toEqual([['seed', undefined, 'completed'], ['survey', undefined, 'completed'], [found.key, 'scout', 'completed']]);
    expect(result, state.script?.error).toMatchObject({ stop: 'finished', result: 'seed and the lexer bug are fixed', queues: { default: { completed: 3, closed: false } } });
    expect(result.members).toMatchObject([{ name: 'lead', lead: true }, { name: 'builder', queue: 'default' }, { name: 'scout', queue: 'default' }]);
  });

  it('fails when the lead fails, and keeps swarm members away from script calls', async () => {
    const failed = await play('return await swarm("Doomed", {key:"doomed", onError:"throw", lead:{name:"lead"}, members:[{name:"dev"}]});', { lead: [{ fail: true }, { fail: true }] });
    expect((await failed.settled()).state.script).toMatchObject({ status: 'failed', error: expect.stringContaining('The lead failed') });
    const soft = await play('const a = await swarm("Doomed", {key:"doomed", lead:{name:"lead"}, members:[{name:"dev"}]}); return {a, b: await agent("x", {key:"k", member:"dev"})};', { lead: [{ fail: true }, { fail: true }] });
    expect((await soft.settled()).state.script).toMatchObject({ status: 'failed', error: expect.stringContaining('scheduled by their swarm') });
  });

  it('mixes, in a swarm without a lead, members that do the work of a queue with members that only answer what they are asked', async () => {
    const h = await play([
      'await enqueueWork({key:"a",title:"A",input:1}); await enqueueWork({key:"b",title:"B",input:2});',
      'const out = swarm("Build and verify", {key:"mix", members:[{name:"builder", queue:"default"},{name:"idle", queue:"default"},{name:"qa", role:"Verify when asked"}]});',
      'await enqueueWork({key:"c",title:"C",input:3}); await closeWorkQueue({key:"closed"});',
      'return await out;',
    ].join('\n'), {
      builder: [{ work: true, ask: { to: 'qa', text: 'Items built, please verify' } }, { work: true }],
      idle: () => ({ work: true }),
      qa: [{}, { answer: 'Verified' }],
    });
    const { state, result } = await h.settled();
    expect(h.errors).toEqual([]);
    expect(state.script, state.script?.error).toMatchObject({ status: 'result_ready' });
    expect(result).toMatchObject({ stop: 'quiet', queues: { default: { completed: 3, closed: true } },
      members: [{ name: 'builder', queue: 'default' }, { name: 'idle', queue: 'default' }, { name: 'qa', turns: 1 }] });
    expect(result.members[2]).not.toHaveProperty('queue');
    expect(state.workQueue!.items.every(item => item.status === 'completed')).toBe(true);
    // Without a lead nobody planned the items, so their outcomes are handed to no one, and nobody answers for a dry queue.
    expect(state.swarms![0]!.results ?? []).toEqual([]);
    expect(state.todos?.open ?? []).toEqual([]);
    // qa only answers: it took its opening turn and one wake-up, and never touched the queue.
    expect(h.turns('qa')).toEqual(['qa1', 'qa2']);
    expect(h.prompts('builder')[0]).toContain('claim_work');
    expect(h.prompts('builder')[0]).toContain('You do the work of queue "default"');
    expect(h.prompts('qa')[0]).not.toContain('claim_work');
    expect(h.prompts('qa')[0]).toContain('You work on the task side by side with the other members');
    expect(h.prompts('builder')[1]).toContain('Verified');
  });

  it('gives every turn the goal in force and the status of the leads above it, tells the leads when the main agent replaces the goal, and wakes nobody for a status', async () => {
    const lead = gate();
    const h = await play('await enqueueWork({key:"x", title:"X", input:1}); return await swarm("Build the parser", {key:"crew", lead:{name:"lead"}, members:[{name:"dev"}]});', {
      lead: (turn, state) => turn === 1 ? { hold: lead.hold }
        : turn === 2 ? { calls: [['read_context', {}], ['set_status', { text: 'Parser first; no reports.' }], ['set_goal', { text: 'mine now' }], ['enqueue_work', { key: 'y', title: 'Y', input: 2 }]] }
        : state.workQueue!.items.every(item => item.status === 'completed') ? { call: ['swarm_finish', { result: 'done' }] } : {},
      dev: [{ work: true, calls: [['set_goal', { text: 'not mine to set' }], ['set_status', { text: 'nor this' }]] }, { work: true }],
    });
    await h.until(() => { expect(h.order).toContain('lead1'); expect(h.errors).toHaveLength(2); expect(h.state().workQueue!.items[0]).toMatchObject({ status: 'completed' }); });
    expect(h.errors).toEqual([expect.stringContaining('set_goal (a main agent operation)'), expect.stringContaining('A status is written by the lead of a running swarm, or of one of its queues')]);
    await expect(h.asMain('set_goal', { text: '   ' })).rejects.toThrow('empty');
    await expect(h.asMain('set_goal', { text: 'x'.repeat(6001) })).rejects.toThrow('at most 6000 characters');
    // The main agent needs no state version; the lead is told by a message, which wakes it once its turn ends.
    expect(await h.asMain('set_goal', { text: 'Match the reference at the same constraints; 1.10x is a floor, not the goal.' })).toMatchObject({ goalVersion: 1, told: ['lead'] });
    const main = h.runtime.bindMain(h.root.scopeId, 'continue'); cleanup.push(async () => main.release());
    lead.release();
    const { state, result } = await h.settled();
    expect(result, state.script?.error).toMatchObject({ stop: 'finished', result: 'done' });
    const [first, second, third] = h.prompts('lead');
    expect(first).not.toContain('Goal in force');
    expect(second).toContain('Goal in force (version 1, set by the main agent; it was replaced since your last turn, so check the work you have in hand against it first)');
    expect(second).toContain('1.10x is a floor, not the goal.');
    expect(second).toContain('The main agent replaced the goal (version 1); your next turns are given it.');
    expect(h.results[0]).toMatchObject({ goal: { version: 1, changed: true } });
    expect(h.results[0]).not.toHaveProperty('statuses');
    expect(h.results[1]).toEqual({ statusVersion: 1 });
    // Only the main agent changes the goal: a lead says how the work on it stands, and that is all it rewrites.
    expect(h.errors[2]).toContain('set_goal (a main agent operation)');
    expect(h.errors).toHaveLength(3);
    expect(third).toContain('Goal in force (version 1, set by the main agent). It is the latest revision of the request above');
    expect(third).toContain('Your status, as you last wrote it (0 min ago; set_status replaces it):\nParser first; no reports.');
    // The member under the lead reads both at its next turn. The status alone did not wake it: the new item did.
    expect(h.turns('dev')).toEqual(['dev1', 'dev2']);
    expect(h.prompts('dev')[0]).not.toContain('How the work stands');
    expect(h.prompts('dev')[1]).toContain('Goal in force (version 1, set by the main agent; it was replaced since your last turn');
    expect(h.prompts('dev')[1]).toContain('How the work stands, by @lead (written 0 min ago):\nParser first; no reports.');
    expect(state.charter).toMatchObject({ version: 1, by: 'main', text: 'Match the reference at the same constraints; 1.10x is a floor, not the goal.' });
    expect(state.statuses).toMatchObject({ lead: { version: 1, text: 'Parser first; no reports.' } });
    expect(await callWorkflow('status', { workflowId: state.workflowId }, main.env)).toMatchObject({ goal: { version: 1, text: expect.stringContaining('1.10x is a floor') }, statuses: { lead: { version: 1, text: 'Parser first; no reports.' } } });
  });

  it('wakes a member when the wake-up it set is due, and keeps the swarm open until then', async () => {
    const ahead = clock();
    const h = await play('return await swarm("Wait for the build", {key:"timed", maxTurns: 3, members:[{name:"dev"},{name:"qa"}]});', {
      dev: [{ calls: [['wake_me', { afterMinutes: 30, note: 'check the build' }]] }, { calls: [['wake_me', { afterMinutes: 5 }], ['wake_me', { afterMinutes: 0 }]] }],
      qa: [{ calls: [['wake_me', { afterMinutes: 0 }], ['wake_me', { afterMinutes: 1441 }], ['wake_me', {}]] }],
    });
    const dev = () => h.state().swarms![0]!.members.find(member => member.name === 'dev')!;
    await h.until(() => { expect(dev().wakeAt).toBeDefined(); expect(h.state().tasks.every(task => task.status === 'result_ready')).toBe(true); });
    // Nobody is asked anything and nobody is working, yet a swarm without a lead does not end while a wake-up is pending.
    await h.ticks(5);
    expect([...h.order].sort()).toEqual(['dev1', 'qa1']);
    expect(h.state().swarms![0]).toMatchObject({ status: 'running' });
    expect(dev()).toMatchObject({ wakeNote: 'check the build' });
    await h.calm(); ahead.by(29 * MIN);
    await h.ticks(5);
    expect(h.order).toHaveLength(2);
    await h.calm(); ahead.by(61_000);
    const { result } = await h.settled();
    expect(h.order).toEqual(expect.arrayContaining(['dev2']));
    expect(h.prompts('dev')[1]).toContain('The wake-up you set with wake_me is due: check the build.');
    // Its second turn set a wake-up and cancelled it, so the swarm went quiet.
    expect(result).toMatchObject({ stop: 'quiet', members: [{ name: 'dev', turns: 1 }, { name: 'qa', turns: 0 }] });
    expect(dev().wakeAt).toBeUndefined();
    expect(h.results.filter(item => (item as { wakeAt: string | null }).wakeAt === null)).toHaveLength(2);
    expect(h.results).toHaveLength(4);
    expect(h.errors.sort()).toEqual([expect.stringContaining('between 0 and 1440'), expect.stringContaining('Give afterMinutes')].sort());
    expect(h.specs[0]!.prompt).toContain('To wait for a long build, test or job, set wake_me and end the turn; do not poll or sleep in a turn.');
  });

  it('makes the wake-up a lead set for itself a review that starts from the goal, which a turn it is woken for by something else is not', async () => {
    const ahead = clock();
    const h = await play('return await swarm("Ship it", {key:"rev", lead:{name:"lead"}, members:[{name:"dev"}]});', {
      lead: [{ calls: [['wake_me', { afterMinutes: 30 }]] }, { answer: 'Nothing built yet' }, { calls: [['swarm_finish', { result: 'done' }]] }],
    });
    await h.until(() => expect(h.state().swarms![0]!.members[0]!.wakeAt).toBeDefined());
    // The main agent asks the lead: the turn that wakes it for the ask is told to judge and plan; it is not a review.
    expect(await h.asMain('ask', { to: 'lead', text: 'How far along is it?' })).toMatchObject({ ask: expect.any(Number), to: 'lead', withinMinutes: 15 });
    await h.until(() => expect(h.turns('lead')).toEqual(['lead1', 'lead2']));
    const told = h.prompts('lead');
    expect(told[1]).toContain('- #2 (0 min) Ask 2 from the main agent: "How far along is it?" Do: answer({ask: 2, text})');
    expect(told[1]).toContain('Judge what came back by how far the goal has moved, then leave each queue with the work the goal still needs');
    expect(told[1]).not.toContain('This turn is your review');
    // Its answer reaches the main agent as a notice, and the ask is settled.
    await h.until(() => expect(h.notices('worker_reply')).toMatchObject([{ summary: expect.stringContaining('Nothing built yet') }]));
    expect(h.state().board!.asks ?? []).toEqual([]);
    await h.calm(); ahead.by(31 * MIN);
    const { result } = await h.settled();
    expect(result).toMatchObject({ stop: 'finished', result: 'done' });
    expect(h.errors).toEqual([]);
    const review = h.prompts('lead')[2]!;
    for (const text of ['The wake-up you set with wake_me is due.\n', 'This turn is your review of the plan: start from the goal, not from what came back. (1) Read the goal and its test, and work out how far off it is now by that test and what has moved it since your last review, on evidence. ',
      '(2) For what each queue is working on, ask which part of that distance it closes, and cancel or amend what closes none (update_work). ', '(4) Read topic "noticed" for what members saw that the plan does not account for. ',
      '(5) Rewrite your status (set_status): how things stand now, what is being tried and what was ruled out. ', 'When two reviews in a row find the goal no closer, the plan is what is wrong: stop adding work of the kind you have been adding',
      // What waits on the lead heads the brief of a review as of any other turn.
      'Queue "default" has run dry: 1 of its 1 members are idle and it has no item they can claim.']) expect(review, text).toContain(text);
    expect(review).not.toContain('Judge what came back by how far the goal has moved');
    expect(told[0]).toContain('Your review of the plan is the wake-up you set with wake_me and every 8th turn');
    // A member that does the work is not started while there is none.
    expect(h.turns('dev')).toEqual([]);
  });

  it('wakes the main agent for a review on the schedule it set, one pending review at a time', async () => {
    const ahead = clock();
    // An idle swarm with a lead keeps the script running with no turn in flight, which the moving clock could stall.
    const h = await play('return await swarm("Long work", {key:"long", lead:{name:"lead"}, members:[{name:"dev"}]});', {});
    const reviews = () => h.notices('review_due');
    await h.until(() => expect(h.order).toEqual(['lead1']));
    await expect(h.asMain('wake_me', {})).rejects.toThrow('Give afterMinutes, everyMinutes or both');
    await expect(h.asMain('wake_me', { everyMinutes: 5 })).rejects.toThrow('between 10 and 1440');
    expect(await h.asMain('wake_me', { everyMinutes: 30, note: 'parity first' })).toMatchObject({ everyMinutes: 30, wakeAt: expect.any(String) });
    await h.ticks(3);
    expect(reviews()).toHaveLength(0);
    await h.calm(); ahead.by(31 * MIN);
    await h.until(() => expect(reviews()).toHaveLength(1));
    expect(reviews()[0]).toMatchObject({ acknowledged: false, summary: expect.stringContaining('定时复盘（parity first）') });
    expect(reviews()[0]!.summary).toContain('原始需求之外尚未写下目标：先用 set_goal 写下目标和可检验的达成标准');
    expect(reviews()[0]!.summary).toContain('status（其中 statuses 是各负责人写的现状，todos 是等人处理的事）');
    // The next one is due while the first still waits for the main agent: it is rearmed but not raised again.
    await h.calm(); ahead.by(31 * MIN);
    await h.ticks(3);
    expect(reviews()).toHaveLength(1);
    expect(h.state().mainWake!.at).toBeGreaterThan(Date.now());
    await vi.waitFor(() => h.asMain('ack_events', { eventIds: [reviews()[0]!.id], expectedStateVersion: h.state().stateVersion }), { timeout: 5000 });
    await h.calm(); ahead.by(31 * MIN);
    await h.until(() => expect(reviews()).toHaveLength(2));
    // A review that reached the main agent is done with, acknowledged or not: one that a turn was woken for and did
    // not acknowledge is not the last there is.
    h.runtime.kernel.markNotified(h.root.scopeId, [reviews()[1]!.id]);
    expect(reviews()[1]).toMatchObject({ notified: true, acknowledged: false });
    await h.calm(); ahead.by(31 * MIN);
    await h.until(() => expect(reviews()).toHaveLength(3));
    // Delivered to a turn, a review is settled, and with it the one an earlier turn was given and left open.
    h.runtime.kernel.markNotified(h.root.scopeId, [reviews()[2]!.id], true);
    expect(reviews().map(review => review.acknowledged)).toEqual([true, true, true]);
    // A to-do that has reached the main agent reports a state that still stands: being delivered does not settle it.
    await h.until(() => expect(h.notices('todo').filter(notice => !notice.acknowledged)).toHaveLength(1));
    const todo = h.notices('todo').find(notice => !notice.acknowledged)!;
    h.runtime.kernel.markNotified(h.root.scopeId, [todo.id], true);
    expect(h.state().events.find(event => event.id === todo.id)).toMatchObject({ notified: true, acknowledged: false, subject: expect.stringMatching(/^todo:\d+$/) });
    // A single wake-up replaces the recurring one and leaves nothing behind once it has fired.
    expect(await h.asMain('wake_me', { afterMinutes: 10 })).not.toHaveProperty('everyMinutes');
    await h.calm(); ahead.by(11 * MIN);
    await h.until(() => expect(h.state().mainWake).toBeUndefined());
    expect(await h.asMain('wake_me', { everyMinutes: 60 })).toMatchObject({ everyMinutes: 60 });
    expect(await h.asMain('wake_me', { everyMinutes: 0 })).toMatchObject({ wakeAt: null });
    expect(h.state().mainWake).toBeUndefined();
    expect(h.state().script!.status).toBe('running');
  }, 30_000);

  it('hands the outcome of an item to the lead that planned it: its author, else the lead of its queue, else the swarm lead', async () => {
    const h = await play([
      'await enqueueWork({key:"p1", title:"P1", input:0, queue:"p"});',
      'return await swarm("Build", {key:"tree", lead:{name:"lead"}, maxTurns:2, members:[{name:"ql", leads:"q"},{name:"w1", queue:"q"},{name:"o1", queue:"p"}]});',
    ].join('\n'), {
      lead: [{ call: ['enqueue_work', { key: 'q2', title: 'Q2', input: 2, queue: 'q' }] }],
      ql: [{ call: ['enqueue_work', { key: 'q1', title: 'Q1', input: 1, queue: 'q' }] }],
      w1: () => ({ work: true, result: 'done, ask @o1 about the rest' }),
      o1: [{ work: true }],
    });
    // The outcomes each lead was handed, in the briefs of its turns. A turn takes what has come back by then, so the turns vary; the items do not.
    const handed = (name: string) => h.prompts(name).flatMap(prompt => prompt.split('\n').filter(line => line.startsWith('- completed'))).sort();
    await h.until(() => { expect(handed('lead')).toHaveLength(2); expect(handed('ql')).toHaveLength(1); });
    expect(h.errors).toEqual([]);
    // The script's item goes to the swarm lead, since queue "p" has no lead of its own; the item the lead of "q" added
    // goes to it; and the item the swarm lead put into "q" comes back to the swarm lead.
    expect(handed('lead')).toEqual(['- completed "p1" (o1): P1', '- completed "q2" (w1): Q2']);
    expect(handed('ql')).toEqual(['- completed "q1" (w1): Q1']);
    expect(h.prompts('ql')[1]).toContain('1 result came back since your last turn (1 completed, 0 failed). work_status({key}) has one in full.\n- completed "q1" (w1): Q1\n  Result: done, ask @o1 about the rest\n');
    // Outcomes are in the brief of the one they are for: nothing is posted, and the member a result mentions is not woken by it.
    expect(h.state().board!.posts.map(post => post.author)).toEqual(['script']);
    expect(h.state().swarms![0]!.results ?? []).toEqual([]);
    expect(h.turns('o1')).toEqual(['o11']);
    const prompt = (member: string) => h.prompts(member)[0]!;
    // What only a member that plans work may call is in the system prompt of the leads, and of nobody else.
    const system = (member: string) => h.specs.find(spec => spec.prompt.includes(`You are member "${member}"`))!.systemPrompt!;
    const planning = ['staff_swarm({operationId', 'tell_worker({operationId', 'retry_work({operationId', 'set_status({operationId', 'settle_work({operationId', 'swarm_finish({operationId'];
    for (const name of ['lead', 'ql']) for (const text of planning) expect(system(name), name + ' ' + text).toContain(text);
    for (const text of planning) expect(system('w1'), text).not.toContain(text);
    for (const text of ['claim_work({operationId', 'ask({operationId', 'defer_todo({operationId', 'pass_todo({operationId']) expect(system('w1'), text).toContain(text);
    for (const name of ['lead', 'ql', 'w1']) for (const text of ['post_board', 'set_charter', 'task_status']) expect(system(name), name + ' ' + text).not.toContain(text);

    for (const text of ['You lead queue "q" under @lead: that part of the task is yours to plan', 'What your part must deliver is in the status of @lead', 'you do not do the work',
      'and say so in your status, which @lead reads', '@lead decides when the swarm is done and changes its staff', 'One you leave open goes to whoever stands above you: @lead (lead of the swarm), then the main agent.']) expect(prompt('ql'), text).toContain(text);
    expect(prompt('ql')).not.toContain('woken at most');
    for (const text of ['These members lead parts of the work under you: ql (queue "q")', '@ql (leads "q")', 'you do not do the work', 'or move its members to a queue with more work than members (staff_swarm)',
      'and what each part that has a lead of its own must deliver', 'The swarm ends only when you call swarm_finish with the final result', 'One you leave open goes to whoever stands above you: the main agent.']) expect(prompt('lead'), text).toContain(text);
    // What a lead is asked for is the goal's work, not a full queue: idle members are no reason to add items, an empty
    // queue is first a question about the plan, and what is not known yet is work as long as something hangs on the answer.
    for (const member of ['lead', 'ql']) {
      for (const text of ['The goal, and the test that tells when it is met, are the user\'s: only the main agent changes them.', 'and which part of the goal it moves',
        'a question whose answer would change the plan, a way nobody has tried', 'Do not add an item whose result would change nothing whichever way it comes out',
        'idle members are not a reason to add work', 'A queue that is empty while the goal is not met says that the plan does not reach the goal',
        'Where that leaves nothing its members could do, leave the queue empty and defer the to-do that tells you of it',
        'by how far the goal has moved and not by how many came back', 'add what closes the distance, not everything it suggests',
        // Work is delivered on its own check and looked at afterwards; what is checked is the work, by trying it.
        'do not make each result wait for a reviewer', 'Do not plan a review of a report or a check of another check', 'Only where a mistake would spread before anyone finds it',
        'amend an item nobody has claimed (update_work with title, input)', 'do not re-issue work under new keys', 'hold: true, with a reason, is only for what you set aside by decision',
        'Members note in topic "noticed" what they saw that the plan does not account for']) expect(prompt(member), member + ': ' + text).toContain(text);
      expect(prompt(member)).toMatch(/Your review of (the plan|your part) is the wake-up you set with wake_me and every 8th turn/);
    }
    // A member delivers what its item asks for, keeps to the purpose of the item, and reports what it sees beside it instead of taking it up.
    for (const text of ['You do the work of queue "q".', '@ql leads your queue: it plans the work and judges the results', 'is your report, which @ql reads',
      'a description of how that could be done does not complete it', 'release_claim({reason, waitFor: [keys]})', 'that is what you are after, not the wording',
      'When the better way reaches beyond the item, do not take it yourself', 'Deliver as soon as the check passes', 'Do not weaken a test, special-case an input or change an expected output',
      'Write no account of your work beside it (a report, a summary, a log) unless the item names that document', 'What you find outside your item is new work, not yours to do',
      'give origin, the key of that item, and how to see the fault for oneself', 'report it once and leave the repair to whoever is given it', 'goes in note({topic: "noticed", text})',
      'After this first turn you can be woken at most 2 times.', 'One you leave open goes to whoever stands above you: @ql (lead of your queue), then @lead (lead of the swarm), then the main agent.']) expect(prompt('w1'), text).toContain(text);
    expect(prompt('o1')).toContain('@lead is the lead: it plans the work and judges the results');
    // The rules of a first turn do not last a long run: every later turn of a lead says where it stands and how its queues are.
    const later = (name: string) => h.prompts(name).find(text => text.includes('came back since your last turn'))!;
    expect(later('lead')).toMatch(/Swarm "tree", wake-up \d\. You are lead, the lead; above you: the main agent\.\n(.|\n)*Queues now: .*"q" \d+ claimable, \d+ of 1 members idle, \d+ items completed in the last hour \(lead ql\)(.|\n)*leave each queue that has no lead of its own with the work the goal still needs, what you know and what has to be found out\. Idle members are not a reason to add items\./);
    expect(later('ql')).toMatch(/Swarm "tree", wake-up \d\. You are ql, lead of queue "q"; above you: @lead \(lead of the swarm\), then the main agent\.\n(.|\n)*Queues now: "q" \d+ claimable, \d+ of 1 members idle, \d+ items completed in the last hour\.\n(.|\n)*leave each queue of yours with the work the goal still needs/);
    expect(later('ql').slice(later('ql').indexOf('Swarm "tree"'), later('ql').indexOf('Persistent member context'))).not.toContain('"p"');
    const main = h.runtime.bindMain(h.root.scopeId, 'continue'); cleanup.push(async () => main.release());
    const status = await callWorkflow('status', { workflowId: h.state().workflowId }, main.env) as { swarms: Array<{ queues: Record<string, { lead?: string }>; members: unknown[] }> };
    expect(status.swarms[0]!.members).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'ql', leads: ['q'] }), expect.objectContaining({ name: 'lead', lead: true })]));
    expect(status.swarms[0]!.queues.q!.lead).toBe('ql');
    expect(status.swarms[0]!.queues.p!.lead).toBeUndefined();
    await h.cancel();
  });

  it('tells the lead of a queue when it runs dry and takes what a lead leaves open up a level at a time, tells the swarm lead of a member that failed, and bounds no lead by maxTurns', async () => {
    const ahead = clock();
    const busy = gate();
    // "b" waits on the item "busy" is at, so queue "q" has a pending item and nothing to claim; queue "s" has nothing at all.
    const h = await play([
      'await enqueueWork({key:"job", title:"Job", input:0});',
      'await enqueueWork({key:"b", title:"B", input:1, queue:"q", dependsOn:["job"]});',
      'await enqueueWork({key:"x", title:"X", input:2, queue:"r"});',
      'return await swarm("Drain", {key:"dry", maxTurns:1, lead:{name:"lead"}, members:[{name:"ql", leads:["r","q"]},{name:"sub", leads:"s", under:"ql"},'
        + '{name:"w1", queue:"q"},{name:"w2", queue:"q"},{name:"s1", queue:"s"},{name:"bad", queue:"r"},{name:"busy"}]});',
    ].join('\n'), { busy: [{ claim: true, hold: busy.hold, complete: true }], bad: [{ fail: true }, { fail: true }], ql: turn => turn === 3 ? { answer: 'b waits on the job' } : {} });
    const member = (name: string) => h.state().swarms![0]!.members.find(item => item.name === name)!;
    /** Whom each to-do of a kind went to, in order. */
    const went = (kind: string, queue?: string) => h.todos(kind).filter(todo => !queue || todo.subject.endsWith(':' + queue)).map(todo => todo.told.map(told => told.who));
    await h.until(() => { expect(member('bad').stopped).toBe('failed'); expect(h.turns('lead')).toEqual(['lead1', 'lead2']); });
    expect(member('ql')).toMatchObject({ leads: ['q', 'r'] });
    expect(member('sub')).toMatchObject({ leads: ['s'], under: 'ql' });
    // Members of the same standing share a line of the roster, so a large swarm does not repeat a role a hundred times.
    expect(h.prompts('lead')[0]).toContain('@w1, @w2 (queue "q")\n');
    expect(h.prompts('lead')[0]).toContain('@sub (leads "s" under @ql)\n');
    expect(h.prompts('sub')[0]).toContain('You lead queue "s" under @ql: that part of the task is yours to plan');
    expect(h.prompts('sub')[0]).toContain('One you leave open goes to whoever stands above you: @ql, then @lead (lead of the swarm), then the main agent.');
    // A member that failed is told to the lead that can replace it, which is the swarm's.
    expect(went('member')).toEqual([['lead']]);
    expect(h.prompts('lead')[1]).toContain('Member "bad" of queue "r" failed and has stopped: model refused.');
    expect(h.turns('ql')).toEqual(['ql1']);

    await h.calm(); ahead.by(2 * MIN + 1000);
    await h.until(() => { expect(h.turns('ql')).toHaveLength(2); expect(h.turns('sub')).toHaveLength(2); expect(h.turns('lead')).toHaveLength(3); });
    // Each dry queue is its own lead's to-do, and the queue nobody is left to work is the swarm lead's.
    expect([went('dry', 'q'), went('dry', 's'), went('unstaffed')]).toEqual([[['ql']], [['sub']], [['lead']]]);
    expect(h.prompts('ql')[1]).toContain('Queue "q" has run dry: 2 of its 2 members are idle and it has no item they can claim (1 pending items cannot be claimed');
    expect(h.prompts('ql')[1]).toContain('defer_todo says that the queue has no work for now; say so in your status, which @lead reads and which can move the members.');
    expect(h.prompts('ql')[1]).not.toContain('Queue "s"');
    expect(h.prompts('sub')[1]).toContain('Queue "s" has run dry: 1 of its 1 members are idle and it has no item they can claim.');
    expect(h.prompts('lead')[2]).toContain('Queue "r" has 1 item to claim and no member left to take it: its members have stopped or used their wake-ups.');
    expect(h.prompts('lead')[2]).not.toContain('has run dry');
    // ql has used the one wake-up maxTurns allows the other members, and is woken again all the same.
    await h.asMain('ask', { to: 'ql', text: 'What is left?' });
    await h.until(() => expect(h.turns('ql')).toHaveLength(3));

    // What each left open goes one level up: the queue of ql to the swarm lead, the queue of sub to ql, and what the
    // swarm lead held to the main agent, which has not heard of a dry queue yet.
    await h.calm(); ahead.by(21 * MIN);
    await h.until(() => expect([went('dry', 'q'), went('dry', 's'), went('member'), went('unstaffed')]).toEqual([[['ql', 'lead']], [['sub', 'ql']], [['lead', 'main']], [['lead', 'main']]]));
    await h.until(() => { expect(h.turns('lead')).toHaveLength(4); expect(h.turns('ql')).toHaveLength(4); });
    expect(h.prompts('lead')[3]).toMatch(/- #\d+ \(2\d min, left open by ql\) Queue "q" has run dry/);
    expect(h.prompts('lead')[3]).toMatch(/- #\d+ \(2\d min, now also with the main agent\) Member "bad" of queue "r" failed and has stopped/);
    expect(h.prompts('ql')[3]).toMatch(/- #\d+ \(2\d min, left open by sub\) Queue "s" has run dry/);
    expect(h.prompts('ql')[3]).toMatch(/- #\d+ \(2\d min, now also with lead\) Queue "q" has run dry/);
    const summaries = () => h.notices('todo').map(notice => notice.summary);
    expect(summaries()).toHaveLength(2);
    expect(summaries().join('\n')).not.toContain('断粮');
    expect(summaries()).toEqual(expect.arrayContaining([expect.stringContaining('（lead 未处理，上报到你）：swarm "dry" 的成员 bad 失败并已停止'), expect.stringContaining('队列 r 有 1 项可领，但已没有能被唤醒的成员')]));

    await h.calm(); ahead.by(21 * MIN);
    await h.until(() => expect([went('dry', 'q'), went('dry', 's')]).toEqual([[['ql', 'lead', 'main']], [['sub', 'ql', 'lead']]]));
    expect(summaries().find(summary => summary.includes('断粮'))).toMatch(/^待办 #\d+，已 4\d 分钟（ql、lead 未处理，上报到你）：swarm "dry" 的队列 q 断粮/);
    await h.calm(); ahead.by(21 * MIN);
    await h.until(() => expect(went('dry', 's')).toEqual([['sub', 'ql', 'lead', 'main']]));
    expect(summaries().find(summary => summary.includes('队列 s 断粮'))).toMatch(/（sub、ql、lead 未处理，上报到你）：swarm "dry" 的队列 s 断粮/);
    expect(h.errors).toEqual([]);
    busy.release();
    await h.cancel();
  }, 30_000);

  it('keeps a dry spell going when what the queue is fed does not last, and settles its to-do once the queue stays fed', async () => {
    const ahead = clock();
    const busy = gate();
    // "w1" does the first two items it is woken for; after that neither it nor "w2" takes what the queue offers.
    const h = await play([
      'await enqueueWork({key:"job", title:"Job", input:0});',
      'await enqueueWork({key:"b", title:"B", input:1, queue:"q", dependsOn:["job"]});',
      'return await swarm("Drain q", {key:"dry", lead:{name:"lead"}, members:[{name:"w1", queue:"q"},{name:"w2", queue:"q"},{name:"busy"}]});',
    ].join('\n'), { busy: [{ claim: true, hold: busy.hold, complete: true }], w1: [{ work: true }, { work: true }] });
    const done = (key: string) => h.state().workQueue!.items.find(item => item.key === key)?.status === 'completed';
    const add = (key: string) => h.asMain('enqueue_work', { key, title: key, input: 1, queue: 'q' });
    await h.until(() => expect(h.todos('dry')).toHaveLength(1));
    const since = h.todos('dry')[0]!.since;
    await h.calm(); ahead.by(2 * MIN + 1000);
    await h.until(() => expect(h.turns('lead')).toEqual(['lead1', 'lead2']));
    const told = h.todos('dry')[0]!.told;
    expect(told).toMatchObject([{ who: 'lead' }]);

    // One item for two idle members is taken at once, and the queue is as dry as before: the same spell and the same
    // to-do. The lead is not told anew two minutes later, as it would be of a queue that had just run dry; what wakes
    // it is the result of the item, which it reads with the to-do still in its brief.
    await add('c');
    await h.until(() => { expect(done('c')).toBe(true); expect(h.todos('dry')).toMatchObject([{ id: 1, since, told }]); expect(h.todos('dry')[0]).not.toHaveProperty('goneAt'); });
    await h.calm(); ahead.by(2 * MIN + 1000);
    await h.until(() => expect(h.turns('lead')).toEqual(['lead1', 'lead2', 'lead3']));
    expect(h.prompts('lead')[2]).toMatch(/1 to-do waits on you; deal with it before other work:\n- #1 \(4 min\) Queue "q" has run dry(.|\n)*1 result came back since your last turn/);
    expect(h.todos('dry')).toMatchObject([{ id: 1, since, told }]);
    expect(h.notices('todo')).toEqual([]);
    // So the main agent hears of it twenty minutes after the lead did, although the queue was fed in between.
    await h.calm(); ahead.by(18 * MIN);
    await h.until(() => expect(h.notices('todo')).toHaveLength(1));
    expect(h.notices('todo')[0]).toMatchObject({ acknowledged: false, subject: 'todo:1', summary: expect.stringContaining('队列 q 断粮') });
    await add('d');
    await h.until(() => { expect(done('d')).toBe(true); expect(h.todos('dry')).toMatchObject([{ id: 1, since, told: [{ who: 'lead' }, { who: 'main' }] }]); expect(h.todos('dry')[0]).not.toHaveProperty('goneAt'); });
    // However often it is fed like that, the main agent has the one notice: it is neither settled nor raised again.
    expect(h.notices('todo')).toMatchObject([{ acknowledged: false }]);

    // An item that stays to be claimed feeds the queue. Once that has lasted, the spell is over and the notice to the
    // main agent is settled: nothing is left for it to acknowledge. The turn that did "d" ends first: it would take
    // "e" if it were still asking for its next item.
    await h.calm();
    await add('e');
    const main = h.runtime.bindMain(h.root.scopeId, 'continue'); cleanup.push(async () => main.release());
    const status = async () => await callWorkflow('status', { workflowId: h.state().workflowId }, main.env) as { todos: unknown[]; swarms: Array<{ queues: Record<string, Record<string, unknown>> }> };
    // Both members were woken for it and left it.
    await h.until(async () => { expect((await status()).swarms[0]!.queues.q).toMatchObject({ claimable: 1, running: 0, idle: 2 }); expect(h.todos('dry')[0]?.goneAt).toBeDefined(); });
    // A to-do whose situation is gone for the moment is on nobody's list.
    expect((await status()).todos).toEqual([]);
    expect(h.notices('todo')).toMatchObject([{ acknowledged: false }]);
    await h.calm(); ahead.by(3 * MIN + 1000);
    await h.until(() => { expect(h.todos('dry')).toEqual([]); expect(h.notices('todo')).toMatchObject([{ acknowledged: true }]); });
    expect(h.state().swarms![0]!.dry).toMatchObject({ q: { spells: 1 } });
    expect(h.state().swarms![0]!.dry!.q!.ms).toBeGreaterThan(20 * MIN);
    expect(h.errors).toEqual([]);
    busy.release();
    await h.cancel();
  }, 30_000);

  it('lets a dry queue rest once whoever answers for it has deferred the to-do: for as long as the spell lasts, or for the time it names', async () => {
    const ahead = clock();
    const busy = gate();
    const h = await play([
      'await enqueueWork({key:"job", title:"Job", input:0});',
      'await enqueueWork({key:"b", title:"B", input:1, queue:"q", dependsOn:["job"]});',
      'return await swarm("Drain q", {key:"dry", lead:{name:"lead"}, members:[{name:"w1", queue:"q"},{name:"w2", queue:"q"},{name:"busy"}]});',
    ].join('\n'), { busy: [{ claim: true, hold: busy.hold, complete: true }], w1: [{ work: true }],
      lead: [{}, { calls: [['defer_todo', { id: 1 }], ['defer_todo', { id: 1, note: 'Nothing for q until the job is through' }]] }] });
    const done = (key: string) => h.state().workQueue!.items.find(item => item.key === key)?.status === 'completed';
    const add = (key: string) => h.asMain('enqueue_work', { key, title: key, input: 1, queue: 'q' });
    /** Nobody is told of the queue: its to-do stays as it is, and the main agent hears nothing. */
    const quiet = async () => { const before = JSON.stringify(h.todos('dry')); await h.ticks(4); expect(JSON.stringify(h.todos('dry'))).toBe(before); expect(h.notices('todo')).toEqual([]); };
    const briefed = (text: RegExp) => h.until(() => expect(h.prompts('lead').some(prompt => text.test(prompt)), String(text)).toBe(true));
    await h.until(() => expect(h.todos('dry')).toHaveLength(1));
    await h.calm(); ahead.by(2 * MIN + 1000);
    // The lead says that the queue has no work for now, and why: the to-do stays, in front of nobody.
    await h.until(() => expect(h.todos('dry')).toMatchObject([{ id: 1, deferred: { by: 'lead', note: 'Nothing for q until the job is through' } }]));
    expect(h.errors).toEqual([expect.stringContaining('defer_todo needs a note: why it need not be acted on now, and what would change that')]);
    expect(h.results).toMatchObject([{ id: 1, deferred: true, until: 'its cause is gone' }]);
    expect(h.todos('dry')[0]!.deferred).not.toHaveProperty('until');
    const main = h.runtime.bindMain(h.root.scopeId, 'continue'); cleanup.push(async () => main.release());
    const status = async () => await callWorkflow('status', { workflowId: h.state().workflowId }, main.env) as { todos: unknown[] };
    expect((await status()).todos).toMatchObject([{ id: 1, kind: 'dry', holder: 'lead', deferred: { by: 'lead', note: 'Nothing for q until the job is through' } }]);
    // Neither the lead nor the main agent is asked again, however long the queue stays empty.
    await h.calm(); ahead.by(45 * MIN);
    await quiet();
    // An item that is taken at once does not end the spell, so the answer stands.
    await add('c');
    await h.until(() => { expect(done('c')).toBe(true); expect(h.todos('dry')).toMatchObject([{ id: 1, deferred: { by: 'lead' } }]); expect(h.todos('dry')[0]).not.toHaveProperty('goneAt'); });
    await h.calm(); ahead.by(45 * MIN);
    await quiet();
    // The result of that item wakes the lead, whose brief says that nothing waits on it and what it has put off.
    await briefed(/Nothing waits on you now; 1 to-do you deferred is still open \(read_context lists them\)\.\n1 result came back since your last turn/);

    // Once the queue has stayed fed the spell is over, and with it the answer: when it runs dry again its lead is asked again.
    await add('e');
    await h.until(async () => { expect(((await status()) as unknown as { swarms: Array<{ queues: Record<string, unknown> }> }).swarms[0]!.queues.q).toMatchObject({ claimable: 1, running: 0, idle: 2 }); expect(h.todos('dry')[0]?.goneAt).toBeDefined(); });
    await h.calm(); ahead.by(3 * MIN + 1000);
    await h.until(() => expect(h.todos('dry')).toEqual([]));
    await h.asMain('update_work', { key: 'e', cancel: true, reason: 'Not needed after all', expectedStateVersion: h.state().stateVersion });
    await h.until(() => expect(h.todos('dry')).toMatchObject([{ id: 2, told: [] }]));
    await h.calm(); ahead.by(2 * MIN + 1000);
    await briefed(/- #2 \(2 min\) Queue "q" has run dry/);
    // The main agent can answer for the member that holds it, and for a time: when that is over the to-do is in front of its holder again.
    await expect(h.asMain('defer_todo', { id: 99, note: 'x' })).rejects.toThrow('No open to-do has the id 99');
    expect(await h.asMain('defer_todo', { id: 2, note: 'Still nothing for q', minutes: 30 })).toMatchObject({ id: 2, deferred: true, until: expect.stringMatching(/^\d{4}-\d\d-\d\dT/) });
    await h.calm(); ahead.by(29 * MIN);
    await quiet();
    await h.calm(); ahead.by(2 * MIN);
    await briefed(/- #2 \(3\d min\) Queue "q" has run dry/);
    expect(h.todos('dry')[0]).not.toHaveProperty('deferred');
    expect(h.state().swarms![0]!.dry).toMatchObject({ q: { spells: 1 } });
    busy.release();
    await h.cancel();
  }, 30_000);

  it('moves members from a queue without work to the work of another queue', async () => {
    // Queue "q" has three members and one item, which they cannot claim.
    const h = await play([
      'await enqueueWork({key:"gate", title:"Gate", input:0, queue:"other"});',
      'await enqueueWork({key:"q2", title:"Q2", input:4, queue:"q", dependsOn:["gate"]});',
      'return await swarm("Build", {key:"mv", lead:{name:"lead"}, members:[{name:"b", queue:"q", role:"checks q"},{name:"d", queue:"q"},{name:"e", queue:"q"},{name:"solo"}]});',
    ].join('\n'), { lead: [{ calls: [['staff_swarm', { move: ['d'], queue: 'p' }]] }], b: () => ({ work: true }), d: [{ work: true }], solo: () => ({ work: true }) });
    const member = (name: string) => h.state().swarms![0]!.members.find(item => item.name === name)!;
    const item = (key: string) => h.state().workQueue!.items.find(found => found.key === key)!;
    const add = (key: string, queue: string) => h.asMain('enqueue_work', { key, title: key.toUpperCase(), input: 1, queue });
    // The lead moves "d", which has not had a turn: it starts on the work of "p" and is told of no other queue.
    await h.until(() => expect(h.results).toMatchObject([{ swarm: 'mv', moved: ['d'] }]));
    for (const [key, queue] of [['p1', 'p'], ['p2', 'p'], ['q1', 'q']] as const) await add(key, queue);
    await h.until(() => { for (const key of ['p1', 'p2', 'q1']) expect(item(key).status).toBe('completed'); });
    // The turns that did them end before more work arrives: one that is still asking for its next item would take it.
    await h.calm();
    expect(h.errors).toEqual([]);
    expect([item('p1').doneBy, item('p2').doneBy, item('q1').doneBy]).toEqual(['d', 'd', 'b']);
    expect(h.prompts('d')[0]).toContain('You do the work of queue "p".');
    expect(h.prompts('d')[0]).not.toContain('You have been moved');
    expect(member('d')).toMatchObject({ queue: 'p' });
    expect(member('d').movedFrom).toBeUndefined();

    const staff = (args: Record<string, unknown>) => h.asMain('staff_swarm', args);
    await expect(staff({ move: ['b'] })).rejects.toThrow('move needs queue');
    await expect(staff({ move: ['ghost'], queue: 'p' })).rejects.toThrow('Unknown swarm member: ghost');
    await expect(staff({ move: ['lead'], queue: 'p' })).rejects.toThrow('Member lead does not consume a work queue');
    // A member that is already there is not moved.
    expect(await staff({ move: ['d'], queue: 'p' })).toMatchObject({ moved: [] });
    // "b" has had a turn in "q": it keeps its session, is woken for the work of "p", and that turn tells it of the move.
    const moved = await staff({ move: ['b'], queue: 'p', role: 'builds p now' }) as { moved: string[]; unconsumed?: string[] };
    expect(moved).toMatchObject({ moved: ['b'] });
    expect(moved.unconsumed).toBeUndefined();
    expect(member('b')).toMatchObject({ queue: 'p', movedFrom: 'q', role: 'builds p now' });
    await add('p3', 'p');
    await h.until(() => expect(item('p3').status).toBe('completed'));
    expect(item('p3').doneBy).toBe('b');
    expect(h.prompts('b')[1]).toContain('Swarm "mv", wake-up 1 of at most 6. You are b, a worker of queue "p"; above you: @lead (lead of the swarm), then the main agent.\n'
      + 'You have been moved from queue "q" to queue "p", which @lead leads: where your first turn speaks of "q", the items of "p" now say what is wanted. Your role now: builds p now.\n');
    expect(h.prompts('b')[1]).toContain('Queue "p" has 1 item you can claim: take them with claim_work until it returns null.');
    expect(member('b').movedFrom).toBeUndefined();
    // A member that named no queue does the work of the default one, and can be moved like the others.
    expect(member('solo')).toMatchObject({ queue: 'default' });
    expect(await staff({ move: ['solo'], queue: 'p' })).toMatchObject({ moved: ['solo'] });
    // The last member of "q" leaves while "q2" is unfinished: the answer says that nobody consumes the queue now.
    expect(await staff({ move: ['e'], queue: 'p' })).toMatchObject({ moved: ['e'], unconsumed: ['q'] });
    expect(h.errors).toEqual([]);
    await h.cancel();
  }, 30_000);

  it('lets the main agent, and only it, give a queue a lead of its own while the swarm runs, under the swarm lead or under another lead', async () => {
    const ahead = clock();
    const busy = gate();
    const h = await play('await enqueueWork({key:"job", title:"Job", input:0}); return await swarm("Build", {key:"grow", lead:{name:"lead"}, members:[{name:"w1", queue:"q", role:"builder"},{name:"busy"}]});',
      { busy: [{ claim: true, hold: busy.hold, complete: true }], lead: [{ calls: [['staff_swarm', { add: ['x'], leads: ['q'] }]] }], w1: () => ({ work: true }) });
    const member = (name: string) => h.state().swarms![0]!.members.find(item => item.name === name)!;
    const name = (id: string) => h.state().agents!.find(agent => agent.agentId === id)!.key;
    await h.until(() => expect(h.errors).toHaveLength(1));
    expect(h.errors[0]).toContain('Only the main agent can give a queue a lead of its own');
    const staff = (args: Record<string, unknown>) => h.asMain('staff_swarm', args);
    await expect(staff({ add: ['a', 'b'], leads: ['q'] })).rejects.toThrow('add that member alone');
    await expect(staff({ add: ['a'], leads: ['q'], queue: 'q' })).rejects.toThrow('does not consume a queue');
    await expect(staff({ leads: ['q'] })).rejects.toThrow('leads binds the member that add names');
    expect(await staff({ add: ['ql'], leads: 'q', role: 'plans q' })).toMatchObject({ added: ['ql'], leads: ['q'] });
    await expect(staff({ add: ['other'], leads: ['q'] })).rejects.toThrow('Queue "q" already has a lead: ql');
    // The new lead takes over neither the queue nor the role of the member it is bound like.
    expect(member('ql')).toMatchObject({ leads: ['q'], role: 'plans q', added: true });
    expect(member('ql').queue).toBeUndefined();
    // The members already running learn of it from an announcement, which also wakes the swarm lead.
    const announced = h.state().board!.posts.find(post => post.topic === 'announce' && post.text.includes('Member "ql" now leads queue "q"'))!;
    expect(announced).toMatchObject({ author: 'system' });
    expect(announced.to.map(name)).toEqual(['lead']);
    await h.until(() => expect(h.order).toContain('ql1'));
    expect(h.prompts('ql')[0]).toContain('You lead queue "q" under @lead');
    // A lead can answer to another lead instead of to the swarm's: what it leaves open then goes to that one first.
    await expect(staff({ add: ['sub'], under: 'ql' })).rejects.toThrow('under names the lead a new lead answers to; give it with leads');
    await expect(staff({ add: ['sub'], leads: 'deep', under: 'w1' })).rejects.toThrow('under names a running member that leads queues; "w1" is not one');
    expect(await staff({ add: ['sub'], leads: 'deep', under: 'ql', role: 'plans the deep part' })).toMatchObject({ added: ['sub'], leads: ['deep'] });
    expect(member('sub')).toMatchObject({ leads: ['deep'], under: 'ql' });
    await h.until(() => expect(h.order).toContain('sub1'));
    expect(h.prompts('sub')[0]).toContain('You lead queue "deep" under @ql');
    expect(h.prompts('sub')[0]).toContain('One you leave open goes to whoever stands above you: @ql, then @lead (lead of the swarm), then the main agent.');
    expect(h.prompts('sub')[0]).toContain('@sub (leads "deep" under @ql)');
    // From then on the outcomes of the queue's items go to its lead and not to the swarm's.
    await h.asMain('enqueue_work', { key: 'i1', title: 'I1', input: 1, queue: 'q' });
    await h.until(() => expect(h.state().swarms![0]!.results).toMatchObject([{ worker: 'w1' }]));
    // "busy" is still at work, so the outcome waits out the gap in which what comes back for a lead is gathered.
    await h.ticks(3);
    expect(h.turns('ql')).toEqual(['ql1']);
    await h.calm(); ahead.by(5 * MIN);
    await h.until(() => expect(h.turns('ql')).toEqual(['ql1', 'ql2']));
    expect(h.prompts('ql')[1]).toContain('- completed "i1" (w1): I1\n  Result: w1');
    expect(h.prompts('lead').join('\n')).not.toContain('completed "i1"');
    busy.release();
    await h.cancel();
  }, 30_000);

  it('hands a lead the results it is owed in the brief of its next turn: by queue, what failed first, four dozen to a turn and each cut to its share of the room', async () => {
    const lead = gate();
    const h = await play('return await swarm("Build", {key:"many", lead:{name:"lead"}, members:[{name:"w1", queue:"a"},{name:"w2", queue:"b"}]});',
      { lead: [{ hold: lead.hold }], w1: () => ({ work: true, result: 'r'.repeat(3000) }), w2: [{ work: true }, { giveUp: true }] });
    const item = (key: string) => h.state().workQueue?.items.find(found => found.key === key);
    const main = h.runtime.bindMain(h.root.scopeId, 'continue'); cleanup.push(async () => main.release());
    const add = (key: string, queue: string) => callWorkflow('enqueue_work', { operationId: randomUUID(), workflowId: h.state().workflowId, key, title: 'Item ' + key, input: key, queue }, main.env);
    await h.until(() => expect(h.order).toContain('lead1'));
    // Queue "b" first: one item completed, then one given up. Then fifty items of queue "a".
    await add('b2', 'b');
    await h.until(() => expect(item('b2')!.status).toBe('completed'));
    // The turn that completed it ends before the next item arrives, which is for the turn that gives up.
    await h.calm();
    await add('b1', 'b');
    await h.until(() => expect(item('b1')!.status).toBe('failed'));
    for (let n = 0; n < 50; n++) await add('a' + n, 'a');
    // While the lead is in its turn the results wait for its next one.
    await h.until(() => expect(h.state().swarms![0]!.results).toHaveLength(52), 20_000);
    lead.release();
    await h.until(() => { expect(h.turns('lead')).toHaveLength(3); expect(h.state().swarms![0]!.results ?? []).toEqual([]); });
    expect(h.errors).toEqual([]);
    const lines = (text: string) => text.split('\n').filter(line => /^- (completed|failed) "/.test(line));
    const [, second, third] = h.prompts('lead') as [string, string, string];
    // The second turn took four dozen; the four left over woke the lead for its third.
    expect([lines(second).length, lines(third).length]).toEqual([48, 4]);
    expect(new Set([...lines(second), ...lines(third)].map(line => /"([^"]+)"/.exec(line)![1])).size).toBe(52);
    // By queue, what failed ahead of what was completed, although it came back later.
    expect(second).toContain('48 results came back since your last turn (47 completed, 1 failed); 4 more follow at your next turn. work_status({key}) has one in full.\n'
      + 'Queue "b":\n- failed "b1" (w2): Item b1\n  Error: cannot build it\n- completed "b2" (w2): Item b2\n  Result: w2\nQueue "a":\n- completed "a0" (w1): Item a0\n  Result: rrr');
    expect(third).toContain('4 results came back since your last turn (4 completed, 0 failed). work_status({key}) has one in full.\n- completed "a46" (w1): Item a46\n');
    // The results of a turn share its room, so a long one is cut to a line and the whole stays in the item.
    const quote = second.split('\n').find(line => line.startsWith('  Result: rrr'))!;
    expect(quote.length).toBeLessThan(80);
    expect(quote).toContain('…[truncated]');
    expect(second.slice(second.indexOf('48 results came back'), second.indexOf('Queues now:')).length).toBeLessThan(6000);
    expect(await callWorkflow('work_status', { workflowId: h.state().workflowId, key: 'a7' }, main.env)).toMatchObject({ key: 'a7', status: 'completed', result: 'r'.repeat(3000) });
    // Nothing was posted for them. The lead's turns were told how its queues stand, and the status shows who did what and how the queues moved.
    expect(h.state().board!.posts.map(post => post.author)).toEqual(['script']);
    expect(second).toContain('"a" 0 claimable, 1 of 1 members idle, 50 items completed in the last hour');
    const status = await callWorkflow('status', { workflowId: h.state().workflowId }, main.env) as { swarms: Array<{ queues: Record<string, unknown>; members: unknown[] }> };
    expect(status.swarms[0]!.members).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'w1', itemsDone: 50 }), expect.objectContaining({ name: 'w2', itemsDone: 1, itemsFailed: 1 })]));
    expect(status.swarms[0]!.queues).toMatchObject({ a: { flow: { enqueued: [0, 0, 0, 0, 0, 50], completed: [0, 0, 0, 0, 0, 50] } },
      b: { flow: { enqueued: [0, 0, 0, 0, 0, 2], completed: [0, 0, 0, 0, 0, 1], failed: [0, 0, 0, 0, 0, 1] } } });
    await h.cancel();
  }, 60_000);

  it('makes an item that keeps coming back without moving a to-do of whoever planned it, and counts against its attempts only what failed through its member', async () => {
    // w1 takes the item and ends its turn without a word, each time it is woken for it. Once the lead has rewritten the item, w1 gives it up.
    const h = await play([
      'await enqueueWork({key:"k", title:"K", input:1, queue:"q", maxAttempts:1});',
      'return await swarm("Build", {key:"lost", lead:{name:"lead"}, members:[{name:"w1", queue:"q"}]});',
    ].join('\n'), {
      w1: (_turn, state) => { const item = state.workQueue!.items[0]!; return item.revision ? { giveUp: true } : (item.idleClaims ?? 0) >= 3 ? {} : { claim: true }; },
      lead: (_turn, state) => state.workQueue!.items[0]!.status === 'failed' ? { call: ['swarm_finish', { result: 'k is lost' }] }
        : state.todos?.open.some(todo => todo.kind === 'spin' && todo.told.length) ? { calls: [['update_work', { key: 'k', title: 'K, the first half only', input: { half: 1 } }]] } : {},
    });
    const { state } = await h.settled();
    expect(h.errors).toEqual([]);
    const spun = h.prompts('lead').find(prompt => prompt.includes('coming back without moving'))!;
    expect(spun).toContain('1 item keeps coming back without moving: "k" (queue q) was taken 3 times in a row and came back each time with no progress saved and no failure reported (last: Member turn ended without completing its claim).');
    expect(spun).toContain('read why with work_status({key}), then make the item one that can be done: amend it (update_work with title, input), split it, name what it waits for in dependsOn, give it to one member (assignee) or cancel it.');
    // Three rounds used none of the one attempt it had; the member giving it up did. The rewritten item was a new one to the
    // member, which had left the old one alone.
    expect(state.workQueue!.items[0]).toMatchObject({ key: 'k', status: 'failed', title: 'K, the first half only', input: { half: 1 }, revision: 1, failures: 1, error: expect.stringContaining('cannot build it') });
    expect(state.workQueue!.items[0]!.idleClaims).toBeUndefined();
    const failed = h.prompts('lead').find(prompt => prompt.includes('came back since your last turn'))!;
    expect(failed).toMatch(/1 result came back since your last turn \(0 completed, 1 failed\)\. work_status\(\{key\}\) has one in full\.\n- failed "k" \(w1\): K, the first half only\n {2}Error: .*cannot build it/);
    expect(state.swarms![0]).toMatchObject({ stop: 'finished', members: expect.arrayContaining([expect.objectContaining({ name: 'w1', itemsFailed: 1 })]) });
    expect(state.todos?.open ?? []).toEqual([]);
  });

  it('lets whoever plans a queue reorder, rewrite, hold, withdraw and retry its items, and a member rewrite or withdraw what it added', async () => {
    const w2 = gate();
    // Nobody consumes queue "q", so its items stay where they can be changed.
    const h = await play([
      'await enqueueWork({key:"a", title:"A", input:1, queue:"q"}); await enqueueWork({key:"b", title:"B", input:2, queue:"q"});',
      'await enqueueWork({key:"x", title:"X", input:3, queue:"q"}); await enqueueWork({key:"y", title:"Y", input:4, queue:"q", dependsOn:["x"]});',
      'await enqueueWork({key:"p1", title:"P1", input:5, queue:"p"}); await enqueueWork({key:"f", title:"F", input:6, queue:"r", maxAttempts:1});',
      'await enqueueWork({key:"s0", title:"Look around", input:7, assignee:"scout"});',
      'return await swarm("Build", {key:"plan", lead:{name:"lead"}, members:[{name:"ql", leads:"q"},{name:"w2", queue:"r"},{name:"scout"}]});',
    ].join('\n'), {
      // w2 gives "f" up; the lead, handed that outcome, retries it, and w2 then holds it claimed.
      w2: [{ giveUp: true }, { claim: true, hold: w2.hold }],
      lead: (turn, state) => turn === 1 ? { calls: [['update_work', { key: 'b', priority: 50 }], ['update_work', { key: 'x', cancel: true, reason: 'superseded' }]] }
        : state.workQueue!.items.find(item => item.key === 'f')!.status === 'failed' ? { calls: [['retry_work', { key: 'f' }]] } : {},
      ql: [{ calls: [['update_work', { key: 'a', hold: true }], ['update_work', { key: 'a', hold: true, reason: 'until the format is decided' }], ['update_work', { key: 'y', title: 'Y, with tests', writes: ['src/y/**'] }],
        ['update_work', { key: 'p1', priority: 5 }], ['retry_work', { key: 'p1' }]] }],
      scout: [{ work: true, calls: [['enqueue_work', { key: 'mine', title: 'Mine', input: 0, queue: 'q' }], ['update_work', { key: 'mine', priority: 9 }], ['update_work', { key: 'mine', title: 'Mine, narrowed', input: { only: 'lexer' } }],
        ['update_work', { key: 'b', cancel: true }], ['update_work', { key: 'mine', cancel: true }]] }],
    });
    const item = (key: string) => h.state().workQueue!.items.find(found => found.key === key)!;
    await h.until(() => { expect(h.turns('w2')).toHaveLength(2); expect(item('f').status).toBe('claimed'); expect(item('mine')?.status).toBe('cancelled'); });
    expect(h.results).toEqual(expect.arrayContaining([
      expect.objectContaining({ itemId: item('b').id, key: 'b', queue: 'q', status: 'pending', priority: 50 }),
      // Cancelling does not cascade: the answer names what can no longer be claimed, and how to move it to a replacement.
      expect.objectContaining({ itemId: item('x').id, key: 'x', queue: 'q', status: 'cancelled', blocks: ['y'], note: expect.stringContaining('supersededBy') }),
      expect.objectContaining({ itemId: item('a').id, key: 'a', queue: 'q', status: 'pending', hold: true, holdReason: 'until the format is decided' }),
      expect.objectContaining({ key: 'mine', status: 'cancelled' }),
      expect.objectContaining({ itemId: item('f').id, maxAttempts: 2 }),
    ]));
    // The lead of "q" plans "q" alone; a member plans nothing: it rewrites or withdraws only what it added.
    expect(h.errors.sort()).toEqual([
      expect.stringContaining('A member can amend (title, input, writes, resources), withdraw (cancel) or replace (supersededBy) an item it added; its priority, hold, assignee and dependsOn are for the lead that plans the queue'),
      expect.stringContaining('Only the main agent, the swarm lead or the lead of its queue can retry a work item'),
      expect.stringContaining('Only the main agent, the swarm lead, the lead of its queue or, to amend, cancel or replace it, the member that added it can change a work item'),
      expect.stringContaining('Only the main agent, the swarm lead, the lead of its queue or, to amend, cancel or replace it, the member that added it can change a work item'),
      // A hold says why: what only waits for something is given a dependency instead.
      expect.stringContaining('hold: true needs a reason'),
    ]);
    expect(item('a').held).toEqual({ by: 'ql', at: expect.any(Number), reason: 'until the format is decided' });
    expect(item('x')).toMatchObject({ status: 'cancelled', error: 'Cancelled by lead: superseded' });
    // An item is rewritten in place under its key, and says that it was.
    expect(item('y')).toMatchObject({ title: 'Y, with tests', writes: ['src/y/**'], revision: 1, input: 4 });
    expect(item('mine')).toMatchObject({ status: 'cancelled', error: 'Cancelled by scout', by: 'scout', title: 'Mine, narrowed', input: { only: 'lexer' }, revision: 1 });
    expect(item('f')).toMatchObject({ status: 'claimed', maxAttempts: 2, failures: 1 });

    const main = h.runtime.bindMain(h.root.scopeId, 'continue'); cleanup.push(async () => main.release());
    const op = (method: string, args: Record<string, unknown>) => callWorkflow(method, { operationId: randomUUID(), workflowId: h.state().workflowId, ...args }, main.env);
    const queue = () => callWorkflow('work_status', { workflowId: h.state().workflowId, queue: 'q' }, main.env) as Promise<{ items: Array<{ key: string; hold?: boolean }> }>;
    // An item on hold, like one behind a withdrawn item, is pending and cannot be claimed.
    expect(await queue()).toMatchObject({ pending: 3, cancelled: 2, claimable: 1, blocked: 2, onHold: 1, heldReady: 1, stuck: 1 });
    expect((await queue()).items.find(found => found.key === 'a')).toMatchObject({ hold: true, priority: 0, held: { by: 'ql', reason: 'until the format is decided' } });
    expect((await queue()).items.find(found => found.key === 'y')).toMatchObject({ waitsOn: [{ key: 'x', status: 'cancelled' }] });
    const released = await op('update_work', { key: 'a', hold: false, priority: 80 });
    expect(released).toMatchObject({ itemId: item('a').id, key: 'a', queue: 'q', status: 'pending', priority: 80 });
    expect(released).not.toHaveProperty('hold');
    expect(item('a').hold).toBeUndefined();
    expect(item('a').held).toBeUndefined();
    expect(await queue()).toMatchObject({ claimable: 2, blocked: 1 });
    expect(await queue()).not.toHaveProperty('onHold');
    expect(await queue()).not.toHaveProperty('heldReady');
    expect(await op('update_work', { itemId: item('b').id, priority: 0 })).toMatchObject({ key: 'b', priority: 0 });
    expect(item('b').priority).toBeUndefined();
    // Rewriting an item with what it says already changes nothing.
    await op('update_work', { key: 'y', title: 'Y, with tests' });
    expect(item('y').revision).toBe(1);
    // A claimed item is its member's to stop, and its member works from what it said; a finished or withdrawn one no longer changes.
    await expect(op('update_work', { key: 'f', cancel: true })).rejects.toThrow('Work item is claimed by w2');
    await expect(op('update_work', { key: 'f', title: 'F, again' })).rejects.toThrow('Work item is claimed by w2, which works from what the item said: tell that member what changed (tell_worker), or replace the item (supersededBy)');
    await expect(op('update_work', { key: 'x', hold: true })).rejects.toThrow('Work item is already cancelled');
    expect(await op('update_work', { key: 'x', cancel: true })).toMatchObject({ key: 'x', status: 'cancelled' });
    await expect(op('update_work', { key: 'b' })).rejects.toThrow('Give title, input, writes, resources, priority, hold, assignee, dependsOn, supersededBy or cancel');
    await expect(op('update_work', { key: 'b', cancel: true, hold: true })).rejects.toThrow('give either alone, not with a change to the item');
    // Whoever plans the queue gives an item to one member or back to all of them. A member that cannot take it (w2
    // consumes another queue) does not keep it from the others, and the answer says so.
    expect(await op('update_work', { key: 'b', assignee: 'w2' })).toMatchObject({ key: 'b', assignee: 'w2', assigneeNote: expect.stringContaining('does not consume queue "q"') });
    expect(item('b').assignee).toBe('w2');
    expect((await queue()).items.find(found => found.key === 'b')).toMatchObject({ assignee: 'w2' });
    expect(await op('update_work', { key: 'b', assignee: null })).not.toHaveProperty('assignee');
    expect(item('b').assignee).toBeUndefined();
    await expect(op('update_work', { key: 'b', assignee: 'not a name' })).rejects.toThrow('assignee is the name of a member');
    await expect(op('update_work', { key: 'b', priority: 1, reason: 'why' })).rejects.toThrow('reason belongs to cancel and to hold: true');
    await expect(op('update_work', { key: 'b', hold: true })).rejects.toThrow('Do not hold an item that only waits for something: name what it waits for in dependsOn');
    await expect(op('update_work', { key: 'b', hold: true, reason: '  ' })).rejects.toThrow('reason must be nonempty text');
    await expect(op('update_work', { key: 'b', itemId: item('b').id, hold: true })).rejects.toThrow('Name the work item by itemId or by key');
    await expect(op('update_work', { key: 'nope', hold: true })).rejects.toThrow('Unknown work item');
    await expect(op('retry_work', { key: 'b' })).rejects.toThrow('Only failed work items can be retried');
    w2.release();
    await h.cancel();
  }, 30_000);

  it('hands out what waits on a gate once the gate is declared met, and makes an item set aside with nothing else in its way, and a gate nobody declares met, a to-do of whoever answers for it', async () => {
    const ahead = clock();
    const busy = gate();
    const h = await play([
      // "pushed" is something that happens outside the workflow; "ext" is work of a queue nobody consumes.
      'await enqueueWork({key:"pushed", title:"The batch is on main", input:{}, queue:"q", gate:true});',
      'await enqueueWork({key:"flip", title:"Flip", input:1, queue:"q", dependsOn:["pushed"]});',
      'await enqueueWork({key:"ext", title:"Ext", input:2, queue:"other"});',
      'await enqueueWork({key:"later", title:"Later", input:3, queue:"q", dependsOn:["ext"]});',
      'await enqueueWork({key:"job", title:"Job", input:4, assignee:"busy"}); await enqueueWork({key:"look", title:"Look", input:5, assignee:"scout"});',
      'return await swarm("Do", {key:"gates", lead:{name:"lead"}, members:[{name:"w1", queue:"q"},{name:"scout"},{name:"busy"}]});',
    ].join('\n'), {
      busy: [{ claim: true, hold: busy.hold, complete: true }], w1: () => ({ work: true }),
      // The lead returns what it set aside when it is asked about it, and puts off the gate that is still to come.
      lead: (turn, state) => {
        const waits = (kind: string) => state.todos?.open.find(todo => todo.kind === kind && todo.told.at(-1)?.who === 'lead' && !todo.deferred);
        return turn === 1 ? { calls: [['update_work', { key: 'later', hold: true, reason: 'not before  the review' }], ['update_work', { key: 'pushed', hold: true, reason: 'x' }]] }
          : waits('aside') ? { calls: [['update_work', { key: 'later', hold: false }]] }
          : waits('gate') ? { calls: [['defer_todo', { id: waits('gate')!.id, note: 'The batch is pushed tonight', minutes: 120 }]] } : {};
      },
      // A member adds a condition it will see met, and declares that one met; the rest are not its to settle.
      scout: [{ work: true, calls: [['enqueue_work', { key: 'approved', title: 'The format is approved', input: {}, queue: 'q', gate: true }], ['settle_work', { key: 'pushed', result: 1 }],
        ['settle_work', { key: 'flip', result: 1 }], ['enqueue_work', { key: 'g2', title: 'G2', input: {}, queue: 'q', gate: true, assignee: 'w1' }], ['settle_work', { key: 'approved', result: 'approved by the user' }]] }],
    });
    const item = (key: string) => h.state().workQueue!.items.find(found => found.key === key)!;
    const briefed = (text: string) => h.until(() => expect(h.prompts('lead').some(prompt => prompt.includes(text)), text).toBe(true));
    await h.until(() => expect(h.results.length + h.errors.length).toBe(7));
    expect(h.results).toEqual(expect.arrayContaining([
      { itemId: item('later').id, key: 'later', queue: 'q', status: 'pending', priority: 0, hold: true, holdReason: 'not before  the review', waitsOn: [{ key: 'ext', status: 'pending' }] },
      { itemId: item('approved').id, key: 'approved', queue: 'q', gate: true },
      { itemId: item('approved').id, key: 'approved', queue: 'q', status: 'completed', priority: 0, gate: true },
    ]));
    expect(h.errors.sort()).toEqual([
      expect.stringContaining('A gate is a condition that nobody claims: it takes no assignee, resources or writes'),
      expect.stringContaining('A gate is not handed out, so it takes no hold and no assignee'),
      expect.stringContaining('Only the main agent, the swarm lead, the lead of its queue or, for a gate, the member that added it can settle a work item'),
      expect.stringContaining('Only the main agent, the swarm lead, the lead of its queue or, for a gate, the member that added it can settle a work item'),
    ]);
    expect(item('approved')).toMatchObject({ status: 'completed', result: 'approved by the user', settledBy: 'scout', by: 'scout', gate: true });
    // Nothing of "q" can be claimed: a gate is handed to nobody, and both items wait. Its member is not started.
    await h.ticks(3);
    expect(h.turns('w1')).toEqual([]);
    const main = h.runtime.bindMain(h.root.scopeId, 'continue'); cleanup.push(async () => main.release());
    const op = (method: string, args: Record<string, unknown>) => callWorkflow(method, { operationId: randomUUID(), workflowId: h.state().workflowId, ...args }, main.env);
    const queue = () => callWorkflow('work_status', { workflowId: h.state().workflowId, queue: 'q' }, main.env) as Promise<{ items: Array<{ key: string }> }>;
    expect(await queue()).toMatchObject({ pending: 3, completed: 1, claimable: 0, blocked: 2, onHold: 1, gates: 1 });
    expect(await queue()).not.toHaveProperty('heldReady');
    expect((await queue()).items.find(found => found.key === 'flip')).toMatchObject({ waitsOn: [{ key: 'pushed', status: 'pending' }] });
    expect((await queue()).items.find(found => found.key === 'pushed')).toMatchObject({ gate: true, status: 'pending' });
    expect(await callWorkflow('work_status', { workflowId: h.state().workflowId, key: 'pushed' }, main.env)).toMatchObject({ gate: true, neededBy: ['flip'] });
    const status = await callWorkflow('status', { workflowId: h.state().workflowId }, main.env) as { swarms: Array<{ queues: Record<string, unknown> }> };
    expect(status.swarms[0]!.queues).toMatchObject({ q: { claimable: 0, blocked: 2, onHold: 1, gates: 1 } });
    // Neither waits on anyone yet: the item set aside still waits on other work, and the gate has not been open for long.
    expect(h.todos('aside')).toEqual([]);
    expect(h.todos('gate')).toEqual([]);

    // Whoever plans a queue ends the wait for work that was done some other way. The item that waited on it stays
    // aside, and that only its hold is left is a to-do of the lead that set it aside, which returns it.
    expect(await op('settle_work', { key: 'ext', result: 'done by hand' })).toMatchObject({ key: 'ext', status: 'completed', stillOnHold: ['later'] });
    expect(item('ext')).toMatchObject({ status: 'completed', result: 'done by hand', settledBy: 'main' });
    await expect(op('settle_work', { key: 'ext', result: 1 })).rejects.toThrow('Work item is already completed');
    await expect(op('settle_work', { key: 'flip' })).rejects.toThrow('settle_work requires result');
    await h.until(() => expect(item('later').status).toBe('completed'));
    await briefed('1 item set aside has nothing else in the way, and only the hold keeps it from being handed out: "later" (queue q, set aside by lead 0 min ago: not before the review). '
      + 'Do: decide each: update_work({key, hold: false}) returns it to the queue; cancel: true or supersededBy withdraws what is no longer wanted.');
    expect(item('later').held).toBeUndefined();
    await h.until(() => expect(h.todos('aside')).toEqual([]));
    expect(item('flip').status).toBe('pending');

    // A gate that has been open for an hour is asked about. It is still to come, so the lead says until when.
    await h.calm(); ahead.by(61 * MIN);
    await h.until(() => expect(h.todos('gate')).toMatchObject([{ told: [{ who: 'lead' }], deferred: { by: 'lead', note: 'The batch is pushed tonight', until: expect.any(Number) } }]));
    await briefed('1 gate nobody has declared met keeps work from being handed out: "pushed" (1 item waits, added 61 min ago: The batch is on main). '
      + 'Do: settle_work({key, result}) declares a gate met once what it stands for has happened, and what waits on it is handed out;');
    // The thing has happened: the gate is declared met, and what waited on it is handed out with nobody lifting anything.
    expect(await op('settle_work', { key: 'pushed', result: { head: 'abc123' } })).toMatchObject({ key: 'pushed', status: 'completed', gate: true, released: ['flip'] });
    await h.until(() => { expect(item('flip').status).toBe('completed'); expect(h.todos('gate')).toEqual([]); });
    expect(await queue()).toMatchObject({ pending: 0, claimable: 0, blocked: 0 });
    expect(await queue()).not.toHaveProperty('gates');
    expect(h.notices('todo')).toEqual([]);
    busy.release();
    await h.cancel();
  }, 30_000);

  it('keeps a swarm without a lead waiting for a gate, and tells the main agent, which is the one to settle it', async () => {
    const h = await play([
      'await enqueueWork({key:"go", title:"The user approved the draft", input:{}, queue:"q", gate:true});',
      'await enqueueWork({key:"a", title:"A", input:1, queue:"q"});',
      'await enqueueWork({key:"b", title:"B", input:2, queue:"q", dependsOn:["go"]});',
      'await closeWorkQueue({key:"close", queue:"q"});',
      'return await swarm("Do", {key:"wait", members:[{name:"w1", queue:"q"}]});',
    ].join('\n'), { w1: () => ({ work: true }) });
    const item = (key: string) => h.state().workQueue!.items.find(found => found.key === key)!;
    // The queue is closed and its member idle, with an item nobody can claim: the swarm waits instead of ending as
    // failed, and the gate, which nobody in it answers for, is the main agent's to-do at once.
    await h.until(() => { expect(item('a').status).toBe('completed'); expect(h.notices('todo')).toHaveLength(1); });
    await h.ticks(3);
    expect(h.notices('todo')).toMatchObject([{ acknowledged: false, subject: 'todo:1', summary: expect.stringContaining('1 个条件项尚未宣布达成，挡着后面的工作："go"（1 项在等）。条件已达成就用 settle_work({key,result}) 宣布') }]);
    expect(h.todos('gate')).toMatchObject([{ told: [{ who: 'main' }] }]);
    expect(h.state().swarms![0]).toMatchObject({ status: 'running' });
    expect(h.state().script).toMatchObject({ status: 'running' });
    expect(await h.asMain('settle_work', { key: 'go', result: 'approved in chat' })).toMatchObject({ key: 'go', status: 'completed', released: ['b'] });
    const { result } = await h.settled();
    expect(result).toMatchObject({ stop: 'quiet' });
    expect(item('b')).toMatchObject({ status: 'completed' });
    // The notice said that a gate was open, which is no longer so.
    expect(h.notices('todo')).toMatchObject([{ acknowledged: true }]);
    expect(h.errors).toEqual([]);
  }, 30_000);

  it('moves what waited on an item to the one that replaces it, and makes an item that waits on one that will never be done a to-do of whoever plans it', async () => {
    const ahead = clock();
    const w2 = gate();
    const h = await play([
      // Queue "plan" has no members: its items stay where they are until someone who plans them acts.
      'await enqueueWork({key:"plan-v1", title:"Plan v1", input:1, queue:"plan"});',
      'await enqueueWork({key:"impl", title:"Impl", input:2, queue:"q", dependsOn:["plan-v1"]});',
      'await enqueueWork({key:"verify", title:"Verify", input:3, queue:"q", dependsOn:["impl"]});',
      'await enqueueWork({key:"old", title:"Old", input:4, queue:"plan"});',
      'await enqueueWork({key:"needs-old", title:"Needs old", input:5, queue:"q", dependsOn:["old"]});',
      'await enqueueWork({key:"slow", title:"Slow", input:6, queue:"r"});',
      'await enqueueWork({key:"after-slow", title:"After slow", input:7, queue:"q", dependsOn:["slow"]});',
      'await enqueueWork({key:"look", title:"Look", input:8, assignee:"scout"});',
      'return await swarm("Do", {key:"revise", lead:{name:"lead"}, members:[{name:"w1", queue:"q"},{name:"w2", queue:"r"},{name:"scout"}]});',
    ].join('\n'), {
      w2: [{ claim: true, hold: w2.hold }], w1: () => ({ work: true }),
      // A revised plan is one step: the new item is added in place of the old one.
      lead: [{ calls: [['enqueue_work', { key: 'plan-v2', title: 'Plan v2', input: 1, queue: 'q', supersedes: ['plan-v1'] }], ['update_work', { key: 'old', cancel: true, reason: 'not needed' }]] }],
      // A member replaces what it added itself and nobody has claimed, and nothing else.
      scout: [{ work: true, calls: [['enqueue_work', { key: 's1', title: 'S1', input: 0, queue: 'plan' }], ['enqueue_work', { key: 's2', title: 'S2', input: 0, queue: 'plan', supersedes: 's1' }],
        ['enqueue_work', { key: 's3', title: 'S3', input: 0, queue: 'plan', supersedes: ['old'] }], ['update_work', { key: 's2', supersededBy: 'verify' }]] }],
    });
    const item = (key: string) => h.state().workQueue!.items.find(found => found.key === key)!;
    await h.until(() => { expect(h.results.length + h.errors.length).toBe(6); expect(item('slow').status).toBe('claimed'); expect(item('verify').status).toBe('completed'); });
    expect(h.results).toEqual(expect.arrayContaining([
      { itemId: item('plan-v2').id, key: 'plan-v2', queue: 'q', superseded: [{ key: 'plan-v1', status: 'cancelled' }], waitingOnIt: ['impl'] },
      { itemId: item('old').id, key: 'old', queue: 'plan', status: 'cancelled', priority: 0, blocks: ['needs-old'], note: expect.stringContaining('update_work({key: this key, supersededBy: its key})') },
      { itemId: item('s2').id, key: 's2', queue: 'plan', superseded: [{ key: 's1', status: 'cancelled' }] },
      expect.objectContaining({ key: 's2', status: 'cancelled', supersededBy: 'verify' }),
    ]));
    expect(h.errors).toEqual([expect.stringContaining('Only whoever plans its queue, or the member that added it while nobody has claimed it, can replace work item "old"')]);
    expect(item('s3')).toBeUndefined();
    // The old key stays what it was, a finished item that names its replacement, and nothing waits on it.
    expect(item('plan-v1')).toMatchObject({ status: 'cancelled', supersededBy: 'plan-v2', error: 'Superseded by "plan-v2" (lead)' });
    expect(item('plan-v2')).toMatchObject({ supersedes: ['plan-v1'], status: 'completed' });
    expect(item('impl')).toMatchObject({ dependsOn: ['plan-v2'], status: 'completed' });
    expect(item('s1')).toMatchObject({ status: 'cancelled', supersededBy: 's2', error: 'Superseded by "s2" (scout)' });

    // "needs-old" waits on a withdrawn item. Whoever withdrew it may be about to replace it, so it is nobody's to-do at once.
    const main = h.runtime.bindMain(h.root.scopeId, 'continue'); cleanup.push(async () => main.release());
    const op = (method: string, args: Record<string, unknown>) => callWorkflow(method, { operationId: randomUUID(), workflowId: h.state().workflowId, ...args }, main.env);
    await h.ticks(3);
    expect(h.todos('dead')).toEqual([]);
    expect(await callWorkflow('work_status', { workflowId: h.state().workflowId, queue: 'q' }, main.env)).toMatchObject({ claimable: 0, blocked: 2, stuck: 1 });
    await h.calm(); ahead.by(11 * MIN);
    await h.until(() => expect(h.todos('dead')).toMatchObject([{ told: [{ who: 'lead' }] }]));
    await h.until(() => expect(h.prompts('lead').some(prompt => prompt.includes('1 item waits on an item that was cancelled or has failed for good, and will not be handed out as things stand: '
      + '"needs-old" (queue q) waits on "old" (cancelled: Cancelled by lead: not needed). Do: for each, one of: update_work({key: <the dependency>, supersededBy: <the item that took its place>})'))).toBe(true));

    // What is not allowed to wait: on itself, or on what waits on it.
    await expect(op('update_work', { key: 'needs-old', dependsOn: ['needs-old'] })).rejects.toThrow('A work item cannot wait on itself');
    await expect(op('update_work', { key: 'needs-old', dependsOn: ['nope'] })).rejects.toThrow('Dependencies must reference existing work keys');
    await expect(op('update_work', { key: 'after-slow', supersededBy: 'nope' })).rejects.toThrow('supersededBy is the key of an existing work item');
    await expect(op('update_work', { key: 'old', supersededBy: 'needs-old' })).rejects.toThrow('"needs-old" waits on "old", the item it replaces');
    await expect(op('enqueue_work', { key: 'loop', title: 'Loop', input: 0, queue: 'plan', dependsOn: ['after-slow'], supersedes: ['slow'] })).rejects.toThrow('"loop" waits on "slow", the item it replaces, and would never be handed out');
    await expect(op('update_work', { key: 'needs-old', supersededBy: 'needs-old' })).rejects.toThrow('A work item cannot replace itself');

    // Naming the replacement of a withdrawn item afterwards revives what waited on it, and with that the to-do is gone.
    expect(await op('update_work', { key: 'old', supersededBy: 'plan-v2' })).toMatchObject({ key: 'old', status: 'cancelled', supersededBy: 'plan-v2', nowWaitOnIt: ['needs-old'] });
    expect(item('needs-old')).toMatchObject({ dependsOn: ['plan-v2'] });
    await expect(op('update_work', { key: 'old', supersededBy: 'impl' })).rejects.toThrow('Work item "old" was already replaced by "plan-v2"');
    await h.until(() => { expect(item('needs-old').status).toBe('completed'); expect(h.todos('dead')).toEqual([]); });

    // An item a member holds is replaced as well: what waited on it moves at once, the member is told, and the item
    // is withdrawn instead of returning to the queue when the member hands it back.
    expect(await op('update_work', { key: 'slow', supersededBy: 'plan-v2' })).toMatchObject({ key: 'slow', status: 'claimed', supersededBy: 'plan-v2', nowWaitOnIt: ['after-slow'], claimedBy: 'w2' });
    await h.until(() => expect(item('after-slow').status).toBe('completed'));
    w2.release();
    await h.until(() => { expect(item('slow').status).toBe('cancelled'); expect(h.turns('w2')).toHaveLength(2); });
    expect(item('slow').error).toMatch(/^Superseded by "plan-v2"; the claim ended: /);
    expect(h.prompts('w2')[1]).toContain('which you held when this was sent, was replaced by');
    expect(h.prompts('w2')[1]).toContain('(by the main agent): what waited on it now waits on the replacement.');

    // Work added later under the old key's name waits on what took its place.
    expect(await op('enqueue_work', { key: 'late', title: 'Late', input: 9, queue: 'q', dependsOn: ['plan-v1', 'slow'] })).toMatchObject({ key: 'late' });
    expect(item('late').dependsOn).toEqual(['plan-v2']);
    await h.until(() => expect(item('late').status).toBe('completed'));
    // A dependency list can be replaced or emptied by whoever plans the item.
    expect(await op('enqueue_work', { key: 'last', title: 'Last', input: 9, queue: 'plan', dependsOn: ['s2'] })).toMatchObject({ key: 'last' });
    expect(item('last').dependsOn).toEqual(['verify']);
    expect(await op('update_work', { key: 'last', dependsOn: ['after-slow', 'impl'] })).toMatchObject({ key: 'last', status: 'pending' });
    expect(item('last').dependsOn).toEqual(['after-slow', 'impl']);
    expect(await op('update_work', { key: 'last', dependsOn: [] })).toMatchObject({ key: 'last', status: 'pending' });
    expect(item('last').dependsOn).toBeUndefined();
    await h.cancel();
  }, 30_000);

  it('returns what is found wrong with a delivered item to the member that delivered it, and to its queue once that member cannot take it', async () => {
    const h = await play([
      // "a" is for w2 although w1 is the first to be woken: a script may name a member before its swarm starts.
      'await enqueueWork({key:"a", title:"A", input:1, queue:"build", assignee:"w2"}); await enqueueWork({key:"b", title:"B", input:2, queue:"build"});',
      'await enqueueWork({key:"hunt-a", title:"Hunt in A", input:3, queue:"hunt", dependsOn:["a"]});',
      'return await swarm("Build and hunt", {key:"opt", maxTurns:1, members:[{name:"w1", queue:"build"},{name:"w2", queue:"build"},{name:"scout", queue:"hunt"}]});',
    ].join('\n'), {
      w1: [{ work: true }, { work: true }],
      w2: [{ work: true }, { work: true }],
      // The scout names the item its finding came from, not a queue or a member; its next hunt waits for the repair.
      scout: [{ work: true, calls: [['enqueue_work', { key: 'bug-a', title: 'A drops the last token', input: { repro: 'a("")' }, origin: 'a' }],
        ['enqueue_work', { key: 'hunt-again', title: 'Hunt in the repair', input: 4, queue: 'hunt', dependsOn: ['bug-a'] }]] },
      { work: true, calls: [['enqueue_work', { key: 'bug-a2', title: 'A still drops it', input: { repro: 'a(" ")' }, origin: 'a' }]] }],
    });
    const item = (key: string) => h.state().workQueue!.items.find(found => found.key === key)!;
    await h.until(() => expect(item('bug-a2')?.status).toBe('completed'));
    expect(h.errors).toEqual([]);
    expect(item('a')).toMatchObject({ assignee: 'w2', doneBy: 'w2' });
    expect(item('b')).toMatchObject({ doneBy: 'w1' });
    // The finding went to the queue "a" was in and to the member that completed "a", which alone was woken for it.
    expect(h.results[0]).toMatchObject({ key: 'bug-a', queue: 'build', assignee: 'w2' });
    expect(h.results[0]).not.toHaveProperty('assigneeNote');
    expect(item('bug-a')).toMatchObject({ queue: 'build', by: 'scout', origin: 'a', assignee: 'w2', doneBy: 'w2' });
    expect(h.prompts('w2')[1]).toContain('Queue "build" has 1 item you can claim, 1 of them kept for you (claim_work hands those out first; item.origin names the delivered item one is about): take them with claim_work until it returns null.');
    // w2 has then used the one wake-up it had: the next finding in its work is anyone's in the queue, and says so.
    expect(h.results[2]).toMatchObject({ key: 'bug-a2', queue: 'build', assignee: 'w2', assigneeNote: expect.stringContaining('any member of the queue can claim it') });
    expect(item('bug-a2')).toMatchObject({ origin: 'a', assignee: 'w2', doneBy: 'w1' });
    expect([h.turns('w1'), h.turns('w2')]).toEqual([['w11', 'w12'], ['w21', 'w22']]);
    // w1 was idle while "bug-a" waited for w2, and was not woken until an item was open to it.
    expect(h.order.indexOf('w12')).toBeGreaterThan(h.order.indexOf('scout2'));
    expect(h.prompts('w1')[1]).not.toContain('kept for you');
    await h.cancel();
  }, 30_000);

  it('returns an item to its whole queue when the member it is kept for was woken for it and did not take it', async () => {
    const h = await play('await enqueueWork({key:"a", title:"A", input:1, queue:"build", assignee:"w2"});'
      + 'return await swarm("Build", {key:"pass", members:[{name:"w1", queue:"build"},{name:"w2", queue:"build"}]});', { w1: [{ work: true }], w2: [{}] });
    const item = () => h.state().workQueue!.items[0]!;
    await h.until(() => expect(item().status).toBe('completed'));
    // w1 had nothing to claim while "a" was kept for w2, so it was first woken once w2 had passed the item up.
    expect(h.order).toEqual(['w21', 'w11']);
    expect(item()).toMatchObject({ doneBy: 'w1' });
    expect(item().assignee).toBeUndefined();
    await h.cancel();
  }, 30_000);

  it('takes an ask that stays open to those above the member asked, a level at a time, and lets a lead, and only a lead with nobody else above it, ask the main agent', async () => {
    const ahead = clock();
    const busy = gate();
    const h = await play([
      'await enqueueWork({key:"a", title:"A", input:1, queue:"q"}); await enqueueWork({key:"job", title:"Job", input:2, assignee:"busy"}); await enqueueWork({key:"look", title:"Look", input:3, assignee:"peer"});',
      'return await swarm("Build the parser", {key:"s", lead:{name:"lead"}, members:[{name:"ql", leads:["q"]},{name:"w1", queue:"q"},{name:"peer"},{name:"busy"}]});',
    ].join('\n'), {
      busy: [{ claim: true, hold: busy.hold, complete: true }],
      peer: [{ work: true, ask: { to: 'w1', text: 'Which entry point does the parser export? I call it from the CLI.', withinMinutes: 1 } }],
      // Woken by the ask, w1 leaves it open; it may not take its own question past its leads.
      w1: [{ work: true }, { calls: [['ask', { to: 'main', text: 'May I skip the tests?' }]] }],
      // The lead answers what was asked of it, asking the main agent in turn, and what came up to it in the place of the member asked.
      lead: (_turn, state) => {
        const me = state.agents!.find(agent => agent.key === 'lead')?.agentId;
        const mine = state.board?.asks?.find(ask => ask.to === me);
        const up = state.todos?.open.find(todo => todo.kind === 'ask' && todo.told.length > 1 && todo.told.at(-1)!.who === 'lead');
        return mine ? { calls: [['answer', { ask: mine.seq, text: 'Yes, the parser is done.' }], ['ask', { to: 'main', text: 'May it ship without the fuzz run?', withinMinutes: 20 }]] }
          : up ? { calls: [['answer', { ask: Number(up.subject.slice(4)), text: 'It exports parse_entry.' }]] } : {};
      },
    });
    const id = (name: string) => h.state().agents!.find(agent => agent.key === name)!.agentId;
    const asks = () => h.state().board?.asks ?? [];
    const went = () => h.todos('ask').map(todo => todo.told.map(told => told.who));
    await h.until(() => { expect(h.turns('w1')).toHaveLength(2); expect(h.errors).toHaveLength(1); });
    expect(h.errors[0]).toContain('Ask the lead above you (ql), which asks the main agent what it cannot answer itself');
    const seq = asks()[0]!.seq;
    expect(asks()).toMatchObject([{ seq, from: id('peer'), to: id('w1'), within: 60_000 }]);
    // The turn the ask woke w1 for opens with it, and so does every later one until it is answered.
    expect(h.prompts('w1')[1]).toMatch(new RegExp(`1 to-do waits on you; deal with it before other work:\\n- #\\d+ \\(0 min\\) Ask ${seq} from peer: "Which entry point does the parser export\\? I call it from the CLI\\." Do: answer\\(\\{ask: ${seq}, text\\}\\); when you cannot answer yet, answer with what it waits on\\.`));
    expect(went()).toEqual([['w1']]);

    // Its time runs out: the lead of w1's queue hears of it first, then the lead of the swarm, each once.
    await h.calm(); ahead.by(61_000);
    await h.until(() => { expect(went()).toEqual([['w1', 'ql']]); expect(h.turns('ql')).toHaveLength(2); });
    expect(h.prompts('ql')[1]).toContain(` (1 min, left open by w1) Ask ${seq} from peer to w1 has had no answer for 1 min (w1 is between turns): "Which entry point does the parser export? I call it from the CLI." `
      + `Do: answer in its place with answer({ask: ${seq}, text}), or have w1 answer (tell_worker reaches it in its turn).`);
    await h.ticks(3);
    expect(went()).toEqual([['w1', 'ql']]);
    // The lead answers in w1's place: the answer goes to peer, the ask is closed, and the main agent never heard of it.
    await h.calm(); ahead.by(61_000);
    await h.until(() => { expect(asks()).toEqual([]); expect(h.turns('peer')).toHaveLength(2); });
    expect(h.prompts('lead').some(prompt => prompt.includes(`min, left open by w1, ql) Ask ${seq} from peer to w1 has had no answer for 2 min`))).toBe(true);
    const answer = h.state().board!.posts.find(post => post.answers === seq)!;
    expect(answer).toMatchObject({ from: id('lead'), to: [id('peer')], text: 'It exports parse_entry.' });
    expect(h.state().board!.posts.find(post => post.seq === seq)).toMatchObject({ ask: { within: 60_000 }, resolved: { from: id('lead'), see: answer.seq } });
    expect(h.prompts('peer')[1]).toContain('It exports parse_entry.');
    expect(h.todos('ask')).toEqual([]);
    expect([h.notices('todo'), h.notices('ask')]).toEqual([[], []]);

    // An ask from the main agent does not wait out the gap in which a lead's results are gathered, and its answer
    // comes back as a reply. The lead of the swarm has only the main agent above it, and asks it: that is an ask
    // the main agent is told of at once, and its notice stands until the answer.
    const asked = await h.asMain('ask', { to: 'lead', text: 'Is the parser done?' }) as { ask: number };
    await h.until(() => { expect(h.notices('worker_reply')).toHaveLength(1); expect(h.notices('ask')).toHaveLength(1); });
    expect(h.notices('worker_reply')).toMatchObject([{ summary: expect.stringContaining('Yes, the parser is done.') }]);
    expect(h.notices('worker_reply')[0]!.summary).toContain(`第 ${asked.ask} 帖`);
    const request = h.notices('ask')[0]!;
    const mine = asks()[0]!.seq;
    expect(request).toMatchObject({ acknowledged: false, summary: expect.stringMatching(new RegExp(`^待办 #\\d+：lead 请你答复（第 ${mine} 帖，它等 20 分钟）：May it ship without the fuzz run\\?。用 answer\\(\\{ask:${mine},text\\}\\) 答复`)) });
    expect(await h.asMain('answer', { ask: mine, text: 'No: run it first.' })).toMatchObject({ ask: mine });
    expect(h.notices('ask')).toMatchObject([{ acknowledged: true }]);
    expect(asks()).toEqual([]);
    await h.until(() => expect(h.prompts('lead').at(-1)).toContain('No: run it first.'));
    expect(h.errors).toHaveLength(1);
    busy.release();
    await h.cancel();
  }, 60_000);

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
    // Leads form a tree under the swarm's lead: only a lead names the lead it answers to, which is another lead, and never in a circle.
    expect(await run({ key: 't', lead: { name: 'l' }, members: [{ name: 'a', queue: 'q', under: 'l' }] })).toContain('under names the lead a lead answers to; a member that consumes a queue answers to the lead of that queue');
    expect(await run({ key: 't', lead: { name: 'l' }, members: [{ name: 'a', leads: 'q', under: 'b' }, { name: 'b', queue: 'q' }] })).toContain('under names another member that leads queues; "b" is not one');
    expect(await run({ key: 't', lead: { name: 'l' }, members: [{ name: 'a', leads: 'q', under: 'l' }] })).toContain('under names another member that leads queues; "l" is not one (a lead answers to the swarm lead when it names none)');
    expect(await run({ key: 't', lead: { name: 'l' }, members: [{ name: 'a', leads: 'q', under: 'b' }, { name: 'b', leads: 'r', under: 'a' }] })).toContain('Leads cannot answer to each other in a circle');
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

    const noted = await main('note', { text: 'note for everyone' }) as { seq: number; stateVersion: number };
    expect(noted.stateVersion).toBe(h.state().stateVersion);
    await expect(main('note', { text: 'sent with an old version', expectedStateVersion: stale })).resolves.toMatchObject({ seq: noted.seq + 1 });
    await expect(main('set_goal', { text: 'Ship the fix; tests must pass.' })).resolves.toMatchObject({ stateVersion: expect.any(Number), goalVersion: 1 });
    await expect(main('enqueue_work', { key: 'item-1', title: 'First item', input: 'do it' })).resolves.toMatchObject({ itemId: expect.any(String) });

    // A repeated operationId returns the recorded response instead of appending twice.
    const operationId = randomUUID();
    const first = await main('note', { operationId, text: 'once' });
    expect(await main('note', { operationId, text: 'once' })).toEqual(first);
    await expect(main('note', { operationId, text: 'different' })).rejects.toThrow('operationId conflict');

    // Staffing and an item's attempts are checked against the state the change commits on, not against a version.
    await expect(main('retry_work', { itemId: 'missing' })).rejects.toThrow('Unknown work item');
    await expect(main('staff_swarm', { add: ['x'] })).rejects.toThrow('none is running');
    await expect(main('close_work_queue', {})).rejects.toThrow('stateVersion conflict');
    await expect(main('pause', { expectedStateVersion: stale })).rejects.toThrow('stateVersion conflict');
    // An operation that was replaced says what took its place.
    await expect(main('post_board', { text: 'x' })).rejects.toThrow('post_board is no longer an operation: ask({to,text}) asks one member for an answer or an action, answer({ask,text}) answers an ask, and note({text,topic?}) records what nobody has to act on.');
    await expect(main('set_charter', { text: 'x' })).rejects.toThrow('set_charter is no longer an operation: the main agent sets the goal with set_goal(text)');
  });
});
