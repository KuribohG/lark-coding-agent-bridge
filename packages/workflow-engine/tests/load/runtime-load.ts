import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { callWorkflow, WorkflowRuntime, type WorkerRunSpec, type WorkflowRoot } from '../../src';
import { memory, round, Samples, withLoopDelay } from './measure';

export interface RuntimeLoadOptions {
  path: string;
  /** Root workflows, each in its own scope. */
  workflows: number;
  /** Workers one workflow runs at once (the engine allows at most 16). */
  concurrency: number;
  /** `agents`: the script fans out one agent call per task. `queue`: it fills a work queue that a consumer pool claims from. */
  mode: 'agents' | 'queue';
  /** Agent calls (agents mode) or work items (queue mode) per workflow. */
  tasks: number;
  /** Simulated duration of one agent call or one work item. */
  thinkMs: number;
  promptChars: number;
  resultChars: number;
}

const AGENTS_SCRIPT = `const out = await parallel(Array.from({ length: args.tasks }, (_, i) => () => agent(args.prompt + ' #' + i, { key: 'task-' + i })));
return out.length;`;
const QUEUE_SCRIPT = `for (let i = 0; i < args.tasks; i++) await enqueueWork({ key: 'item-' + i, title: 'Item ' + i, input: { n: i, payload: args.prompt } });
await closeWorkQueue({ key: 'queue-closed' });
const out = await consumeWork({ key: 'consumers', members: args.members, prompt: 'Process each item.', maxTurns: 64 });
return out.queue.counts ?? out.queue;`;

/**
 * End-to-end load: real runtime, scheduler, script interpreter and worker IPC, with fake agents in place of native
 * processes. A fake agent takes `thinkMs` per call or work item and uses the workflow tools the way a real one does.
 * The time beyond what the agents themselves take is the engine's scheduling overhead.
 */
export async function runRuntimeLoad(options: RuntimeLoadOptions) {
  const ipc = new Samples();
  const ticks = new Samples();
  const finished = new Map<string, () => void>();
  let running = 0, peak = 0, turns = 0, items = 0;
  const runtime = new WorkflowRuntime({
    path: options.path,
    resolveRoot: async scopeId => root(scopeId),
    wakeMain: async scopeId => { finished.get(scopeId)?.(); },
    runner: { start: async (spec: WorkerRunSpec) => {
      await spec.validateBeforeRun();
      const tool = (method: string, args: Record<string, unknown> = {}) => ipc.timeAsync(() => callWorkflow(method, { operationId: randomUUID(), ...args }, spec.env));
      return {
        runId: randomUUID(), result: Promise.resolve('completed' as const),
        stop: async () => {}, waitForExit: async () => true, stopReason: () => undefined,
        async *events() {
          peak = Math.max(peak, ++running); turns++;
          try {
            yield { type: 'session' as const, nativeSessionId: spec.resume?.id ?? randomUUID() };
            if (options.mode === 'queue') {
              for (;;) {
                const grant = await tool('claim_work') as { claimId: string; generation: number } | null;
                if (!grant) break;
                const token = { claimId: grant.claimId, generation: grant.generation };
                await delay(options.thinkMs / 2);
                await tool('checkpoint_work', { ...token, expectedProgressVersion: 0, state: { step: 'half' } });
                await delay(options.thinkMs / 2);
                await tool('complete_work', { ...token, result: 'r'.repeat(Math.min(options.resultChars, 8_000)) });
                items++;
              }
            } else await delay(options.thinkMs);
            yield { type: 'final_text' as const, text: 'r'.repeat(options.resultChars) };
            yield { type: 'done' as const, normal: true };
          } finally { running--; }
        },
      };
    } },
  });
  const tick = runtime.kernel.tick.bind(runtime.kernel);
  runtime.kernel.tick = () => ticks.timeAsync(tick);
  let commits = 0;
  // Engines before the event-sourced store have no commit hook.
  (runtime.kernel as { onCommit?: (listener: () => void) => unknown }).onCommit?.(() => { commits++; });
  await runtime.start();
  try {
    const scopes = Array.from({ length: options.workflows }, (_, index) => 'load-' + index);
    const started = performance.now();
    const { loopDelay } = await withLoopDelay(() => Promise.all(scopes.map(async scopeId => {
      const done = new Promise<void>(resolve => finished.set(scopeId, resolve));
      const main = runtime.bindMain(scopeId, 'start');
      await callWorkflow('run_script', { operationId: randomUUID(), goal: 'load', plan: 'Fake agents process the load.',
        script: options.mode === 'queue' ? QUEUE_SCRIPT : AGENTS_SCRIPT, maxConcurrent: options.concurrency, maxAgents: 128,
        args: { tasks: options.tasks, prompt: 'p'.repeat(options.promptChars),
          members: Array.from({ length: options.concurrency }, (_, index) => ({ name: 'member-' + index })) } }, main.env);
      main.release();
      await done;
    })));
    const wallMs = performance.now() - started;
    const states = scopes.map(scopeId => runtime.kernel.state(scopeId)!);
    const failed = states.filter(state => state.script?.status !== 'result_ready').map(state => state.script?.error ?? state.script?.status);
    // Root scripts run four at a time; within a workflow the agents run `concurrency` at a time.
    const waves = Math.ceil(options.workflows / 4) * Math.ceil(options.tasks / options.concurrency);
    const idealMs = waves * options.thinkMs;
    return {
      options: { ...options, path: undefined },
      workflows: states.length, failed, turns, items, peakConcurrentAgents: peak,
      wallMs: round(wallMs), idealMs, overheadMs: round(wallMs - idealMs), overheadPerWaveMs: round((wallMs - idealMs) / waves),
      commits, ticks: ticks.summary(), ipc: ipc.summary(), loopDelay, memory: memory(),
      stateVersions: states.map(state => state.stateVersion).reduce((a, b) => a + b, 0),
    };
  } finally { await runtime.close(); }
}

function root(scopeId: string): WorkflowRoot {
  return { scopeId, profile: 'load', agentKind: 'fake', cwdRealpath: '/', policyFingerprint: 'policy', catalogBinding: 'main', modelSettings: {} };
}
