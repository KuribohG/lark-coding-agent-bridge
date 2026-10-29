import { normalizeExecutableLaunch, type ExecutableLaunchConfig } from '../launch-options';

export type AgyConfig = ExecutableLaunchConfig;
export function normalizeAgy(input: AgyConfig): AgyConfig {
  return normalizeExecutableLaunch(input, 'agy');
}
