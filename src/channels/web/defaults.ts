import { readFile } from 'node:fs/promises';
import { isAgentKind } from '../../agent/backends';
import type { ModelSettings } from '../../agent/model-settings';
import type { AgentKind } from '../../config/profile-schema';
import { log } from '../../core/logger';
import { writeFileAtomic } from '../../platform/atomic-write';

/** What the person last chose in the page. A conversation begins with it; one that has begun keeps its own. */
export interface WebChoices {
  agent?: AgentKind;
  /** The model, model service and effort last chosen for each engine. */
  settings: Partial<Record<AgentKind, ModelSettings>>;
}

export class WebDefaults {
  private choices: WebChoices = { settings: {} };
  private saving: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  async load(): Promise<void> {
    let raw: string;
    try { raw = await readFile(this.path, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    try {
      const parsed = JSON.parse(raw) as { agent?: unknown; settings?: Record<string, Record<string, unknown>> };
      const settings: WebChoices['settings'] = {};
      for (const [kind, chosen] of Object.entries(parsed.settings ?? {})) {
        if (!isAgentKind(kind) || !chosen || typeof chosen !== 'object') continue;
        // Whether a value still means anything is found out when a conversation is given it.
        const text = (value: unknown) => typeof value === 'string' && value ? value : undefined;
        settings[kind] = { model: text(chosen.model), provider: text(chosen.provider),
          reasoningEffort: text(chosen.reasoningEffort) as ModelSettings['reasoningEffort'] };
      }
      this.choices = { ...(typeof parsed.agent === 'string' && isAgentKind(parsed.agent) ? { agent: parsed.agent } : {}), settings };
    } catch (err) {
      // Choices that cannot be read are made again; they must not keep the chat from starting.
      log.warn('web', 'defaults-unreadable', { err: String(err) });
    }
  }

  get(): WebChoices {
    return { ...this.choices, settings: { ...this.choices.settings } };
  }

  remember(change: { agent?: AgentKind; settings?: [AgentKind, ModelSettings] }): Promise<void> {
    const settings = { ...this.choices.settings };
    if (change.settings) {
      const [kind, chosen] = change.settings;
      if (chosen.model || chosen.provider || chosen.reasoningEffort) settings[kind] = { ...chosen };
      else delete settings[kind];
    }
    this.choices = { ...(change.agent ?? this.choices.agent ? { agent: change.agent ?? this.choices.agent } : {}), settings };
    const body = `${JSON.stringify(this.choices, null, 2)}\n`;
    this.saving = this.saving.then(() => writeFileAtomic(this.path, body, { mode: 0o600 }))
      .catch(err => log.warn('web', 'defaults-write-failed', { err: String(err) }));
    return this.saving;
  }
}
