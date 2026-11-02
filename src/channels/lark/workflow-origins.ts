import type { NormalizedMessage } from '@larksuite/channel';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { log } from '../../core/logger';
import { writeFileAtomic } from '../../platform/atomic-write';

const MAX_ORIGINS = 512;

/**
 * Latest message per scope, used to authorize and address a workflow's chat. Persisted so a
 * restarted bridge can resume workflows and deliver their notices before anyone writes again.
 */
export class WorkflowOrigins extends Map<string, NormalizedMessage> {
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly path?: string) { super(); }

  async load(): Promise<void> {
    if (!this.path) return;
    try {
      const raw = JSON.parse(await readFile(this.path, 'utf8')) as { version?: unknown; origins?: unknown };
      if (raw.version !== 1 || !Array.isArray(raw.origins)) return;
      for (const entry of raw.origins.slice(-MAX_ORIGINS)) {
        if (Array.isArray(entry) && typeof entry[0] === 'string' && entry[1] && typeof entry[1].chatId === 'string') super.set(entry[0], entry[1] as NormalizedMessage);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }
  }

  override set(scope: string, message: NormalizedMessage): this {
    // Re-insert so the most recent scopes survive pruning.
    super.delete(scope);
    super.set(scope, message);
    while (this.size > MAX_ORIGINS) super.delete(this.keys().next().value as string);
    this.persist();
    return this;
  }

  /** Resolves after every write requested so far has finished. */
  flush(): Promise<void> { return this.writes; }

  private persist(): void {
    const path = this.path;
    if (!path) return;
    const payload = `${JSON.stringify({ version: 1, origins: [...this.entries()] })}\n`;
    this.writes = this.writes.then(async () => {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFileAtomic(path, payload, { mode: 0o600 });
    }).catch(error => log.warn('workflow', 'origin-persist-failed', { error: String(error) }));
  }
}
