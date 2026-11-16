import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { evolve } from '../src/engine/evolve';
import type { DomainEvent } from '../src/engine/events';
import { WorkflowKernel } from '../src/engine/kernel';
import { readWorkflowStates, replaceWorkflowState, WorkflowJournalError } from '../src/engine/kernel-store';
import type { WorkflowRoot, WorkflowState } from '../src/engine/types';

// Replaying a journal is only sound when every event it holds is understood. These tests pin both ends: the
// reducer rejects an unknown type instead of ignoring it, and a store that meets one fails that workflow loudly
// without taking the other workflows (or the bridge's startup) down with it.

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const root: WorkflowRoot = { scopeId: 'topic-1', profile: 'default', agentKind: 'codex', cwdRealpath: '/workspace',
  policyFingerprint: 'policy', catalogBinding: 'root-generation-1', modelSettings: {} };

function openKernel(path: string, warn = vi.fn()) {
  const kernel = new WorkflowKernel(path, {
    resolveRoot: async (scope: string) => scope === root.scopeId ? root : undefined,
    wakeMain: async () => {},
    log: { info: () => {}, warn },
    execute: async () => ({ status: 'failed', error: 'not used by these tests' }),
  }, () => 1000);
  cleanups.push(() => kernel.close());
  return { kernel, warn };
}

async function started(path: string): Promise<WorkflowState> {
  const h = openKernel(path);
  await h.kernel.call({ kind: 'main', scopeId: root.scopeId, allowStart: true }, 'run_script', {
    operationId: randomUUID(), goal: 'authorized review', plan: 'Review the change.', script: 'return null;',
  });
  return h.kernel.state(root.scopeId)!;
}

describe('journal replay validation', () => {
  it('rejects an event type the reducer does not know', () => {
    expect(() => evolve({} as never, { type: 'from_the_future' } as unknown as DomainEvent))
      .toThrow('Unhandled workflow event: from_the_future');
  });

  it('fails the workflow whose journal holds an unknown event, and only that workflow', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'workflow-journal-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
    const path = join(dir, 'state.db');
    const state = await started(path);
    // Another build wrote an event this one cannot apply.
    const db = new Database(path);
    try {
      db.prepare(`INSERT INTO wf_events(workflow_id, root_id, version, type, at, cause, data) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(state.workflowId, state.parent?.rootWorkflowId ?? state.workflowId, state.stateVersion + 1,
          'from_the_future', 1000, 'test', JSON.stringify({ type: 'from_the_future' }));
    } finally { db.close(); }

    const warn = vi.fn();
    const reopened = openKernel(path, warn);
    // Startup lists workflows; the broken one is reported and left out of scheduling.
    expect(warn).toHaveBeenCalledWith('workflow-unreadable', expect.objectContaining({ workflowId: state.workflowId }));
    expect(warn.mock.calls.filter(([event]) => event === 'workflow-unreadable')).toHaveLength(1);
    // Reading it by scope reports the cause too, rather than pretending the workflow does not exist.
    expect(() => reopened.kernel.state(root.scopeId)).toThrow(WorkflowJournalError);

    const read = () => reopened.kernel.state(root.scopeId, state.workflowId);
    expect(read).toThrow(WorkflowJournalError);
    expect(read).toThrow(/from_the_future/);
    // The error is cached: a second read does not replay the journal again.
    let first: unknown;
    let second: unknown;
    try { read(); } catch (error) { first = error; }
    try { read(); } catch (error) { second = error; }
    expect(first).toBe(second);

    // Direct tooling that reads every state reports the same failure instead of returning a partial state.
    expect(() => readWorkflowStates(path)).toThrow(WorkflowJournalError);

    // Repair tooling is the way out: replacing the workflow drops the journal it could not replay.
    await reopened.kernel.close();
    replaceWorkflowState(path, state);
    const repaired = readWorkflowStates(path);
    expect(repaired).toHaveLength(1);
    expect(repaired[0]!.goal).toBe('authorized review');
  });
});
