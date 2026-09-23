import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ModelSettings } from '../agent/model-settings';
import type { MutableProfileState } from '../config/config-ops';
import { resolveAppPaths } from '../config/app-paths';
import { writeFileAtomic } from '../platform/atomic-write';

export type TimedRunState = 'draft' | 'queued' | 'running' | 'completed' | 'stopped' | 'expired' | 'failed' | 'quota' | 'interrupted';
export interface TimedRun {
  agentKind?: import('../config/profile-schema').AgentKind;
  id: string;
  scope: string;
  owner: string;
  task: string;
  timeZone: string;
  deadlineAt: number;
  stopAt: number;
  windDownAt: number;
  modelSettings: ModelSettings;
  createdAt: number;
  state: TimedRunState;
  finishedAt?: number;
}

const liveStates = new Set<TimedRunState>(['queued', 'running']);

export class TimedRunStore {
  private jobs = new Map<string, TimedRun>();
  private saving: Promise<void> = Promise.resolve();
  constructor(readonly path: string) {}

  async load(now = Date.now()): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.path, 'utf8')) as TimedRun[];
      for (const job of raw) {
        if (!job.id || !job.scope || !Number.isFinite(job.stopAt)) throw new Error('invalid timed-run record');
        this.jobs.set(job.id, liveStates.has(job.state)
          ? { ...job, state: job.stopAt <= now ? 'expired' : 'interrupted', finishedAt: now } : job);
      }
      await this.persist(this.jobs);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }

  get(id: string): TimedRun | undefined {
    const job = this.jobs.get(id);
    return job ? structuredClone(job) : undefined;
  }

  latest(scope: string): TimedRun | undefined {
    const job = [...this.jobs.values()].reverse().find((job) => job.scope === scope);
    return job ? structuredClone(job) : undefined;
  }

  async create(input: Omit<TimedRun, 'id' | 'createdAt' | 'state'>): Promise<TimedRun> {
    const job: TimedRun = { ...input, id: randomUUID(), createdAt: Date.now(), state: 'draft' };
    await this.write((next) => { next.set(job.id, job); });
    return structuredClone(job);
  }

  async transition(id: string, from: TimedRunState[], to: TimedRunState): Promise<TimedRun> {
    let changed!: TimedRun;
    await this.write((next) => {
      const job = next.get(id);
      if (!job || !from.includes(job.state)) throw new Error('任务状态已改变，请重新查看 /run status。');
      if (liveStates.has(to) && job.stopAt <= Date.now()) throw new Error('停止时间已过，任务不会启动。');
      changed = { ...job, state: to, ...(!liveStates.has(to) && to !== 'draft' ? { finishedAt: Date.now() } : {}) };
      next.set(id, changed);
    });
    return structuredClone(changed);
  }

  async finish(id: string, state: TimedRunState): Promise<void> {
    await this.write((next) => {
      const job = next.get(id);
      if (job && liveStates.has(job.state)) next.set(id, { ...job, state, finishedAt: Date.now() });
    });
  }

  private async write(mutate: (next: Map<string, TimedRun>) => void): Promise<void> {
    const operation = this.saving.then(async () => {
      const next = new Map(this.jobs);
      mutate(next);
      await this.persist(next);
      this.jobs = next;
    });
    this.saving = operation.catch(() => {});
    await operation;
  }

  private persist(jobs: Map<string, TimedRun>): Promise<void> {
    return writeFileAtomic(this.path, JSON.stringify([...jobs.values()], null, 2) + '\n', { mode: 0o600 });
  }
}

const stores = new WeakMap<object, Promise<TimedRunStore>>();
export function timedRuns(state: MutableProfileState): Promise<TimedRunStore> {
  let result = stores.get(state);
  if (!result) {
    result = (async () => {
      const paths = resolveAppPaths({ rootDir: dirname(state.configPath), profile: state.profile });
      const store = new TimedRunStore(join(paths.profileDir, 'timed-runs.json'));
      await store.load();
      return store;
    })();
    stores.set(state, result);
    result.catch(() => stores.delete(state));
  }
  return result;
}
