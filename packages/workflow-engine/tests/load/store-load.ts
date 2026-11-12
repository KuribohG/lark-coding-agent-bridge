import { statSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { workflowDigest } from '../../src/engine/digest';
import { emit, putText, WorkflowStore } from '../../src/engine/kernel-store';
import { SCRIPT_DEFINITION } from '../../src/engine/script-contract';
import type { WorkflowView } from '../../src/engine/types';
import { memory, round, Samples, withLoopDelay } from './measure';

export interface StoreLoadOptions {
  /** SQLite file; put it on the filesystem whose commit cost is of interest. */
  path: string;
  /** Checkpoint the WAL on a background thread, as the kernel does. Default true; false measures checkpoints inside commits. */
  backgroundCheckpoint?: boolean;
  /** Simulated agents, all working at once. */
  workers: number;
  /** Turns each agent runs. */
  turns: number;
  /** Workflows the agents are spread over; 1 puts every task in one state. */
  workflows: number;
  /** Simulated duration of a turn. */
  thinkMs: number;
  promptChars: number;
  resultChars: number;
}

/**
 * Store-level load: fake agents write the journal traffic of plain worker turns straight through the store, without
 * the kernel's admission limits. Each turn is six commits, the same ones the scheduler makes: task created, attempt
 * started, spawned, admitted, session bound, result recorded. Reports commit throughput and latency, how long the
 * event loop was blocked, what a reader's copy of the largest state costs, and how long a restart takes to rebuild.
 */
export async function runStoreLoad(options: StoreLoadOptions) {
  const store = new WorkflowStore(options.path, Date.now, { backgroundCheckpoint: options.backgroundCheckpoint ?? true });
  const commits = new Samples();
  const transact = (fn: () => void) => commits.time(() => store.transact(fn, 'load'));
  const ids = Array.from({ length: options.workflows }, (_, index) => `load-${index}`);
  for (const [index, workflowId] of ids.entries()) transact(() => {
    const state = store.create({ workflowId, root: { scopeId: 'scope-' + index, profile: 'load', agentKind: 'fake', cwdRealpath: '/', policyFingerprint: 'p',
      catalogBinding: 'b', modelSettings: {} }, definition: structuredClone(SCRIPT_DEFINITION), definitionDigest: 'd', goal: 'load', stateVersion: 0,
    status: 'active', createdAt: Date.now(), deadlineAt: Date.now() + 3_600_000, sessions: [], tasks: [], artifacts: [], events: [] });
    emit(state, { type: 'script_set', script: { name: 'load', sourceRef: 'artifact:none', args: null, defaults: { agentKind: 'fake' }, runId: 'run', revision: 0,
      status: 'running', maxCalls: options.workers * options.turns, calls: [], logs: [] } });
  });
  const live = (index: number): WorkflowView => store.byId(ids[index % ids.length]!)!;
  const prompt = 'p'.repeat(options.promptChars);
  const result = 'r'.repeat(options.resultChars);
  const worker = async (index: number) => {
    const sessionRef = `session-${index}`;
    // Agents do not start in lockstep.
    await delay(Math.random() * options.thinkMs);
    for (let turn = 0; turn < options.turns; turn++) {
      const taskId = `task-${index}-${turn}`;
      const state = live(index);
      transact(() => {
        if (!turn) emit(state, { type: 'session_created', session: { sessionRef, actorId: sessionRef, actorKey: sessionRef, role: 'worker', generation: 1,
          nativeIdKind: 'sessionId', execution: { agentKind: 'fake', profile: 'load', configurationFingerprint: 'c', policyFingerprint: 'p', modelSettings: {} } } });
        emit(state, { type: 'task_created', task: { taskId, taskKey: taskId, requestDigest: taskId, sessionRef, objective: putText(state, `${taskId} ${prompt}`),
          inputRefs: [], status: 'queued', attempts: [], resultRefs: [], scriptRunId: 'run', scriptKey: taskId, scriptOutput: 'text', cacheKey: taskId } });
        emit(state, { type: 'script_call_recorded', call: { key: taskId, taskId, cached: false } });
      });
      transact(() => emit(state, { type: 'attempt_started', taskId, attempt: { attemptId: taskId + '-a', startedAt: Date.now(), sessionGeneration: 1 } }));
      await delay(options.thinkMs / 4);
      transact(() => emit(state, { type: 'attempt_spawned', taskId, runId: taskId + '-r', at: Date.now() }));
      transact(() => emit(state, { type: 'attempt_admitted', taskId, at: Date.now() }));
      transact(() => emit(state, { type: 'session_bound', sessionRef, taskId, nativeSessionId: 'native-' + index, at: Date.now() }));
      await delay(options.thinkMs * 3 / 4);
      transact(() => {
        const artifact = { ref: 'artifact:' + taskId, kind: 'result', ...putText(state, `${taskId} ${result}`), createdAt: Date.now(), taskId, attemptId: taskId + '-a' };
        emit(state, { type: 'artifact_added', artifact });
        emit(state, { type: 'attempt_ended', taskId, at: Date.now(), result: 'completed', status: 'result_ready', resultRef: artifact.ref });
      });
    }
  };
  const started = performance.now();
  const { loopDelay } = await withLoopDelay(() => Promise.all(Array.from({ length: options.workers }, (_, index) => worker(index))));
  const wallMs = performance.now() - started;
  const states = ids.map(id => store.byId(id)!);
  const tasks = states.reduce((total, state) => total + state.tasks.length, 0);
  const unfinished = states.reduce((total, state) => total + state.tasks.filter(task => task.status !== 'result_ready').length, 0);
  const digests = states.map(state => workflowDigest(state));
  const largest = states.reduce((a, b) => a.tasks.length >= b.tasks.length ? a : b);
  // What a reader pays for a detached copy, and how much text stays out of memory until someone reads it.
  const copy = new Samples();
  const copied = copy.time(() => store.public(largest));
  const structureBytes = JSON.stringify(largest).length;
  const withTextsBytes = JSON.stringify(copied).length;
  const events = (store.db.prepare('SELECT count(*) AS count FROM wf_events').get() as { count: number }).count;
  const used = memory();
  const close = new Samples(); close.time(() => store.close());
  // A restart after a clean stop loads snapshots; after a kill it replays whatever the last snapshot does not cover.
  const reopen = (dropSnapshots: boolean) => {
    const timing = new Samples();
    const reopened = new WorkflowStore(options.path, Date.now);
    if (dropSnapshots) reopened.db.exec('DELETE FROM wf_snapshots');
    const matches = timing.time(() => reopened.list().map(state => workflowDigest(state)).sort().join() === [...digests].sort().join());
    reopened.close();
    return { ms: timing.summary().total, matches };
  };
  const fromSnapshots = reopen(false);
  const fromJournal = reopen(true);
  const summary = commits.summary();
  return {
    options: { ...options, path: undefined },
    tasks, unfinished, events, wallMs: round(wallMs),
    commits: { ...summary, perSecond: Math.round(summary.count / wallMs * 1000), busyShare: round(summary.total / wallMs) },
    loopDelay, memory: used,
    dbMb: round((statSync(options.path).size + (statSync(options.path + '-wal', { throwIfNoEntry: false })?.size ?? 0)) / 1e6),
    largestState: { tasks: largest.tasks.length, structureBytes, withTextsBytes, publicCopyMs: copy.summary().total },
    closeMs: close.summary().total,
    reloadFromSnapshotsMs: fromSnapshots.ms, reloadFromJournalMs: fromJournal.ms,
    rebuildMatches: fromSnapshots.matches && fromJournal.matches,
  };
}
