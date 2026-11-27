import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { signalCellsAvailable, type SignalCell } from '../platform/signal-cell';

/**
 * The bridge-wide `[workflow]` table: what workflows are told about the machine the bridge runs on. It names
 * directories of that machine and what its kernel is used for, so every profile shares it.
 */
export interface WorkflowMachineSettings {
  /** The landing queues' own worktrees are made below this directory; beside the members' worktrees when absent. */
  trainDirectory?: string;
  /** wsfs workspaces keep what they change below this directory; beside their mount when absent. */
  wsfsStateDirectory?: string;
  /** false starts workers without a signal cell (see platform/signal-cell); they are confined when absent. */
  signalIsolation?: boolean;
}

const DIRECTORIES = { train_directory: 'trainDirectory', wsfs_state_directory: 'wsfsStateDirectory' } as const;

/** Validates the TOML `[workflow]` table and converts it to settings. */
export function parseWorkflowTable(input: unknown): WorkflowMachineSettings {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('workflow: expected a table');
  const out: WorkflowMachineSettings = {};
  for (const [key, value] of Object.entries(input)) {
    if (key === 'signal_isolation') {
      if (typeof value !== 'boolean') throw new Error('workflow.signal_isolation: expected boolean');
      out.signalIsolation = value;
      continue;
    }
    if (!Object.hasOwn(DIRECTORIES, key)) throw new Error(`workflow.${key}: unknown setting`);
    if (typeof value !== 'string' || !value.trim()) throw new Error(`workflow.${key}: expected a nonempty path`);
    if (!isAbsolute(value.trim()) && !value.trim().startsWith('~/')) throw new Error(`workflow.${key}: expected an absolute or ~/ path`);
    out[DIRECTORIES[key as keyof typeof DIRECTORIES]] = value.trim();
  }
  return out;
}

export function workflowTable(settings: WorkflowMachineSettings): Record<string, unknown> {
  return {
    ...(settings.trainDirectory ? { train_directory: settings.trainDirectory } : {}),
    ...(settings.wsfsStateDirectory ? { wsfs_state_directory: settings.wsfsStateDirectory } : {}),
    ...(settings.signalIsolation !== undefined ? { signal_isolation: settings.signalIsolation } : {}),
  };
}

/**
 * The signal cell the runs of one worker session are started in: on wherever the machine can do it, unless the table
 * turns it off. Signals that were refused are listed in `stateDirectory`, beside the workflows they belong to.
 */
export function workerSignalCell(settings: WorkflowMachineSettings | undefined, sessionKey: string, stateDirectory: string,
  available: boolean = signalCellsAvailable()): SignalCell | undefined {
  if (settings?.signalIsolation === false || !available) return undefined;
  return { id: sessionKey, log: join(stateDirectory, 'signal-cell.log') };
}

/** The directory a setting names, with `~/` as the home directory. */
export function placementDirectory(path: string | undefined): string | undefined {
  if (!path) return undefined;
  return path.startsWith('~/') ? join(homedir(), path.slice(2)) : resolve(path);
}
