import { mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { writeFileAtomic } from '../platform/atomic-write';
import { migrateWorkItem } from './identity';
import type { WorkItemState } from './types';

export class WorkItemStore {
  data: WorkItemState = { version: 1, cursors: {}, seen: {}, jobs: [], autoUsage: {} };
  private persisted = '';
  constructor(readonly path: string) {}
  async load(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    try {
      const d = JSON.parse(await readFile(this.path, 'utf8')) as WorkItemState;
      if (d.version !== 1 || !Array.isArray(d.jobs) || !d.cursors || !d.seen || !d.autoUsage) throw new Error('invalid inbox state');
      this.data = d;
      for (const job of d.jobs) migrateWorkItem(job);
      // Default to a deliberate retry; the service may opt into bounded restart recovery.
      for (const job of d.jobs) if (job.state === 'running') {
        job.state = 'failed'; job.analysisRequested = false; job.analysisPaused = true;
        job.restartPending = true; job.error = 'Bridge 重启中断了分析，请重新处理';
      }
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    await this.save();
  }
  async save(): Promise<void> {
    const encoded = JSON.stringify(this.data);
    if (encoded === this.persisted) return;
    await writeFileAtomic(this.path, encoded, { mode: 0o600 }); this.persisted = encoded;
  }
}
