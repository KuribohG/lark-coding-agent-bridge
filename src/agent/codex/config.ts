import {
  normalizeAuthMode,
  normalizeExecutableLaunch,
  type AgentAuthMode,
  type ExecutableLaunchConfig,
} from '../launch-options';

export type CodexAppServerMode = 'daemon' | 'per-run';

export interface CodexConfig extends ExecutableLaunchConfig {
  transport?: 'app-server';
  /**
   * `daemon` keeps Codex's app-server alive across Bridge runs so native
   * background memory extraction/consolidation can finish. `per-run` starts a
   * short-lived app-server and disables generation from new threads while
   * retaining Codex's native memory read/startup path.
   */
  appServerMode?: CodexAppServerMode;
  /** Model service selected once at Bridge startup. */
  provider?: string;
  authMode?: AgentAuthMode;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  codexHome?: string;
  inheritCodexHome?: boolean;
  ignoreUserConfig?: boolean;
  ignoreRules?: boolean;
}

export function normalizeCodex(input: CodexConfig & { flags?: unknown }): CodexConfig {
  if (input.provider !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(input.provider)) {
    throw new Error('codex.provider must be a model service name');
  }
  if (input.transport !== undefined && input.transport !== 'app-server') {
    throw new Error('Codex exec transport has been removed; use transport=app-server');
  }
  if (input.appServerMode !== undefined
    && input.appServerMode !== 'daemon'
    && input.appServerMode !== 'per-run') {
    throw new Error('codex.appServerMode must be daemon or per-run');
  }
  if (input.ignoreUserConfig || input.ignoreRules) {
    throw new Error('app-server requires ignoreUserConfig=false and ignoreRules=false; exec-only ignore flags are not supported');
  }
  const authMode = input.authMode !== undefined
    ? normalizeAuthMode(input.authMode, 'codex.authMode')
    : undefined;
  const inheritCodexHome = authMode === 'api_key'
    ? false
    : authMode === 'oauth'
      ? (input.inheritCodexHome ?? true)
      : input.inheritCodexHome === true;
  const codex: CodexConfig = {
    ...normalizeExecutableLaunch(input, 'codex'),
    transport: 'app-server',
    appServerMode: input.appServerMode ?? 'daemon',
    ...(authMode ? { authMode } : {}),
    ...(typeof input.apiKey === 'string' && input.apiKey ? { apiKey: input.apiKey } : {}),
    ...(typeof input.baseUrl === 'string' && input.baseUrl ? { baseUrl: input.baseUrl } : {}),
    ...(typeof input.model === 'string' && input.model ? { model: input.model } : {}),
    ...(input.provider ? { provider: input.provider } : {}),
    ...(typeof input.codexHome === 'string' ? { codexHome: input.codexHome } : {}),
    inheritCodexHome,
    ignoreUserConfig: false,
    ignoreRules: false,
  };
  return codex;
}
