import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { writeFileAtomic } from '../../platform/atomic-write';

interface SlackThreadFile {
  version: 1;
  threads: string[];
}

const MAX_THREADS = 5_000;

export class SlackThreadStore {
  private readonly threads = new Set<string>();
  private readonly path: string;

  constructor(stateDir: string) {
    this.path = join(stateDir, 'slack-threads.json');
  }

  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.path, 'utf8')) as Partial<SlackThreadFile>;
      if (raw.version !== 1 || !Array.isArray(raw.threads)) return;
      for (const value of raw.threads.slice(-MAX_THREADS)) {
        if (typeof value === 'string' && value.includes('/')) this.threads.add(value);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) {
        throw error;
      }
    }
  }

  has(channel: string, threadTs: string): boolean {
    return this.threads.has(threadKey(channel, threadTs));
  }

  async add(channel: string, threadTs: string): Promise<void> {
    const key = threadKey(channel, threadTs);
    if (this.threads.has(key)) return;
    this.threads.add(key);
    while (this.threads.size > MAX_THREADS) {
      const oldest = this.threads.values().next().value as string | undefined;
      if (!oldest) break;
      this.threads.delete(oldest);
    }
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const payload: SlackThreadFile = { version: 1, threads: [...this.threads] };
    await writeFileAtomic(this.path, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  }
}

function threadKey(channel: string, threadTs: string): string {
  return `${channel}/${threadTs}`;
}
