import { statSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DashboardApi } from '../src/dashboard/api';
import { dashboardSource } from '../src/dashboard/cli';
import { WorkflowJournal } from '../src/dashboard/journal';
import page from '../src/dashboard/page.html';
import { startDashboard } from '../src/dashboard/server';
import { board, member, members, overview, summarize, turn, turns, work, workItem, type ViewSource } from '../src/dashboard/views';
import { emit, WorkflowStore, type WorkflowArchive, type WorkflowStoreOptions } from '../src/engine/kernel-store';
import { SCRIPT_DEFINITION } from '../src/engine/script-contract';
import type { BoardPost, WorkflowData, WorkflowState, WorkflowView, WorkflowWorkItem } from '../src/engine/types';

const cleanup: Array<() => unknown> = [];
const verify = process.env.WORKFLOW_ENGINE_VERIFY;
// Compaction deletes the events a snapshot covers, which verification would replay from the first one.
beforeEach(() => { process.env.WORKFLOW_ENGINE_VERIFY = '0'; });
afterEach(async () => {
  process.env.WORKFLOW_ENGINE_VERIFY = verify;
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function file(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'workflow-dashboard-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  return join(directory, 'workflows.sqlite');
}

function writer(path: string, options: WorkflowStoreOptions = {}): WorkflowStore {
  const store = new WorkflowStore(path, () => 1_000, options);
  cleanup.push(() => store.close());
  return store;
}

function reader(path: string): WorkflowJournal {
  const journal = new WorkflowJournal(path);
  cleanup.push(() => journal.close());
  return journal;
}

function initial(id: string): WorkflowData {
  return { workflowId: id, root: { scopeId: 'scope-' + id, profile: 'default', agentKind: 'codex', cwdRealpath: '/workspace',
    policyFingerprint: 'policy', catalogBinding: 'root', modelSettings: { model: 'm1' } }, definition: structuredClone(SCRIPT_DEFINITION),
  definitionDigest: 'digest', goal: 'the goal of ' + id, stateVersion: 0, status: 'active', createdAt: 1, deadlineAt: 2, sessions: [], tasks: [], artifacts: [], events: [] };
}

function start(store: WorkflowStore, id: string): WorkflowView {
  return store.transact(() => {
    const state = store.create(initial(id));
    emit(state, { type: 'script_set', script: { name: 'script ' + id, sourceRef: 'artifact:source', args: null, defaults: { agentKind: 'codex' },
      runId: 'run-1', revision: 0, status: 'running', maxCalls: 8, calls: [], logs: [] } });
    return state;
  });
}

const log = (store: WorkflowStore, id: string, text: string) => store.transact(() => emit(store.byId(id)!, { type: 'script_logged', text }));
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

describe('a journal read beside its writer', () => {
  it('follows the events the writer commits and hands out the same copy while nothing changes', async () => {
    const path = await file();
    const store = writer(path);
    start(store, 'a');
    const journal = reader(path);
    const first = journal.state('a')!;
    expect(first.state.script?.name).toBe('script a');
    expect(journal.state('a')).toBe(first);

    log(store, 'a', 'one');
    log(store, 'a', 'two');
    const second = journal.state('a')!;
    expect(second).not.toBe(first);
    expect(second.seq).toBeGreaterThan(first.seq);
    expect(second.state.script?.logs).toEqual(['one', 'two']);
    expect(plain(second.state)).toEqual(plain(store.public(store.byId('a')!)));
    expect(journal.position()).toBe(second.seq);
    // What was handed out earlier is a detached copy.
    expect(first.state.script?.logs).toEqual([]);
  });

  it('loads the snapshot again when the writer has compacted the journal past what it had read', async () => {
    const path = await file();
    const store = writer(path, { snapshotEvery: 2 });
    start(store, 'a');
    const journal = reader(path);
    const before = journal.state('a')!;
    for (const text of ['one', 'two', 'three', 'four']) log(store, 'a', text);
    await store.maintenance({ finishedBefore: 0 });
    log(store, 'a', 'five');
    // The events between what the reader had applied and the snapshot are gone from the file.
    const db = new Database(path, { readonly: true });
    cleanup.push(() => db.close());
    expect((db.prepare('SELECT min(seq) AS seq FROM wf_events').get() as { seq: number }).seq).toBeGreaterThan(before.seq + 1);

    const after = journal.state('a')!;
    expect(after.state.script?.logs).toEqual(['one', 'two', 'three', 'four', 'five']);
    expect(plain(after.state)).toEqual(plain(store.public(store.byId('a')!)));
    expect(journal.recent('a', 10).map(entry => entry.type)).toContain('script_logged');
  });

  it('lists workflows that began after it was opened, and finished roots after the open ones', async () => {
    const path = await file();
    const store = writer(path);
    start(store, 'a');
    const journal = reader(path);
    start(store, 'b');
    store.transact(() => emit(store.byId('a')!, { type: 'workflow_completed' }));
    const catalog = journal.catalog();
    expect(catalog.rows.map(row => [row.id, row.status])).toEqual([['b', 'active'], ['a', 'completed']]);
    expect(catalog.finished).toBe(1);
    expect(journal.state('b')?.state.goal).toBe('the goal of b');
    expect(journal.tree('a').map(row => row.id)).toEqual(['a']);
  });

  it('reads a store that has no workflows yet', async () => {
    const path = await file();
    writer(path);
    const journal = reader(path);
    expect(journal.catalog()).toEqual({ rows: [], finished: 0 });
    expect(journal.position()).toBe(0);
    expect(journal.state('missing')).toBeUndefined();
  });

  it('cannot be asked to follow a store it may write', () => {
    const store = writer(':memory:');
    expect(() => store.follow('a')).toThrow(/read-only/);
  });
});

const archive: WorkflowArchive = { task: () => undefined, result: () => undefined, turn: () => undefined, hasKey: () => false, artifact: () => undefined, call: () => undefined,
  lastTurn: () => undefined, record: () => undefined, range: () => [], search: () => [] };

function item(key: string, extra: Partial<WorkflowWorkItem> = {}): WorkflowWorkItem {
  return { id: 'id-' + key, key, digest: 'd', title: 'title of ' + key, input: 'do ' + key, resources: [], maxAttempts: 3, generation: 0, status: 'pending',
    progress: { version: 0, state: null }, createdAt: 10, updatedAt: 20, ...extra };
}

function post(seq: number, extra: Partial<BoardPost> = {}): BoardPost {
  return { seq, id: 'post-' + seq, to: [], text: 'post number ' + seq, createdAt: seq * 10, ...extra };
}

/** A swarm with a lead, a queue lead and two workers, the way the engine leaves it in the state. */
function swarmState(): WorkflowState {
  const execution = { agentKind: 'claude', profile: 'default', modelSettings: { model: 'flash', reasoningEffort: 'max' }, policyFingerprint: 'p', configurationFingerprint: 'c' };
  const agent = (key: string, extra: object = {}) => ({ agentId: 'agent-' + key, key, sessionRef: 'session-' + key, checkpointVersion: 0, ...extra });
  const session = (key: string) => ({ sessionRef: 'session-' + key, actorId: key, actorKey: key, role: 'member', execution, nativeIdKind: 'sessionId' as const, nativeSessionId: 'native-' + key, generation: 1 });
  const task = (taskId: string, key: string, status: WorkflowState['tasks'][number]['status'], attempt: object) => ({ taskId, taskKey: 'turn of ' + key, requestDigest: taskId, sessionRef: 'session-' + key,
    objective: 'prompt of ' + taskId, inputRefs: [], status, attempts: [{ attemptId: taskId + '-1', startedAt: 100, ...attempt }], resultRefs: status === 'result_ready' ? ['artifact:' + taskId] : [], agentId: 'agent-' + key });
  return {
    ...initial('w'), stateVersion: 42, createdAt: 1_000, deadlineAt: 9_000,
    script: { name: 'the swarm', sourceRef: 'artifact:source', planRef: 'artifact:plan', args: null, defaults: { agentKind: 'claude' }, runId: 'run-1', revision: 0, status: 'running', maxCalls: 100,
      calls: [], archivedCalls: 7, logs: ['started'], phase: 'phase two' },
    sessions: ['lead', 'q-lead', 'w1', 'w2'].map(session),
    agents: [agent('lead'), agent('q-lead'), agent('w1', { activeTurnId: 't-w1', lastTurnId: 't-w1' }), agent('w2', { lastTurnId: 't-w2' })],
    tasks: [task('t-w1', 'w1', 'running', { admittedAt: 150 }), task('t-w2', 'w2', 'result_ready', { admittedAt: 110, endedAt: 400 }), task('t-slot', 'lead', 'starting', {})],
    artifacts: [{ ref: 'artifact:t-w2', kind: 'result', text: 'what w2 found', digest: 'x', taskId: 't-w2', createdAt: 400 },
      { ref: 'artifact:plan', kind: 'plan', text: 'the plan', digest: 'y', createdAt: 1 }, { ref: 'artifact:source', kind: 'source', text: 'swarm()', digest: 'z', createdAt: 1 }],
    archived: { tasks: 5, attempts: 6, statuses: { result_ready: 4, failed: 1 } },
    archivedRecords: { post: 2, workItem: 3 },
    swarms: [{ id: 's1', key: 'crew', digest: 'd', runId: 'run-1', task: 'do the work', lead: 'lead', maxTurns: 16, status: 'running', firstPost: 1, turns: [], archivedTurns: 5,
      results: [{ item: 'a', worker: 'w2', at: 300 }],
      members: [{ name: 'lead', execution, turns: 1 }, { name: 'q-lead', execution, turns: 0, leads: ['build'], under: 'lead' },
        { name: 'w1', execution, turns: 2, queue: 'build', itemsDone: 1 }, { name: 'w2', execution, turns: 3, queue: 'build', stopped: 'failed', detail: 'ran out of turns' },
        { name: 'w3', execution, turns: 0, queue: 'build' }] }],
    workQueue: { operations: [], archived: { build: { completed: 3 } },
      items: [item('a', { queue: 'build', status: 'claimed', claimId: 'c1', generation: 1, priority: 5 }), item('b', { queue: 'build', dependsOn: ['a'] }),
        item('c', { queue: 'build', hold: true, held: { at: 5, reason: 'waits for a decision' } }), item('d', { status: 'completed', doneBy: 'w2', result: { ok: true } }),
        item('e', { queue: 'build', status: 'failed', error: 'no way' })],
      claims: [{ id: 'c1', itemId: 'id-a', agentId: 'agent-w1', taskId: 't-w1', attemptId: 't-w1-1', generation: 1, leaseUntil: 5_000, status: 'active', createdAt: 120 }] },
    board: { posts: [post(3, { from: 'agent-w1', to: ['agent-lead'], ask: { within: 60_000 } }), post(4, { author: 'system', all: true, topic: 'announce' }),
      post(5, { from: 'agent-lead', to: ['agent-w1'], answers: 3, text: 'the answer about alpha' })], asks: [{ seq: 3, from: 'agent-w1', to: 'agent-lead', at: 30, within: 60_000, excerpt: 'post number 3' }],
    topics: { announce: { posts: 1, recent: [4] } } },
    mailbox: { receipts: [], operations: [], messages: [{ id: 'm1', to: 'agent-w1', from: 'agent-lead', text: '', post: 5, createdAt: 50 },
      { id: 'm2', to: 'agent-w1', text: 'from main', createdAt: 60, consumedByTurnId: 't-w1' }] },
    todos: { next: 3, open: [{ id: 1, subject: 'dry:s1:build', kind: 'dry', since: 500, told: [{ who: 'q-lead', at: 600 }, { who: 'lead', at: 700 }] }, { id: 2, subject: 'ask:3', kind: 'ask', since: 30, told: [], goneAt: 900 }] },
    charter: { version: 2, text: 'the goal now', by: 'main', at: 77 },
    statuses: { lead: { text: 'half way', at: 88, version: 3 } },
    events: [{ id: 'e1', kind: 'todo', summary: 'look at this', acknowledged: false, notified: true, createdAt: 99 }, { id: 'e2', kind: 'ask', summary: 'old', acknowledged: true, notified: true }],
  };
}

describe('dashboard views', () => {
  const state = swarmState();
  const source: ViewSource = { state, archive, text: digest => 'text ' + digest };

  it('summarizes a workflow with what was archived counted in', () => {
    const summary = summarize(state, 2_000);
    expect(summary).toMatchObject({ id: 'w', name: 'the swarm', stage: 'running', tone: 'running', phase: 'phase two', model: 'm1', version: 42,
      members: { total: 5, running: 1, stopped: 1 }, turns: { total: 8, running: 1, slot: 1, queued: 0, done: 5, failed: 1 },
      work: { pending: 2, claimed: 1, completed: 4, failed: 1, cancelled: 0, total: 8 }, todos: 1, asks: 1, notices: 1 });
    // Past its deadline a running workflow needs someone to look.
    expect(summarize(state, 10_000).tone).toBe('attention');
    expect(summarize({ ...state, status: 'paused' }, 2_000)).toMatchObject({ stage: 'paused', tone: 'attention' });
    expect(summarize({ ...state, script: { ...state.script!, status: 'failed' } }, 2_000)).toMatchObject({ stage: 'script_failed', tone: 'failed' });
  });

  it('shows each queue with who leads it, who can still take work and what waits', () => {
    const view = overview(state, 2_000);
    expect(view.queues.find(queue => queue.name === 'build')).toMatchObject({ open: true, lead: 'q-lead', consumers: ['w1', 'w2', 'w3'], staffed: 2,
      counts: { pending: 2, claimed: 1, completed: 3, failed: 1, cancelled: 0 }, held: 1, blocked: 1 });
    expect(view.queues.find(queue => queue.name === 'default')).toMatchObject({ counts: { completed: 1 }, consumers: [] });
    expect(view.charter).toMatchObject({ version: 2, text: 'the goal now' });
    expect(view.statuses).toEqual([{ lead: 'lead', text: 'half way', at: 88, version: 3 }]);
    expect(view.todos.map(todo => [todo.id, todo.holder])).toEqual([[1, 'lead'], [2, undefined]]);
    expect(view.asks).toEqual([{ seq: 3, from: 'w1', to: 'lead', at: 30, within: 60_000, excerpt: 'post number 3' }]);
    expect(view.notices.map(notice => notice.id)).toEqual(['e1']);
    expect(view.swarms[0]).toMatchObject({ key: 'crew', lead: 'lead', members: 5, stopped: 1, turns: 5, results: 1 });
    expect(view.script).toMatchObject({ calls: 7, logs: ['started'] });
    expect(view.slots.waiting).toBe(1);
  });

  it('tells what every member is doing', () => {
    const list = members(state).members;
    expect(list.map(entry => [entry.name, entry.role, entry.phase])).toEqual([
      ['lead', 'lead', 'idle'], ['q-lead', 'queue-lead', 'idle'], ['w1', 'worker', 'running'], ['w2', 'worker', 'failed'], ['w3', 'worker', 'unstarted']]);
    expect(list[2]).toMatchObject({ queue: 'build', model: 'flash', effort: 'max', unread: 1, itemsDone: 1, turns: 2, maxTurns: 16, item: { key: 'a', leaseUntil: 5_000 }, task: { taskId: 't-w1', status: 'running' } });
    expect(list[3]).toMatchObject({ detail: 'ran out of turns' });
    const detail = member(source, 'w1')!;
    // A delivered post is shown with the text of the post.
    expect(detail.messages).toEqual([{ id: 'm1', from: 'lead', at: 50, text: 'the answer about alpha', post: 5 }]);
    expect(detail.claims).toMatchObject([{ item: 'a', status: 'active' }]);
    expect(detail.nativeSessionId).toBe('native-w1');
    expect(member(source, 'w3')).toMatchObject({ phase: 'unstarted', recentTurns: [] });
    expect(member(source, 'nobody')).toBeUndefined();
  });

  it('lists work items by what needs attention first and filters them', () => {
    const all = work(source);
    expect(all.items.map(entry => entry.key)).toEqual(['a', 'e', 'b', 'c', 'd']);
    expect(all.items[0]).toMatchObject({ owner: 'w1', priority: 5, queue: 'build' });
    expect(all.items.find(entry => entry.key === 'b')).toMatchObject({ waitsOn: ['a'] });
    expect(all.items.find(entry => entry.key === 'c')).toMatchObject({ hold: true, heldReason: 'waits for a decision' });
    expect(work(source, { queue: 'default' }).items.map(entry => entry.key)).toEqual(['d']);
    expect(work(source, { status: 'pending', query: 'title b' }).items.map(entry => entry.key)).toEqual(['b']);
    expect(work(source, { limit: 2, offset: 1 })).toMatchObject({ total: 5, items: [{ key: 'e' }, { key: 'b' }] });
    expect(workItem(source, 'd')).toMatchObject({ input: 'do d', result: '{\n  "ok": true\n}', doneBy: 'w2' });
    expect(workItem(source, 'a')?.claims).toMatchObject([{ member: 'w1', taskId: 't-w1' }]);
    expect(workItem(source, 'gone')).toBeUndefined();
  });

  it('reads the board newest first and goes on into the archive', () => {
    const view = board(source);
    expect(view.total).toBe(5);
    expect(view.posts.map(entry => entry.seq)).toEqual([5, 4, 3]);
    expect(view.posts[0]).toMatchObject({ from: 'lead', to: ['w1'], answers: 3 });
    expect(view.posts[1]).toMatchObject({ from: 'system', all: true, topic: 'announce' });
    expect(view.posts[2]).toMatchObject({ from: 'w1', to: ['lead'], ask: { open: true } });
    expect(board(source, { topic: 'announce' }).posts.map(entry => entry.seq)).toEqual([4]);
    expect(board(source, { member: 'w1', query: 'alpha' }).posts.map(entry => entry.seq)).toEqual([5]);

    const asked: Array<{ upTo: number }> = [];
    const stored: WorkflowArchive = { ...archive, range: (_kind, range) => { asked.push({ upTo: range.upTo }); return [post(2), post(1, { text: 'the oldest' })].filter(entry => entry.seq <= range.upTo); } };
    const older = board({ ...source, archive: stored }, { limit: 4 });
    expect(older.posts.map(entry => entry.seq)).toEqual([5, 4, 3, 2]);
    expect(older.next).toBe(2);
    expect(asked).toEqual([{ upTo: 2 }]);
    expect(board({ ...source, archive: stored }, { before: 2 }).posts.map(entry => entry.text)).toEqual(['the oldest']);
  });

  it('lists turns and shows one with its prompt and result', () => {
    expect(turns(state, { show: 'active' }).turns.map(entry => entry.taskId).sort()).toEqual(['t-slot', 't-w1']);
    expect(turns(state, { member: 'w2' })).toMatchObject({ total: 1, archived: 5, turns: [{ taskId: 't-w2', member: 'w2', status: 'result_ready', endedAt: 400 }] });
    const withEphemeral: WorkflowState = {
      ...state,
      tasks: [
        ...state.tasks,
        { taskId: 't-eph', taskKey: 'ephemeral-task', requestDigest: 't-eph', sessionRef: 'session-lead',
          objective: 'one-shot prompt', inputRefs: [], status: 'result_ready',
          attempts: [{ attemptId: 't-eph-1', startedAt: 105, admittedAt: 110, endedAt: 200 }], resultRefs: [] },
      ],
    };
    expect(turns(withEphemeral, { show: 'all', member: 'missing-review-seat-7713' })).toMatchObject({ total: 0, turns: [] });
    expect(turns(withEphemeral, { show: 'active', member: 'missing-review-seat-7713' })).toMatchObject({ total: 0, turns: [] });
    expect(turns(withEphemeral, { show: 'failed', member: 'missing-review-seat-7713' })).toMatchObject({ total: 0, turns: [] });
    expect(turn(source, 't-w2')).toMatchObject({ objective: 'prompt of t-w2', results: [{ ref: 'artifact:t-w2', text: 'what w2 found' }], nativeSessionId: 'native-w2' });
    const stored: WorkflowArchive = { ...archive, task: id => id === 't-old' ? { ...state.tasks[1]!, taskId: 't-old', objective: { digest: 'abc', chars: 3 }, resultRefs: [] } as never : undefined };
    expect(turn({ ...source, archive: stored }, 't-old')).toMatchObject({ archived: true, objective: 'text abc' });
    expect(turn(source, 'gone')).toBeUndefined();
  });
});

describe('dashboard API', () => {
  it('answers from the journal, says when nothing changed and reports what it cannot read', async () => {
    const path = await file();
    const store = writer(path);
    start(store, 'a');
    start(store, 'b');
    const api = new DashboardApi([{ name: 'main', path }, { name: 'absent', path: path + '.missing' }], () => 1);
    cleanup.push(() => api.close());

    expect(api.handle('/sources').body).toMatchObject({ sources: [{ name: 'main', position: 4 }, { name: 'absent', error: expect.any(String) }] });
    const list = api.handle('/s/main/workflows');
    expect((list.body as { workflows: Array<{ id: string }> }).workflows.map(row => row.id)).toEqual(['b', 'a']);
    expect(api.handle('/s/main/workflows', undefined, list.etag).status).toBe(304);

    const first = api.handle('/s/main/w/a/overview');
    expect(first.body).toMatchObject({ summary: { id: 'a', name: 'script a' }, tree: [{ id: 'a' }] });
    expect(api.handle('/s/main/w/a/overview', undefined, first.etag)).toEqual({ status: 304, etag: first.etag });
    log(store, 'a', 'changed');
    const second = api.handle('/s/main/w/a/overview', undefined, first.etag);
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ script: { logs: ['changed'] } });
    // Another workflow's change leaves this one's answers as they were.
    log(store, 'b', 'elsewhere');
    expect(api.handle('/s/main/w/a/overview', undefined, second.etag).status).toBe(304);
    expect(api.handle('/s/main/workflows', undefined, list.etag).status).toBe(200);

    for (const view of ['members', 'work', 'board', 'turns', 'plan', 'journal']) expect(api.handle(`/s/main/w/a/${view}`).status, view).toBe(200);
    expect(api.handle('/s/main/w/a/member', new URLSearchParams('name=nobody')).status).toBe(404);
    expect(api.handle('/s/main/w/missing/overview').status).toBe(404);
    expect(api.handle('/s/nowhere/workflows').status).toBe(404);
    expect(api.handle('/s/main/w/a/unknown').status).toBe(404);
    expect(api.handle('/s/absent/workflows').status).toBe(500);

    // An event this build does not know: that workflow cannot be read, the others can.
    const db = new Database(path);
    db.prepare("INSERT INTO wf_events(workflow_id, root_id, version, type, at, cause, data) VALUES ('b', 'b', 99, 'from_a_later_build', 5, 'test', ?)").run(JSON.stringify({ type: 'from_a_later_build' }));
    db.close();
    expect(api.handle('/s/main/w/b/overview')).toMatchObject({ status: 409, body: { unreadable: true } });
    const rows = (api.handle('/s/main/workflows').body as { workflows: Array<{ id: string; unreadable?: string; name?: string }> }).workflows;
    expect(rows.find(row => row.id === 'b')?.unreadable).toMatch(/from_a_later_build/);
    expect(rows.find(row => row.id === 'a')?.name).toBe('script a');
  });

  it('names a source after the directory of its file unless given a name', () => {
    // The path comes back absolute for the platform: on Windows it gains a drive and backslashes.
    expect(dashboardSource('codex=/state/x/workflows.sqlite')).toEqual({ name: 'codex', path: resolve('/state/x/workflows.sqlite') });
    expect(dashboardSource('/state/profiles/bot2/workflows.sqlite')).toEqual({ name: 'bot2', path: resolve('/state/profiles/bot2/workflows.sqlite') });
    expect(() => new DashboardApi([{ name: 'a', path: '/1' }, { name: 'a', path: '/2' }])).toThrow(/distinct/);
  });
});

describe('dashboard server', () => {
  it('serves the page to anyone and the API to holders of the token, and changes nothing', async () => {
    const path = await file();
    const store = writer(path);
    start(store, 'a');
    const stateFile = join(path, '..', 'run', 'dashboard.json');
    const handle = await startDashboard({ sources: [{ name: 'main', path }], stateFile, label: 'te</script>st' });
    let closed = false;
    cleanup.push(() => closed ? undefined : handle.close());
    const origin = `http://127.0.0.1:${handle.port}`;
    expect(handle.url).toBe(`${origin}/#token=${handle.token}`);

    const page = await fetch(origin + '/');
    const html = await page.text();
    expect(page.headers.get('content-type')).toMatch(/text\/html/);
    expect(html).toContain('const LABEL = "te\\u003c/script>st";');
    expect(html).not.toContain(handle.token!);
    expect(html).toContain('role="dialog" aria-modal="true"');
    expect(html).toContain('setDrawerBackgroundInert');

    expect((await fetch(origin + '/api/sources')).status).toBe(401);
    expect((await fetch(origin + '/api/sources', { headers: { 'x-workflow-dashboard-token': 'wrong' } })).status).toBe(401);
    const headers = { 'x-workflow-dashboard-token': handle.token! };
    const list = await fetch(origin + '/api/s/main/workflows', { headers });
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({ workflows: [{ id: 'a' }] });
    expect((await fetch(origin + '/api/s/main/workflows', { headers: { ...headers, 'If-None-Match': list.headers.get('etag')! } })).status).toBe(304);
    expect((await fetch(`${origin}/api/health?token=${handle.token}`)).status).toBe(200);
    expect((await fetch(origin + '/api/s/main/w/a/overview', { headers: { authorization: 'Bearer ' + handle.token } })).status).toBe(200);
    expect((await fetch(origin + '/api/s/main/workflows', { method: 'POST', headers })).status).toBe(405);
    expect((await fetch(origin + '/elsewhere')).status).toBe(404);

    const recorded = JSON.parse(await readFile(stateFile, 'utf8'));
    expect(recorded).toMatchObject({ url: origin, port: handle.port, token: handle.token, pid: process.pid, sources: [{ name: 'main', path }] });
    if (process.platform !== 'win32') expect(statSync(stateFile).mode & 0o777).toBe(0o600);
    await handle.close();
    closed = true;
    await expect(readFile(stateFile, 'utf8')).rejects.toThrow();
    // The writer went on undisturbed.
    log(store, 'a', 'still writing');
    expect(store.byId('a')?.script?.logs).toEqual(['still writing']);
  });

  it('serves without a token when told that something in front of it authenticates', async () => {
    const path = await file();
    writer(path);
    const handle = await startDashboard({ sources: [{ name: 'main', path }], token: false });
    cleanup.push(() => handle.close());
    expect(handle.token).toBeUndefined();
    expect((await fetch(`http://127.0.0.1:${handle.port}/api/sources`)).status).toBe(200);
  });
});

describe('dashboard markdown', () => {
  type Node = string | [string, Record<string, unknown>, ...Node[]];
  // The parser is a script block of the page that needs nothing else from it.
  const markdownTree = new Function(/<script id="markdown">([\s\S]*?)<\/script>/.exec(page)![1] + '\nreturn markdownTree;')() as (text: string) => Node[];
  const link = (href: string, ...kids: Node[]): Node => ['a', { href, target: '_blank', rel: 'noopener noreferrer' }, ...kids];

  it('reads emphasis and code, and leaves the underscores of a name alone', () => {
    expect(markdownTree('**粗** 和 `a*b*c` 与 DCX_MAP_DELAY_TIEBREAK、*斜*、~~删~~\n第二行')).toEqual([['p', {}, ['strong', {}, '粗'], ' 和 ', ['code', {}, 'a*b*c'],
      ' 与 DCX_MAP_DELAY_TIEBREAK、', ['em', {}, '斜'], '、', ['del', {}, '删'], ['br', {}], '第二行']]);
    expect(markdownTree('见下\n2026. 年')).toEqual([['p', {}, '见下', ['br', {}], '2026. 年']]);
  });

  it('keeps what looks like markup as text and links only what a browser may open', () => {
    expect(markdownTree('<img src=x onerror=alert(1)> <sha> [a](javascript:alert(1)) [b](https://example.com/x) [c](docs/x.md) 见 https://example.com/y_z。')).toEqual([['p', {},
      '<img src=x onerror=alert(1)> <sha> ', ['span', { class: 'ref', title: 'javascript:alert(1' }, 'a'], ') ', link('https://example.com/x', 'b'), ' ',
      ['span', { class: 'ref', title: 'docs/x.md' }, 'c'], ' 见 ', link('https://example.com/y_z', 'https://example.com/y_z'), '。']]);
  });

  it('nests lists by indentation and starts a new list where the kind of marker changes', () => {
    expect(markdownTree('说明：\n- a\n  - b `c`\n  续行\n- [x] done\n- [ ] todo\n\n3. three\n4. four')).toEqual([
      ['p', {}, '说明：'],
      ['ul', {}, ['li', {}, 'a', ['ul', {}, ['li', {}, 'b ', ['code', {}, 'c'], ['br', {}], '续行']]],
        ['li', { class: 'task' }, ['input', { type: 'checkbox', disabled: true, checked: true }], 'done'],
        ['li', { class: 'task' }, ['input', { type: 'checkbox', disabled: true, checked: false }], 'todo']],
      ['ol', { start: 3 }, ['li', {}, 'three'], ['li', {}, 'four']],
    ]);
    // Blank lines between items keep one list, whose items are then paragraphs.
    expect(markdownTree('- a\n\n- b')).toEqual([['ul', {}, ['li', {}, ['p', {}, 'a']], ['li', {}, ['p', {}, 'b']]]]);
  });

  it('reads a table, with a bar inside code or after a backslash as part of its cell', () => {
    expect(markdownTree('| 队列 | 数量 |\n|:--|--:|\n| `a|b` | 3 |\n| x \\| y |\n\n后文')).toEqual([['div', { class: 'tablewrap' }, ['table', {},
      ['thead', {}, ['tr', {}, ['th', {}, '队列'], ['th', { style: 'text-align:right' }, '数量']]],
      ['tbody', {}, ['tr', {}, ['td', {}, ['code', {}, 'a|b']], ['td', { style: 'text-align:right' }, '3']],
        ['tr', {}, ['td', {}, 'x | y'], ['td', { style: 'text-align:right' }]]]]], ['p', {}, '后文']]);
    // A row of dashes under a line with another number of cells is not a table.
    expect(markdownTree('a | b\n---')).toEqual([['p', {}, 'a | b'], ['hr', {}]]);
  });

  it('reads headings, fenced code as written, quotes and rules', () => {
    expect(markdownTree('## 标题 ##\n```ts\nconst a = "<b>"; // **x**\n\n  - not a list\n```\n> 引用 **粗**\n> - 项\n\n---\n#标签')).toEqual([
      ['h2', {}, '标题'], ['pre', { title: 'ts' }, ['code', {}, 'const a = "<b>"; // **x**\n\n  - not a list']],
      ['blockquote', {}, ['p', {}, '引用 ', ['strong', {}, '粗']], ['ul', {}, ['li', {}, '项']]], ['hr', {}], ['p', {}, '#标签']]);
  });
});
