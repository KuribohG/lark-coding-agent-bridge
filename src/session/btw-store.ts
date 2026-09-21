import { readFile } from 'node:fs/promises';
import { writeFileAtomic } from '../platform/atomic-write';

export interface BtwExchange { question: string; answer: string }
interface BtwScope {
  generation?: string;
  exchanges: BtwExchange[];
  messageIds: string[];
}

/** One store per profile. Message IDs outlive replay history, including /new. */
export class BtwStore {
  private scopes = new Map<string, BtwScope>();
  private saving: Promise<void> = Promise.resolve();
  constructor(private readonly path?: string) {}

  async load(): Promise<void> {
    if (!this.path) return;
    try {
      const raw = JSON.parse(await readFile(this.path, 'utf8')) as Record<string, BtwScope>;
      for (const [scope, entry] of Object.entries(raw)) {
        if (!Array.isArray(entry.exchanges) || !Array.isArray(entry.messageIds) ||
          !entry.messageIds.every(id => typeof id === 'string') ||
          !entry.exchanges.every(e => typeof e.question === 'string' && typeof e.answer === 'string') ||
          (entry.generation !== undefined && typeof entry.generation !== 'string')) {
          throw new Error('invalid btw history');
        }
        this.scopes.set(scope, { ...entry, exchanges: bounded(entry.exchanges) });
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }

  hasMessage(scope: string, id: string): boolean {
    return this.scopes.get(scope)?.messageIds.includes(id) ?? false;
  }

  markMessage(scope: string, id: string): Promise<void> {
    const entry = this.entry(scope);
    if (!entry.messageIds.includes(id)) entry.messageIds.push(id);
    return this.save();
  }

  history(scope: string, generation: string): BtwExchange[] {
    const entry = this.scopes.get(scope);
    return entry?.generation === generation ? entry.exchanges.map(e => ({ ...e })) : [];
  }

  append(scope: string, generation: string, exchange: BtwExchange): Promise<void> {
    const entry = this.entry(scope);
    entry.exchanges = bounded([...this.history(scope, generation), exchange]);
    entry.generation = generation;
    return this.save();
  }

  clear(scope: string): Promise<void> {
    const entry = this.entry(scope);
    entry.exchanges = [];
    delete entry.generation;
    return this.save();
  }

  flush(): Promise<void> { return this.saving; }

  private entry(scope: string): BtwScope {
    let entry = this.scopes.get(scope);
    if (!entry) { entry = { exchanges: [], messageIds: [] }; this.scopes.set(scope, entry); }
    return entry;
  }

  private save(): Promise<void> {
    if (!this.path) return Promise.resolve();
    const path = this.path;
    const json = `${JSON.stringify(Object.fromEntries(this.scopes))}\n`;
    this.saving = this.saving.catch(() => {}).then(() => writeFileAtomic(path, json, { mode: 0o600 }));
    return this.saving;
  }
}

function bounded(exchanges: BtwExchange[]): BtwExchange[] {
  const result = exchanges.slice(-20).map(e => ({ question: clip(e.question), answer: clip(e.answer) }));
  while (JSON.stringify(result).length > 60_000) result.shift();
  return result;
}

function clip(text: string): string {
  return text.length > 16_000 ? `${text.slice(0, 16_000)}\n[旁问历史过长，后文省略]` : text;
}
