import { mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { writeFileAtomic } from '../platform/atomic-write';
import type { InboxState } from './types';

export class InboxStore {
  data: InboxState = { version: 1, cursors: {}, seen: {}, jobs: [], autoUsage: {} };
  constructor(readonly path: string) {}
  async load(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    try {
      const d = JSON.parse(await readFile(this.path, 'utf8')) as InboxState;
      if (d.version !== 1 || !Array.isArray(d.jobs) || !d.cursors || !d.seen || !d.autoUsage) throw new Error('invalid inbox state');
      this.data = d;
      // An interrupted analysis needs a deliberate retry, never an automatic rerun.
      for (const job of d.jobs) if (job.state === 'running') { job.state = 'failed'; job.error = 'Bridge 重启中断了分析，请重新处理'; }
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    await this.save();
  }
  async save(): Promise<void> { await writeFileAtomic(this.path, JSON.stringify(this.data), { mode: 0o600 }); }
}
