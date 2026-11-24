import {
  normalizeAuthMode,
  normalizeExecutableFields,
  type AgentAuthMode,
  type ExecutableLaunchConfig,
} from '../launch-options';

export interface ClaudeConfig extends Partial<ExecutableLaunchConfig> {
  /** Directory containing Claude Code settings, projects, and other local state. */
  configDir?: string;
  /**
   * MCP configuration file passed as `--mcp-config`. Claude Code honours a
   * server's `alwaysLoad` only for servers given this way: they connect before
   * the first request and their tools stay out of tool search.
   */
  mcpConfig?: string;
  authMode?: AgentAuthMode;
  apiKey?: string;
  authToken?: string;
  baseUrl?: string;
  model?: string;
  context1m?: boolean;
}

export function normalizeClaude(input: ClaudeConfig): ClaudeConfig {
  return { ...normalizeExecutableFields(input),
    ...(input.authMode !== undefined ? { authMode: normalizeAuthMode(input.authMode, 'claude.authMode') } : {}),
    ...(typeof input.apiKey === 'string' && input.apiKey ? { apiKey: input.apiKey } : {}),
    ...(typeof input.authToken === 'string' && input.authToken ? { authToken: input.authToken } : {}),
    ...(typeof input.baseUrl === 'string' && input.baseUrl ? { baseUrl: input.baseUrl } : {}),
    ...(typeof input.model === 'string' && input.model ? { model: input.model } : {}),
    ...(typeof input.context1m === 'boolean' ? { context1m: input.context1m } : {}),
    ...(typeof input.configDir === 'string' && input.configDir ? { configDir: input.configDir } : {}),
    ...(typeof input.mcpConfig === 'string' && input.mcpConfig ? { mcpConfig: input.mcpConfig } : {}) };
}
