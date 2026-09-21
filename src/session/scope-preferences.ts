import { readFile } from 'node:fs/promises';
import type { AgentKind } from '../config/profile-schema';
import { writeFileAtomic } from '../platform/atomic-write';
import { parseEffort, type ModelSettings } from '../agent/model-settings';
import { validateModelId } from '../agent/models';

/** Chat preferences outlive /new and never imply that a transcript exists. */
export class ScopePreferencesStore {
  private data = new Map<string, ModelSettings>();
  private saving: Promise<void> = Promise.resolve();
  constructor(private readonly path: string) {}

  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.path, 'utf8'));
      for (const [key, value] of Object.entries(raw)) {
        const [agent] = JSON.parse(key);
        if (agent !== 'claude' && agent !== 'codex') continue;
        const entry = value as ModelSettings;
        this.data.set(key, {
          ...(entry.model ? { model: validateModelId(entry.model) } : {}),
          reasoningEffort: parseEffort(entry.reasoningEffort, agent),
        });
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }

  get(agent: AgentKind, scope: string): ModelSettings {
    return { ...this.data.get(JSON.stringify([agent, scope])) };
  }

  async update(agent: AgentKind, scope: string, patch: Partial<ModelSettings>): Promise<void> {
    const operation = this.saving.then(async () => {
      const key = JSON.stringify([agent, scope]);
      const next = new Map(this.data);
      const value = { ...next.get(key), ...patch };
      if (value.model || value.reasoningEffort) next.set(key, value);
      else next.delete(key);
      await writeFileAtomic(this.path, `${JSON.stringify(Object.fromEntries(next), null, 2)}\n`, { mode: 0o600 });
      this.data = next;
    });
    this.saving = operation.catch(() => {});
    await operation;
  }
}
