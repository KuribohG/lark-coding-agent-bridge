import { normalizeExecutableLaunch, type ExecutableLaunchConfig } from '../launch-options';

export interface PiConfig extends ExecutableLaunchConfig {
  /** Directory containing Pi settings, sessions, auth.json, and model catalogs. */
  agentDir?: string;
}

export function normalizePi(input: PiConfig): PiConfig {
  return { ...normalizeExecutableLaunch(input, 'pi'),
    ...(typeof input.agentDir === 'string' && input.agentDir ? { agentDir: input.agentDir } : {}) };
}
