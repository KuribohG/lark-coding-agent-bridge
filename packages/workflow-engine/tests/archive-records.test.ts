import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ARCHIVE_AFTER_MS, KEEP_RECENT } from '../src/engine/archive';
import { WorkflowKernel } from '../src/engine/kernel';
import type { WorkflowRoot, WorkflowWorkerRequest, WorkflowWorkerResult } from '../src/engine/types';

const cleanup: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

type Feed = { posts: Array<{ seq: number; text: string }>; lastSeq: number; hasMore: boolean };
type Grant = { claimId: string; generation: number; item: { key: string } };

/** Workers answer at once unless `manual`, in which case the test ends each turn itself. */
function harness(manual = false) {
  const root: WorkflowRoot = { scopeId: 'archive-records', profile: 'default', agentKind: 'codex', cwdRealpath: '/workspace',
    policyFingerprint: 'policy', catalogBinding: 'root', modelSettings: {} };
  const clock = { now: 1_000_000 };
  const requests: WorkflowWorkerRequest[] = [];
  const finishers = new Map<string, (result: WorkflowWorkerResult) => void>();
  const host = { resolveRoot: async () => root, wakeMain: async () => {},
    execute: async (request: WorkflowWorkerRequest): Promise<WorkflowWorkerResult> => {
      requests.push(request);
      request.onRun('run-' + request.attemptId);
      request.onSession(request.session.nativeSessionId ?? 'native-' + request.session.actorId);
      if (!manual) return { status: 'completed', text: 'done' };
      return new Promise(resolve => {
        finishers.set(request.attemptId, resolve);
        request.signal.addEventListener('abort', () => resolve({ status: 'stopped' }), { once: true });
      });
    } };
  const kernel = new WorkflowKernel(':memory:', host, () => clock.now);
  cleanup.push(async () => { for (const finish of finishers.values()) finish({ status: 'stopped' }); await kernel.close(); });
  const state = () => kernel.state(root.scopeId)!;
  const ids = () => [root.scopeId, state().workflowId, state().script!.runId] as const;
  const call = (method: string, args: Record<string, unknown> = {}) => kernel.call({ kind: 'main', scopeId: root.scopeId, allowStart: true }, method,
    { operationId: randomUUID(), workflowId: state()?.workflowId, expectedStateVersion: state()?.stateVersion, ...args });
  const worker = (request: WorkflowWorkerRequest, method: string, args: Record<string, unknown> = {}) => kernel.call(
    { kind: 'worker', scopeId: root.scopeId, workflowId: state().workflowId, taskId: request.task.taskId, attemptId: request.attemptId }, method, args);
  const begin = () => kernel.beginScript(root.scopeId, state().workflowId);
  const turn = async (member: string, key: string) => {
    const { taskId } = await kernel.scriptAgent(...ids(), { member, key, prompt: 'work' });
    const count = requests.length;
    await kernel.tick();
    if (manual) { await vi.waitFor(() => expect(requests).toHaveLength(count + 1)); return requests.at(-1)!; }
    await vi.waitFor(() => expect(kernel.scriptTaskResult(...ids(), taskId)).toBeDefined());
    return requests.at(-1)!;
  };
  const finish = async (request: WorkflowWorkerRequest) => {
    finishers.get(request.attemptId)!({ status: 'completed', text: 'done' });
    await vi.waitFor(() => expect(state().tasks.find(task => task.taskId === request.task.taskId)!.status).toBe('result_ready'));
  };
  return { kernel, root, clock, requests, state, ids, call, worker, begin, turn, finish,
    start: async () => { await call('run_script', { goal: 'Coordinate', plan: 'Members coordinate.', script: 'return null;', maxAgents: 100_000 }); begin(); },
    replay: async () => { await call('pause'); await call('replay_script'); begin(); },
    mail: (args: Record<string, unknown>) => kernel.scriptMailbox(...ids(), args),
    received: (receiptId: string) => kernel.scriptMailboxResult(...ids(), receiptId) as Array<{ text: string; post: number }>,
    work: (args: Record<string, unknown>) => kernel.scriptWork(...ids(), args) as Promise<Record<string, unknown>>,
    wait: (key: string, any: unknown[]) => kernel.scriptControl(...ids(), { kind: 'wait', key, any }),
    waited: (pending: { kind: string; waitId?: string }) => kernel.scriptControlResult(...ids(), pending),
    /** Lets everything settled age past the archive window and gives the scheduler a pass over the workflow. */
    age: async () => { clock.now += ARCHIVE_AFTER_MS + 60_000; await kernel.tick(); } };
}

// Replaying the whole journal after every commit is quadratic in a run this long; the other cases keep the check on.
function withoutVerification() {
  const verify = process.env.WORKFLOW_ENGINE_VERIFY;
  process.env.WORKFLOW_ENGINE_VERIFY = '0';
  cleanup.push(() => { process.env.WORKFLOW_ENGINE_VERIFY = verify; });
}

describe('archiving the other lists of a workflow', () => {
  it('keeps the board feed, deliveries and receives readable after they leave the state', async () => {
    withoutVerification();
    const h = harness();
    await h.start();
    await h.turn('alice', 'alice-init');
    const rounds = 80, each = 8;
    let first = '';
    for (let round = 0; round < rounds; round++) {
      for (let index = 0; index < each; index++) await h.call('post_board', { text: `post ${round * each + index + 1}th`, to: index % 2 ? ['alice'] : 'all' });
      const { receiptId } = await h.mail({ kind: 'receive', member: 'alice', key: 'inbox-' + round }) as { receiptId: string };
      first ||= receiptId;
      await h.turn('alice', 'turn-' + round);
    }
    const total = rounds * each;
    await h.age();
    const state = h.state();
    expect(state.board!.posts).toHaveLength(KEEP_RECENT);
    expect(state.board!.posts[0]!.seq).toBe(total - KEEP_RECENT + 1);
    expect(state.archivedRecords).toMatchObject({ post: total - KEEP_RECENT, message: total, receipt: rounds });
    expect(state.mailbox!.messages).toHaveLength(0);
    expect(state.mailbox!.receipts).toHaveLength(0);

    const head = await h.call('read_board', { after: 0, limit: 3 }) as Feed;
    expect(head).toMatchObject({ posts: [{ seq: 1, text: 'post 1th' }, { seq: 2 }, { seq: 3 }], lastSeq: total, hasMore: true });
    // A read that starts in the archive and ends in the state.
    const seam = await h.call('read_board', { after: total - KEEP_RECENT - 2, limit: 4 }) as Feed;
    expect(seam.posts.map(post => post.seq)).toEqual([-1, 0, 1, 2].map(offset => total - KEEP_RECENT + offset));
    expect((await h.call('read_board', { limit: 2 }) as Feed).posts.map(post => post.seq)).toEqual([total - 1, total]);
    // A search covers the archived posts and the ones in the state, newest first, and returns the text around the match.
    // The archive tests the words against a post's whole stored entry, IDs included, so the query is one no UUID contains.
    const found = await h.call('search_board', { query: '17TH POST', limit: 30 }) as { matches: number; hasMore: boolean; posts: Array<{ seq: number; snippet: string }> };
    expect(found.posts.map(post => post.seq)).toEqual([617, 517, 417, 317, 217, 117, 17]);
    expect(found).toMatchObject({ matches: 7, hasMore: false });
    expect(found.posts[0]).toEqual({ seq: 617, from: 'main', to: ['alice'], all: true, snippet: 'post 617th', at: expect.any(Number) });
    expect(await h.call('search_board', { query: 'post 17th', limit: 2 })).toMatchObject({ matches: 7, hasMore: true, posts: [{ seq: 617 }, { seq: 517 }] });
    expect(await h.call('search_board', { query: 'post absent' })).toMatchObject({ matches: 0, posts: [] });
    expect(await h.call('post_board', { text: 'one more' })).toMatchObject({ seq: total + 1 });
    expect((await h.call('status') as { mailbox: { totalMessages: number } }).mailbox.totalMessages).toBe(total);

    // The receive of the first round still yields its batch, to this run and to a replayed one.
    expect(h.received(first).map(message => message.text)).toEqual(Array.from({ length: each }, (_, index) => 'post ' + (index + 1) + 'th'));
    await h.replay();
    await h.turn('alice', 'alice-init');
    const again = await h.mail({ kind: 'receive', member: 'alice', key: 'inbox-0' }) as { receiptId: string };
    expect(again.receiptId).toBe(first);
    expect(h.received(first).map(message => message.post)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(h.requests).toHaveLength(rounds + 1);
  }, 120_000);

  it('counts archived work items and answers their keys, dependencies and repeated operations', async () => {
    const h = harness(true);
    await h.start();
    const total = 200;
    const itemIds: string[] = [];
    for (let index = 0; index < total; index++) itemIds.push((await h.work({ kind: 'enqueue', key: 'item-' + index, title: 'Item ' + index, input: { index } })).itemId as string);
    const request = await h.turn('worker', 'drain');
    let last: Grant | undefined;
    for (let index = 0; index < total; index++) {
      const grant = await h.worker(request, 'claim_work', { operationId: 'claim-' + index }) as Grant;
      await h.worker(request, 'complete_work', { operationId: 'done-' + index, claimId: grant.claimId, generation: grant.generation, result: { ok: grant.item.key } });
      last = grant;
    }
    expect(await h.worker(request, 'claim_work', { operationId: 'claim-none' })).toBeNull();
    await h.finish(request);
    await h.age();

    const queue = h.state().workQueue!;
    expect(queue.items).toHaveLength(0);
    expect(queue.claims).toHaveLength(0);
    expect(queue.operations).toHaveLength(KEEP_RECENT);
    expect(queue.archived).toEqual({ default: { completed: total } });
    expect(await h.work({ kind: 'status' })).toMatchObject({ total, archived: total, completed: total, pending: 0, items: [] });
    expect(await h.work({ kind: 'status', itemId: itemIds[5] })).toMatchObject({ key: 'item-5', status: 'completed', result: { ok: 'item-5' } });
    // An operation of the turn that has left the recent window still answers a repeat instead of acting again.
    await expect(h.work({ kind: 'enqueue', key: 'item-5', title: 'Item 5', input: { index: 5 } })).rejects.toThrow('Duplicate script key');
    expect(last).toBeDefined();

    // New work may depend on an archived item and is claimable at once.
    await h.work({ kind: 'enqueue', key: 'follow-up', title: 'Follow up', input: null, dependsOn: ['item-0'] });
    const next = await h.turn('worker', 'follow');
    expect(await h.worker(next, 'claim_work', { operationId: 'claim-follow' })).toMatchObject({ item: { key: 'follow-up' } });
    // A member finds finished work by words of its key, input or result, although none of it is in the state any more.
    type Hits = { matches: number; items: Array<{ itemId: string; key: string; status: string; in: string; snippet: string }> };
    const byKey = await h.worker(next, 'search_work', { query: 'ITEM-5', limit: 30 }) as Hits;
    expect(byKey.items.map(item => item.key).sort()).toEqual(['item-5', ...Array.from({ length: 10 }, (_, index) => 'item-5' + index)]);
    expect(byKey.items.find(item => item.key === 'item-5')).toMatchObject({ itemId: itemIds[5], status: 'completed' });
    expect(await h.worker(next, 'search_work', { query: 'ok item-199' })).toMatchObject({ matches: 1, items: [{ key: 'item-199', in: 'result', snippet: '{"ok":"item-199"}' }] });
    // A word with a quote is not tested in SQL; the match itself still decides.
    expect(await h.call('search_work', { query: '"index":199' })).toMatchObject({ matches: 1, items: [{ key: 'item-199', in: 'input' }] });
    expect(await h.call('search_work', { query: 'follow', status: 'claimed' })).toMatchObject({ matches: 1, items: [{ key: 'follow-up', in: 'key' }] });
    expect(await h.call('search_work', { query: 'item', status: 'pending' })).toMatchObject({ matches: 0 });
    expect(await h.call('search_work', { query: 'item', queue: 'other' })).toMatchObject({ matches: 0 });
    await h.worker(next, 'release_claim', { operationId: 'release-follow', claimId: (await h.worker(next, 'claim_work', { operationId: 'claim-follow' }) as Grant).claimId, generation: 1, reason: 'later' });
    await h.finish(next);

    // In a replayed run the key is taken: the same input answers with the archived item, a different one conflicts.
    await h.replay();
    expect(await h.work({ kind: 'enqueue', key: 'item-5', title: 'Item 5', input: { index: 5 } })).toMatchObject({ itemId: itemIds[5] });
    await expect(h.work({ kind: 'enqueue', key: 'item-6', title: 'Item 6', input: { index: 7 } })).rejects.toThrow('Work key conflict');
  }, 120_000);

  it('settles replayed waits from the archive and keeps script keys unique past the recent window', async () => {
    const h = harness();
    await h.start();
    const total = 400;
    const waits: Array<{ waitId?: string }> = [];
    for (let index = 0; index < total; index++) waits.push(await h.wait('tick-' + index, [{ kind: 'timer', afterMs: 0 }]));
    await h.age();
    const state = h.state();
    expect(state.waits).toHaveLength(0);
    expect(state.script!.controlCalls).toHaveLength(KEEP_RECENT);
    expect(state.archivedRecords).toMatchObject({ wait: total, controlCall: total - KEEP_RECENT });
    expect(h.waited({ kind: 'wait', waitId: waits[0]!.waitId })).toMatchObject({ index: 0, kind: 'timer' });
    await expect(h.wait('tick-0', [{ kind: 'timer', afterMs: 0 }])).rejects.toThrow('Duplicate script control key');
    // A key that belongs to a wait cannot become another kind of operation.
    await expect(h.mail({ kind: 'post', key: 'tick-3', text: 'reuse' })).rejects.toThrow('already belongs to a control operation');

    await h.replay();
    expect(h.state().archivedRecords!.controlCall).toBe(0);
    const again = await h.wait('tick-0', [{ kind: 'timer', afterMs: 0 }]);
    expect(again.waitId).toBe(waits[0]!.waitId);
    expect(h.waited({ kind: 'wait', waitId: again.waitId })).toMatchObject({ kind: 'timer' });
    await expect(h.wait('tick-1', [{ kind: 'timer', afterMs: 5 }])).rejects.toThrow('Wait key conflict');
  }, 120_000);
});
