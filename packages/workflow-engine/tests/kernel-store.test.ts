import { statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { emit, putText, readText, readWorkflowStates, replaceWorkflowState, WorkflowStore, type WorkflowStoreOptions } from '../src/engine/kernel-store';
import { SCRIPT_DEFINITION } from '../src/engine/script-contract';
import type { StoredTask, WorkflowData, WorkflowView } from '../src/engine/types';

const cleanup: Array<() => unknown> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function file(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'workflow-store-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  return join(directory, 'state.sqlite');
}

function open(path = ':memory:', options: WorkflowStoreOptions = {}): WorkflowStore {
  const store = new WorkflowStore(path, () => 1_000, options);
  cleanup.push(() => store.close());
  return store;
}

function childOf(workflowId: string, taskId: string): NonNullable<WorkflowData['parent']> {
  return { workflowId, taskId, rootWorkflowId: workflowId, depth: 1, key: 'k', digest: 'd', operationId: 'o', parentQueue: false, checkpoint: null };
}

function initial(id: string, scope = 'scope-' + id, parent?: WorkflowData['parent']): WorkflowData {
  return { workflowId: id, root: { scopeId: scope, profile: 'default', agentKind: 'codex', cwdRealpath: '/workspace',
    policyFingerprint: 'policy', catalogBinding: 'root', modelSettings: {} }, definition: structuredClone(SCRIPT_DEFINITION),
  definitionDigest: 'digest', goal: 'goal', stateVersion: 0, status: 'active', createdAt: 1, deadlineAt: 2,
  sessions: [], tasks: [], artifacts: [], events: [], ...(parent ? { parent } : {}) };
}

/** A workflow with a script, the way every operation that starts one creates it. */
function start(store: WorkflowStore, id: string, scope?: string, parent?: WorkflowData['parent']): WorkflowView {
  return store.transact(() => {
    const state = store.create(initial(id, scope, parent));
    emit(state, { type: 'script_set', script: { name: 'test', sourceRef: 'artifact:source', args: null, defaults: { agentKind: 'codex' },
      runId: 'run-1', revision: 0, status: 'running', maxCalls: 8, calls: [], logs: [] } });
    return state;
  });
}

function task(state: WorkflowView, taskId: string, prompt = 'prompt for ' + taskId): void {
  const created: StoredTask = { taskId, taskKey: taskId, requestDigest: taskId, sessionRef: 'session', objective: putText(state, prompt),
    inputRefs: [], status: 'queued', attempts: [], resultRefs: [] };
  emit(state, { type: 'task_created', task: created });
}

describe('event-sourced workflow store', () => {
  it('runs the suite with journal verification on', () => {
    expect(process.env.WORKFLOW_ENGINE_VERIFY).toBe('1');
  });

  it('rebuilds the same state from the journal after reopening', async () => {
    const path = await file();
    const first = new WorkflowStore(path, () => 1_000);
    const state = start(first, 'a');
    first.transact(() => { task(state, 't1'); emit(state, { type: 'script_logged', text: 'one' }); });
    first.transact(() => emit(state, { type: 'attempt_started', taskId: 't1', attempt: { attemptId: 'attempt-1', startedAt: 5, sessionGeneration: 1 } }));
    const before = JSON.parse(JSON.stringify(first.public(state)));
    // Drop the snapshot written on close: the journal alone has to be enough.
    first.close();
    const db = new Database(path); db.exec('DELETE FROM wf_snapshots'); db.close();
    const second = open(path);
    const reloaded = second.state('scope-a')!;
    expect(JSON.parse(JSON.stringify(second.public(reloaded)))).toEqual(before);
    expect(reloaded.stateVersion).toBe(3);
    expect(second.list().map(item => item.workflowId)).toEqual(['a']);
  });

  it('gives each transaction one version and records nothing for a transaction without events', () => {
    const store = open();
    const state = start(store, 'a');
    expect(state.stateVersion).toBe(1);
    const commits = vi.fn(); store.onCommit(commits);
    store.transact(() => { emit(state, { type: 'script_logged', text: 'one' }); emit(state, { type: 'script_logged', text: 'two' }); });
    expect(state.stateVersion).toBe(2);
    store.transact(() => state.script!.logs.length);
    expect(state.stateVersion).toBe(2);
    expect(commits).toHaveBeenCalledTimes(1);
    expect(store.db.prepare('SELECT version, type, cause FROM wf_events ORDER BY seq').all()).toEqual([
      { version: 1, type: 'workflow_created', cause: 'system' }, { version: 1, type: 'script_set', cause: 'system' },
      { version: 2, type: 'script_logged', cause: 'system' }, { version: 2, type: 'script_logged', cause: 'system' }]);
  });

  it('joins nested transactions and tags events with the outermost cause', () => {
    const store = open();
    const state = start(store, 'a');
    store.transact(() => {
      expect(store.transacting).toBe(true);
      store.transact(() => emit(state, { type: 'script_logged', text: 'inner' }), 'inner');
      emit(state, { type: 'script_logged', text: 'outer' });
    }, 'outer');
    expect(store.transacting).toBe(false);
    expect(state.stateVersion).toBe(2);
    expect(store.db.prepare("SELECT DISTINCT cause FROM wf_events WHERE type = 'script_logged'").all()).toEqual([{ cause: 'outer' }]);
  });

  it('rolls a failed transaction back: nothing is written and the next read reloads the journal', () => {
    const store = open();
    const state = start(store, 'a');
    const changes = vi.fn(); store.onChange('scope-a', changes);
    expect(() => store.transact(() => {
      emit(state, { type: 'script_logged', text: 'lost' });
      task(state, 'lost-task', 'a prompt that must not be stored');
      store.create(initial('lost-child', 'scope-a', childOf('a', 'lost-task')));
      store.commitOperation('scope-a', 'operation', 'digest', () => ({ ok: true }));
      throw new Error('late failure');
    })).toThrow('late failure');
    expect(changes).not.toHaveBeenCalled();
    expect(store.operation('scope-a', 'operation')).toBeUndefined();
    expect(store.byId('lost-child')).toBeUndefined();
    expect(store.db.prepare('SELECT count(*) AS count FROM wf_texts').get()).toEqual({ count: 0 });
    // The object that took the uncommitted changes is no longer the workflow's state.
    expect(() => store.transact(() => emit(state, { type: 'script_logged', text: 'stale' }))).toThrow('no longer live');
    const reloaded = store.state('scope-a')!;
    expect(reloaded).not.toBe(state);
    expect(reloaded).toMatchObject({ stateVersion: 1, tasks: [], script: { logs: [] } });
    expect(store.tree(reloaded).map(item => item.workflowId)).toEqual(['a']);
    store.transact(() => emit(reloaded, { type: 'script_logged', text: 'kept' }));
    expect(store.state('scope-a')!.script!.logs).toEqual(['kept']);
  });

  it('refuses changes outside a transaction and to states it does not own', () => {
    const store = open();
    const state = start(store, 'a');
    expect(() => emit(state, { type: 'script_logged', text: 'x' })).toThrow('require a transaction');
    expect(() => putText(state, 'x')).toThrow('require a transaction');
    expect(() => store.transact(() => emit(store.public(state) as unknown as WorkflowView, { type: 'script_logged', text: 'x' }))).toThrow('Not a live workflow state');
  });

  it('commits an operation record with its events and reports the version of that commit', () => {
    const store = open();
    const state = start(store, 'a');
    const response = store.transact(() => {
      emit(state, { type: 'script_logged', text: 'one' });
      return store.commitOperation('scope-a', 'operation', 'digest', () => ({ stateVersion: state.stateVersion }));
    });
    expect(response).toEqual({ stateVersion: 2 });
    expect(store.operation('scope-a', 'operation')).toEqual({ digest: 'digest', response: '{"stateVersion":2}' });
  });

  it('applies the policy to every changed workflow before the commit', () => {
    const store = open(':memory:', { policy: state => { if (state.script && !state.script.phase) emit(state, { type: 'script_phase_set', phase: 'by policy' }); } });
    const state = start(store, 'a');
    expect(state).toMatchObject({ stateVersion: 1, script: { phase: 'by policy' } });
    expect(store.db.prepare('SELECT type, version FROM wf_events ORDER BY seq').all().at(-1)).toEqual({ type: 'script_phase_set', version: 1 });
  });

  it('snapshots after the configured number of events and replays only the tail', async () => {
    const path = await file();
    const first = new WorkflowStore(path, () => 1_000, { snapshotEvery: 5 });
    const state = start(first, 'a');
    for (let index = 0; index < 11; index++) first.transact(() => emit(state, { type: 'script_logged', text: 'log ' + index }));
    const before = JSON.parse(JSON.stringify(first.public(state)));
    const snapshot = first.db.prepare('SELECT seq FROM wf_snapshots').get() as { seq: number };
    expect(snapshot.seq).toBeGreaterThanOrEqual(10);
    expect(snapshot.seq).toBeLessThan(13);
    // Kill without the snapshot a clean close writes, then drop what the snapshot covers.
    first.db.prepare('DELETE FROM wf_events WHERE seq <= ?').run(snapshot.seq);
    first.db.close();
    const second = new WorkflowStore(path, () => 1_000, { readonly: true });
    cleanup.push(() => second.close());
    expect(JSON.parse(JSON.stringify(second.public(second.state('scope-a')!)))).toEqual(before);
  });

  it('writes a snapshot of every changed workflow on close', async () => {
    const path = await file();
    const store = new WorkflowStore(path, () => 1_000);
    const state = start(store, 'a');
    store.transact(() => emit(state, { type: 'script_logged', text: 'one' }));
    store.close(); store.close();
    const db = new Database(path, { readonly: true });
    try { expect(db.prepare('SELECT workflow_id, seq FROM wf_snapshots').all()).toEqual([{ workflow_id: 'a', seq: 3 }]); }
    finally { db.close(); }
  });

  it('notifies watchers after the commit, by topic, once per transaction', () => {
    const store = open();
    const state = start(store, 'a');
    const other = start(store, 'b');
    const seen: string[] = [];
    const stops = [
      store.watch('a', ['task:t1'], () => seen.push('t1:' + state.tasks.length)),
      store.watch('a', ['task:t2', 'lifecycle'], () => seen.push('t2-or-lifecycle')),
      store.watch('b', ['lifecycle'], () => seen.push('b')),
      store.onChange('scope-a', () => seen.push('scope-a')),
    ];
    store.transact(() => { task(state, 't1'); emit(state, { type: 'attempt_started', taskId: 't1', attempt: { attemptId: 'x', startedAt: 1, sessionGeneration: 1 } }); });
    expect(seen).toEqual(['t1:1', 'scope-a']);
    seen.length = 0;
    store.transact(() => emit(state, { type: 'script_logged', text: 'not a lifecycle change' }));
    expect(seen).toEqual(['scope-a']);
    seen.length = 0;
    store.transact(() => { emit(state, { type: 'workflow_paused' }); emit(other, { type: 'workflow_paused' }); });
    expect(seen).toEqual(['t2-or-lifecycle', 'b', 'scope-a']);
    seen.length = 0;
    for (const stop of stops) stop();
    store.transact(() => emit(state, { type: 'workflow_cancelled' }));
    expect(seen).toEqual([]);
  });

  it('delivers a commit to every listener even when one of them fails', () => {
    const store = open();
    const state = start(store, 'a');
    const later = vi.fn();
    store.onChange('scope-a', () => { throw new Error('listener failed'); });
    store.onCommit(later);
    expect(() => store.transact(() => emit(state, { type: 'script_logged', text: 'one' }))).toThrow('listener failed');
    expect(later).toHaveBeenCalledTimes(1);
    expect(store.state('scope-a')!.script!.logs).toEqual(['one']);
  });

  it('hands listener failures to the configured handler instead of the committer', () => {
    const failures: unknown[] = [];
    const store = open(':memory:', { listenerFailed: error => failures.push(error) });
    const state = start(store, 'a');
    store.watch('a', ['lifecycle'], () => { throw new Error('watcher failed'); });
    store.transact(() => emit(state, { type: 'workflow_paused' }));
    expect(failures).toEqual([new Error('watcher failed')]);
    expect(state.status).toBe('paused');
  });

  it('discards a state its reducer failed on, even when the caller swallows the error', async () => {
    const path = await file();
    const store = open(path);
    const state = start(store, 'a');
    // A checkpoint for an agent that does not exist fails after the reducer has already recorded it.
    const orphan = { type: 'checkpoint_saved' as const, checkpoint: { ref: 'c1', agentId: 'missing', version: 1, turnId: 't', state: null, createdAt: 1, sessionGeneration: 1 } };
    expect(() => store.transact(() => {
      try { emit(state, orphan); } catch { /* swallowed, as a caller with its own error handling might */ }
      emit(state, { type: 'script_logged', text: 'after the failure' });
    })).toThrow(TypeError);
    const reloaded = store.state('scope-a')!;
    expect(reloaded).not.toBe(state);
    expect(reloaded.checkpoints ?? []).toEqual([]);
    expect(reloaded.script!.logs).toEqual([]);
    expect(store.db.prepare('SELECT count(*) AS count FROM wf_events').get()).toEqual({ count: 2 });
  });

  it('frees the scope when its root finishes and keeps finished workflows readable within a bound', async () => {
    const path = await file();
    const store = open(path, { retainFinished: 2 });
    const states = ['a', 'b', 'c', 'd'].map(id => start(store, id, 'shared-' + id));
    expect(() => store.transact(() => store.create(initial('duplicate', 'shared-a')))).toThrow('already has an unfinished workflow');
    expect(store.state('shared-a')).toBe(states[0]);
    for (const state of states) store.transact(() => emit(state, { type: 'workflow_cancelled' }));
    expect(store.list()).toEqual([]);
    expect(store.state('shared-a')).toBeUndefined();
    expect(store.latest('shared-a')?.workflowId).toBe('a');
    // The two oldest were dropped from memory; reading one loads it again and it cannot be changed through the old object.
    const reloaded = store.state('shared-a', 'a')!;
    expect(reloaded).not.toBe(states[0]);
    expect(reloaded.status).toBe('cancelled');
    expect(() => store.transact(() => emit(states[0]!, { type: 'script_logged', text: 'x' }))).toThrow('no longer live');
    expect(store.state('shared-d', 'd')).toBe(states[3]);
    start(store, 'next', 'shared-a');
    expect(store.state('shared-a')!.workflowId).toBe('next');
  });

  it('lists a tree with children created in the open transaction', () => {
    const store = open();
    const root = start(store, 'root', 'scope');
    store.transact(() => {
      const child = store.create(initial('child', 'scope', childOf('root', 't')));
      expect(store.tree(root).map(item => item.workflowId)).toEqual(['root', 'child']);
      expect(store.descendants(root)).toEqual([child]);
      expect(store.descendants(root, 'another-task')).toEqual([]);
    });
    expect(store.state('scope')!.workflowId).toBe('root');
    expect(store.tree(store.byId('child')!).map(item => item.workflowId)).toEqual(['root', 'child']);
  });

  it('hands out detached copies in the public shape and loads texts on first read', async () => {
    const path = await file();
    const store = open(path);
    const state = start(store, 'a');
    store.transact(() => {
      task(state, 't1', 'the full prompt');
      emit(state, { type: 'artifact_added', artifact: { ref: 'artifact:1', kind: 'report', ...putText(state, 'report body'), createdAt: 1 } });
    });
    expect(state.tasks[0]!.objective).toEqual({ digest: expect.any(String), chars: 15 });
    expect(readText(state, state.artifacts[0]!)).toBe('report body');
    const copy = store.public(state);
    expect(copy.tasks[0]!.objective).toBe('the full prompt');
    expect(copy.artifacts[0]).toMatchObject({ ref: 'artifact:1', text: 'report body', chars: 11 });
    copy.status = 'cancelled'; copy.tasks.length = 0;
    expect(state).toMatchObject({ status: 'active', tasks: [{ taskId: 't1' }] });
    expect(() => store.text('missing')).toThrow('Stored text not found');
    // Identical texts are stored once.
    store.transact(() => task(state, 't2', 'the full prompt'));
    expect(store.db.prepare('SELECT count(*) AS count FROM wf_texts').get()).toEqual({ count: 2 });
  });

  it('detects a state change that bypassed the journal', () => {
    const store = open();
    const state = start(store, 'a');
    expect(() => store.transact(() => {
      (state as WorkflowData).goal = 'changed without an event';
      emit(state, { type: 'script_logged', text: 'one' });
    })).toThrow('diverged from its journal in: goal');
    // The journal wins: the next read is rebuilt from it.
    expect(store.state('scope-a')).toMatchObject({ goal: 'goal', script: { logs: ['one'] } });
  });

  it('reads and replaces workflows in a store file no kernel has open', async () => {
    const path = await file();
    expect(() => readWorkflowStates(path)).toThrow();
    const store = new WorkflowStore(path, () => 1_000);
    const state = start(store, 'a');
    store.transact(() => task(state, 't1', 'original prompt'));
    store.close();
    const [persisted] = readWorkflowStates(path);
    expect(persisted).toMatchObject({ workflowId: 'a', stateVersion: 2, tasks: [{ objective: 'original prompt' }] });
    persisted!.tasks[0]!.objective = 'replaced prompt'; persisted!.goal = 'replaced goal';
    replaceWorkflowState(path, persisted!);
    replaceWorkflowState(path, { ...persisted!, workflowId: 'b', root: { ...persisted!.root, scopeId: 'scope-b' } });
    expect(readWorkflowStates(path)).toMatchObject([
      { workflowId: 'a', stateVersion: 2, goal: 'replaced goal', tasks: [{ objective: 'replaced prompt' }] },
      { workflowId: 'b', stateVersion: 2, goal: 'replaced goal' }]);
  });

  it('indexes a finished workflow again when a replacement reopens it', () => {
    const store = open();
    const state = start(store, 'a');
    store.transact(() => emit(state, { type: 'workflow_cancelled' }));
    expect(store.state('scope-a')).toBeUndefined();
    const reopened = { ...store.public(store.byId('a')!), status: 'active' as const };
    store.transact(() => store.replace(reopened));
    expect(store.state('scope-a')).toMatchObject({ workflowId: 'a', status: 'active', stateVersion: reopened.stateVersion });
    expect(store.list().map(item => item.workflowId)).toEqual(['a']);
    expect(() => store.transact(() => store.create(initial('second', 'scope-a')))).toThrow('already has an unfinished workflow');
  });

  it('ignores the workflows table of the store it replaced', async () => {
    const path = await file();
    const legacy = new Database(path);
    legacy.exec('CREATE TABLE workflows (id TEXT PRIMARY KEY, scope TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL)');
    legacy.prepare('INSERT INTO workflows VALUES (?, ?, ?, ?)').run('old', 'scope', 'paused', '{}');
    legacy.close();
    const store = open(path);
    expect(store.legacyUnfinished()).toBe(1);
    expect(store.list()).toEqual([]);
    expect(open().legacyUnfinished()).toBe(0);
  });
});

describe('background WAL checkpoints', () => {
  it('moves journal pages into the database file from another thread and stops checkpointing inside commits', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'workflow-checkpoint-'));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const path = join(directory, 'state.sqlite');
    const failed = vi.fn();
    const store = new WorkflowStore(path, Date.now, { backgroundCheckpoint: true, checkpointFailed: failed });
    cleanup.push(() => store.close());
    // Nothing has been checkpointed yet: the tables exist only in the WAL.
    const before = statSync(path).size;
    await vi.waitFor(() => expect(store.db.pragma('wal_autocheckpoint', { simple: true })).toBe(0), { timeout: 10_000 });
    store.writeHeartbeat(1);
    await vi.waitFor(() => expect(statSync(path).size).toBeGreaterThan(before), { timeout: 10_000, interval: 100 });
    expect(failed).not.toHaveBeenCalled();
    expect(store.heartbeat()).toBe(1);
  });

  it('keeps checkpointing inside commits unless asked', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'workflow-checkpoint-'));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const store = new WorkflowStore(join(directory, 'state.sqlite'), Date.now);
    cleanup.push(() => store.close());
    expect(store.db.pragma('wal_autocheckpoint', { simple: true })).toBe(1000);
  });
});

describe('WAL file size', () => {
  it('cuts the file back after a backlog has been checkpointed', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'workflow-wal-size-'));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const path = join(directory, 'state.sqlite');
    const store = new WorkflowStore(path, Date.now);
    cleanup.push(() => store.close());
    const limit = store.db.pragma('journal_size_limit', { simple: true }) as number;
    expect(limit).toBeGreaterThan(0);
    // A backlog larger than the limit, as a checkpoint that cannot keep up leaves behind.
    store.db.pragma('wal_autocheckpoint = 0');
    store.db.pragma('journal_size_limit = 65536');
    const insert = store.db.prepare('INSERT OR REPLACE INTO wf_texts (digest, text) VALUES (?, ?)');
    for (let index = 0; index < 64; index++) insert.run('backlog-' + index, 'x'.repeat(16_000));
    expect(statSync(path + '-wal').size).toBeGreaterThan(500_000);
    store.db.pragma('wal_checkpoint(PASSIVE)');
    store.writeHeartbeat(1);
    expect(statSync(path + '-wal').size).toBeLessThanOrEqual(65536);
    expect(store.heartbeat()).toBe(1);
  });
});
