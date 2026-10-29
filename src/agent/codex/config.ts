import { normalizeExecutableLaunch, type ExecutableLaunchConfig } from '../launch-options';

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
  codexHome?: string;
  inheritCodexHome?: boolean;
  ignoreUserConfig?: boolean;
  ignoreRules?: boolean;
}

export function normalizeCodex(input: CodexConfig & { flags?: unknown }): CodexConfig {
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
  const codex: CodexConfig = {
    ...normalizeExecutableLaunch(input, 'codex'),
    transport: 'app-server',
    appServerMode: input.appServerMode ?? 'daemon',
    ...(typeof input.codexHome === 'string' ? { codexHome: input.codexHome } : {}),
    inheritCodexHome: input.inheritCodexHome !== false,
    ignoreUserConfig: false,
    ignoreRules: false,
  };
  return codex;
}
