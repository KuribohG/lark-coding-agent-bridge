import { mkdirSync, writeFileSync } from 'node:fs';
import { Session } from 'node:inspector/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runRuntimeLoad, type RuntimeLoadOptions } from './load/runtime-load';
import { runStoreLoad, type StoreLoadOptions } from './load/store-load';

/**
 * The load tools, run small enough for every test run to keep them working. For real measurements:
 *
 *   WORKFLOW_ENGINE_VERIFY=0 WORKFLOW_LOAD='{"store":{"workers":1000,"turns":5}}' WORKFLOW_LOAD_DIR=/data/bench \
 *     WORKFLOW_LOAD_REPORT=/data/bench/report.json npx vitest run tests/load.test.ts
 *
 * WORKFLOW_LOAD takes `store` and/or `runtime` option overrides (see StoreLoadOptions and RuntimeLoadOptions), or
 * arrays of them to run several configurations. WORKFLOW_LOAD_DIR chooses the filesystem the database is on.
 * WORKFLOW_LOAD_PROFILE names a file to write a CPU profile of the configured load to.
 */
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function database(): Promise<string> {
  const directory = await mkdtemp(join(process.env.WORKFLOW_LOAD_DIR ?? tmpdir(), 'workflow-load-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  return join(directory, 'state.sqlite');
}

const STORE: Omit<StoreLoadOptions, 'path'> = { workers: 40, turns: 3, workflows: 2, thinkMs: 20, promptChars: 2_000, resultChars: 4_000 };
const RUNTIME: Omit<RuntimeLoadOptions, 'path'> = { workflows: 2, concurrency: 4, mode: 'agents', tasks: 8, thinkMs: 20, promptChars: 2_000, resultChars: 4_000 };

describe('workflow load tools', () => {
  it('drives fake agents through the store and rebuilds the same state from the journal', async () => {
    const report = await runStoreLoad({ ...STORE, path: await database() });
    expect(report).toMatchObject({ tasks: 120, unfinished: 0, rebuildMatches: true, largestState: { tasks: 60 } });
    // Per workflow: created + script set; per turn: task, call, attempt x4, session bound, artifact, end; per agent: session.
    expect(report.events).toBe(2 * 2 + 120 * 8 + 40);
    expect(report.commits.count).toBe(2 + 120 * 6);
  });

  it.each(['agents', 'queue'] as const)('drives fake agents through the runtime in %s mode', async mode => {
    const report = await runRuntimeLoad({ ...RUNTIME, mode, path: await database() });
    expect(report.failed).toEqual([]);
    expect(report.peakConcurrentAgents).toBeLessThanOrEqual(8);
    if (mode === 'queue') expect(report.items).toBe(16);
    else expect(report.turns).toBe(16);
  });

  it.each(['agents', 'queue'] as const)('runs 200 workers of one workflow at once in %s mode', async mode => {
    // Verification replays the whole journal after every commit, which at this size takes minutes; the smaller runs above keep it on.
    const verify = process.env.WORKFLOW_ENGINE_VERIFY;
    process.env.WORKFLOW_ENGINE_VERIFY = '0';
    cleanup.push(async () => { process.env.WORKFLOW_ENGINE_VERIFY = verify; });
    const report = await runRuntimeLoad({ ...RUNTIME, workflows: 1, concurrency: 200, tasks: 240, thinkMs: 1_500, mode, path: await database() });
    expect(report.failed).toEqual([]);
    expect(report.peakConcurrentAgents).toBe(200);
    if (mode === 'queue') expect(report).toMatchObject({ items: 240, turns: 200 });
    else expect(report.turns).toBe(240);
  }, 60_000);

  it.skipIf(!process.env.WORKFLOW_LOAD)('runs the configured load and writes its report', async () => {
    const config = JSON.parse(process.env.WORKFLOW_LOAD!) as { store?: Partial<StoreLoadOptions> | Array<Partial<StoreLoadOptions>>;
      runtime?: Partial<RuntimeLoadOptions> | Array<Partial<RuntimeLoadOptions>> };
    const reports: unknown[] = [];
    const profiler = process.env.WORKFLOW_LOAD_PROFILE ? new Session() : undefined;
    if (profiler) { profiler.connect(); await profiler.post('Profiler.enable'); await profiler.post('Profiler.start'); }
    for (const options of [config.store ?? []].flat()) reports.push({ kind: 'store', ...await runStoreLoad({ ...STORE, ...options, path: await database() }) });
    for (const options of [config.runtime ?? []].flat()) reports.push({ kind: 'runtime', ...await runRuntimeLoad({ ...RUNTIME, ...options, path: await database() }) });
    if (profiler) {
      writeFileSync(process.env.WORKFLOW_LOAD_PROFILE!, JSON.stringify((await profiler.post('Profiler.stop')).profile));
      profiler.disconnect();
    }
    const text = JSON.stringify(reports, null, 2);
    if (process.env.WORKFLOW_LOAD_REPORT) {
      mkdirSync(dirname(process.env.WORKFLOW_LOAD_REPORT), { recursive: true });
      writeFileSync(process.env.WORKFLOW_LOAD_REPORT, text + '\n');
    }
    console.log(text);
    expect(reports.length).toBeGreaterThan(0);
  }, 3_600_000);
});
