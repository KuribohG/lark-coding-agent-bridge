import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from '../platform/atomic-write';
import type { LaunchCommand } from './process';

/** A bridge process `up` started, or found running and replaced. */
export interface Instance {
  pid: number;
  identity: string;
  /** Installation directory; for an adopted process, derived from its entry script. */
  release: string;
  label: string;
  commit?: string;
  version?: string;
  profiles: string[];
  /** See launchFingerprint; absent for processes `up` did not start. */
  fingerprint?: string;
  /** Without the environment, which may hold credentials. */
  launch: Omit<LaunchCommand, 'env'>;
  log?: string;
  startedAt: string;
}

export interface DeployState {
  current?: Instance;
  previous?: Instance;
}

const stateFile = (root: string) => join(root, 'state.json');

export function readState(root: string): DeployState {
  try { return JSON.parse(readFileSync(stateFile(root), 'utf8')) as DeployState; } catch { return {}; }
}

export async function writeState(root: string, state: DeployState): Promise<void> {
  await writeFileAtomic(stateFile(root), `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}
