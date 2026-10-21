import { readFile } from 'node:fs/promises';
import type { AgentKind } from '../config/profile-schema';
import { isAgentKind } from '../agent/backends';
import { writeFileAtomic } from '../platform/atomic-write';

interface ScopeExecutionFile {
  version: 1;
  scopes: Record<string, AgentKind>;
}

/** Per-chat/topic execution-engine overrides. Profile.agentKind remains the fallback. */
export class ScopeExecutionStore {
  private data = new Map<string, AgentKind>();
  private saving: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.path, 'utf8')) as Partial<ScopeExecutionFile>;
      if (raw.version !== 1 || !raw.scopes || typeof raw.scopes !== 'object') return;
      this.data.clear();
      for (const [scope, value] of Object.entries(raw.scopes)) {
        if (scope && typeof value === 'string' && isAgentKind(value)) this.data.set(scope, value);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }

  get(scope: string): AgentKind | undefined {
    return this.data.get(scope);
  }

  async set(scope: string, agentKind: AgentKind): Promise<void> {
    await this.update(() => this.data.set(scope, agentKind));
  }

  async clear(scope: string): Promise<boolean> {
    let removed = false;
    await this.update(() => {
      removed = this.data.delete(scope);
    });
    return removed;
  }

  async clearAgentKind(agentKind: AgentKind): Promise<void> {
    await this.update(() => {
      for (const [scope, value] of this.data) {
        if (value === agentKind) this.data.delete(scope);
      }
    });
  }

  entries(): Array<{ scope: string; agentKind: AgentKind }> {
    return [...this.data].map(([scope, agentKind]) => ({ scope, agentKind }));
  }

  async flush(): Promise<void> {
    const scopes = Object.fromEntries(this.data);
    await writeFileAtomic(this.path, `${JSON.stringify({ version: 1, scopes }, null, 2)}\n`, {
      mode: 0o600,
    });
  }

  private async update(mutate: () => void): Promise<void> {
    const operation = this.saving.then(async () => {
      mutate();
      await this.flush();
    });
    this.saving = operation.catch(() => {});
    await operation;
  }
}
