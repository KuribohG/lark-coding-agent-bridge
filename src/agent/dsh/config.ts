import { normalizeExecutableLaunch, type ExecutableLaunchConfig } from '../launch-options';

export type DshConfig = ExecutableLaunchConfig;

export function normalizeDsh(input: DshConfig): DshConfig {
  return normalizeExecutableLaunch(input, 'dsh');
}
