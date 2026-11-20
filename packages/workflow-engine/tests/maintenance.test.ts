import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { emit, putText, WorkflowStore, type WorkflowStoreOptions } from '../src/engine/kernel-store';
import { SCRIPT_DEFINITION } from '../src/engine/script-contract';
import type { WorkflowData, WorkflowView } from '../src/engine/types';

const cleanup: Array<() => unknown> = [];
const verify = process.env.WORKFLOW_ENGINE_VERIFY;

beforeEach(() => {
  // Compaction assumes the snapshot covers the events it deletes; verification replays from the first event.
  process.env.WORKFLOW_ENGINE_VERIFY = '0';
});
afterEach(async () => {
  process.env.WORKFLOW_ENGINE_VERIFY = verify;
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function file(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'workflow-maintenance-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  return join(directory, 'state.sqlite');
}

function open(path = ':memory:', options: WorkflowStoreOptions = {}): WorkflowStore {
  const store = new WorkflowStore(path, () => 1_000, options);
  cleanup.push(() => store.close());
  return store;
}

function initial(id: string, scope = 'scope-' + id, parent?: WorkflowData['parent']): WorkflowData {
  return { workflowId: id, root: { scopeId: scope, profile: 'default', agentKind: 'codex', cwdRealpath: '/workspace',
    policyFingerprint: 'policy', catalogBinding: 'root', modelSettings: {} }, definition: structuredClone(SCRIPT_DEFINITION),
  definitionDigest: 'digest', goal: 'goal', stateVersion: 0, status: 'active', createdAt: 1, deadlineAt: 2,
  sessions: [], tasks: [], artifacts: [], events: [], ...(parent ? { parent } : {}) };
}

function childOf(workflowId: string, taskId: string): NonNullable<WorkflowData['parent']> {
  return { workflowId, taskId, rootWorkflowId: workflowId, depth: 1, key: 'k', digest: 'd', operationId: 'o', parentQueue: false, checkpoint: null };
}

function start(store: WorkflowStore, id: string, scope?: string, parent?: WorkflowData['parent']): WorkflowView {
  return store.transact(() => {
    const state = store.create(initial(id, scope, parent));
    emit(state, { type: 'script_set', script: { name: 'test', sourceRef: 'artifact:source', args: null, defaults: { agentKind: 'codex' },
      runId: 'run-1', revision: 0, status: 'running', maxCalls: 8, calls: [], logs: [] } });
    return state;
  });
}

function count(store: WorkflowStore, sql: string): number {
  return (store.db.prepare(sql).get() as { count: number }).count;
}

describe('journal maintenance', () => {
  it('deletes the events a snapshot already covers', async () => {
    const path = await file();
    const store = open(path, { snapshotEvery: 2 });
    const state = start(store, 'a');
    store.transact(() => emit(state, { type: 'script_logged', text: 'one' }));
    const before = JSON.parse(JSON.stringify(store.public(store.state('scope-a')!)));
    expect(count(store, 'SELECT count(*) AS count FROM wf_events')).toBe(3);
    expect(count(store, 'SELECT count(*) AS count FROM wf_snapshots')).toBe(1);

    const result = await store.maintenance({ finishedBefore: 0 });
    expect(result.events).toBe(2);
    expect(count(store, 'SELECT count(*) AS count FROM wf_events')).toBe(1);
    // The snapshot still rebuilds the workflow.
    expect(JSON.parse(JSON.stringify(store.public(store.byId('a')!)))).toEqual(before);
  });

  it('keeps the events after the snapshot and rebuilds from them', async () => {
    const path = await file();
    const first = open(path, { snapshotEvery: 2 });
    const state = start(first, 'a');
    first.transact(() => emit(state, { type: 'script_logged', text: 'before snapshot' }));
    const before = JSON.parse(JSON.stringify(first.public(first.state('scope-a')!)));
    await first.maintenance({ finishedBefore: 0 });
    first.transact(() => emit(first.byId('a')!, { type: 'script_logged', text: 'after snapshot' }));
    const after = JSON.parse(JSON.stringify(first.public(first.byId('a')!)));
    first.close();

    const second = open(path);
    expect(JSON.parse(JSON.stringify(second.public(second.state('scope-a')!)))).toEqual(after);
    expect(after).not.toEqual(before);
  });

  it('deletes a finished tree past its retention window, its texts and its operation records', async () => {
    const path = await file();
    const store = open(path);
    const root = start(store, 'root');
    const child = start(store, 'child', undefined, childOf('root', 't1'));
    store.transact(() => {
      const ref = putText(root, 'a long goal');
      emit(root, { type: 'script_logged', text: 'goal:   ' + ref.digest });
      const childRef = putText(child, 'child artifact');
      emit(child, { type: 'script_logged', text: 'child:  ' + childRef.digest });
      store.commitOperation('scope-root', 'op-1', 'digest', () => ({ ok: true }), 'child');
    });
    store.transact(() => emit(child, { type: 'workflow_completed' }));
    store.transact(() => emit(root, { type: 'workflow_completed' }));
    expect(count(store, 'SELECT count(*) AS count FROM wf_texts')).toBe(2);
    expect(count(store, 'SELECT count(*) AS count FROM workflow_operations')).toBe(1);

    const result = await store.maintenance({ finishedBefore: 2_000, compact: false });
    expect(result.workflows).toBe(2);
    for (const table of ['wf_events', 'wf_snapshots', 'wf_catalog', 'wf_archive', 'wf_archived_tasks', 'wf_text_refs', 'workflow_operations']) {
      expect(count(store, `SELECT count(*) AS count FROM ${table}`)).toBe(0);
    }
    expect(count(store, 'SELECT count(*) AS count FROM wf_texts')).toBe(0);
    expect(store.state('scope-root')).toBeUndefined();
  });

  it('keeps a tree that finished inside the retention window', async () => {
    const store = open(':memory:');
    const root = start(store, 'root');
    store.transact(() => emit(root, { type: 'workflow_completed' }));
    const result = await store.maintenance({ finishedBefore: 500, compact: false });
    expect(result.workflows).toBe(0);
    expect(store.byId('root')).toBeDefined();
  });

  it('keeps texts another workflow still refers to', async () => {
    const store = open(':memory:');
    const one = start(store, 'one', 'scope-one');
    const two = start(store, 'two', 'scope-two');
    store.transact(() => { putText(one, 'shared text'); putText(two, 'shared text'); emit(one, { type: 'script_logged', text: 'x' }); });
    store.transact(() => { putText(two, 'shared text'); emit(two, { type: 'script_logged', text: 'y' }); });
    store.transact(() => emit(one, { type: 'workflow_completed' }));
    const result = await store.maintenance({ finishedBefore: 2_000, compact: false });
    expect(result.workflows).toBe(1);
    expect(count(store, 'SELECT count(*) AS count FROM wf_texts')).toBe(1);
  });

  it('does not re-read a finished child while its root is open', () => {
    const store = open(':memory:', { retainFinished: 0 });
    const root = start(store, 'root');
    start(store, 'child', undefined, childOf('root', 't1'));
    store.transact(() => emit(store.byId('child')!, { type: 'workflow_completed' }));
    const first = store.tree(store.byId('root')!).find(state => state.workflowId === 'child');
    const second = store.tree(store.byId('root')!).find(state => state.workflowId === 'child');
    expect(first).toBeDefined();
    expect(second).toBe(first);
    expect(root.status).toBe('active');
  });
});
