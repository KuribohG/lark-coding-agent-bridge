import { normalizeExecutableFields, type ExecutableLaunchConfig } from '../launch-options';

export interface ClaudeConfig extends Partial<ExecutableLaunchConfig> {
  /** Directory containing Claude Code settings, projects, and other local state. */
  configDir?: string;
}

export function normalizeClaude(input: ClaudeConfig): ClaudeConfig {
  return { ...normalizeExecutableFields(input),
    ...(typeof input.configDir === 'string' && input.configDir ? { configDir: input.configDir } : {}) };
}
