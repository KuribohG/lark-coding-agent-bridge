import { normalizeExecutableFields, type ExecutableLaunchConfig } from '../launch-options';

export interface ClaudeConfig extends Partial<ExecutableLaunchConfig> {
  /** Directory containing Claude Code settings, projects, and other local state. */
  configDir?: string;
  /**
   * MCP configuration file passed as `--mcp-config`. Claude Code honours a
   * server's `alwaysLoad` only for servers given this way: they connect before
   * the first request and their tools stay out of tool search.
   */
  mcpConfig?: string;
}

export function normalizeClaude(input: ClaudeConfig): ClaudeConfig {
  return { ...normalizeExecutableFields(input),
    ...(typeof input.configDir === 'string' && input.configDir ? { configDir: input.configDir } : {}),
    ...(typeof input.mcpConfig === 'string' && input.mcpConfig ? { mcpConfig: input.mcpConfig } : {}) };
}
