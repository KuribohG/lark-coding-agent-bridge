import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

/**
 * The bridge-wide `[workflow]` table: where workflows put what need not be beside the members' worktrees. It names
 * directories of the machine the bridge runs on, so every profile shares it.
 */
export interface WorkflowPlacement {
  /** The landing queues' own worktrees are made below this directory; beside the members' worktrees when absent. */
  trainDirectory?: string;
  /** wsfs workspaces keep what they change below this directory; beside their mount when absent. */
  wsfsStateDirectory?: string;
}

const KEYS = { train_directory: 'trainDirectory', wsfs_state_directory: 'wsfsStateDirectory' } as const;

/** Validates the TOML `[workflow]` table and converts it to settings. */
export function parseWorkflowTable(input: unknown): WorkflowPlacement {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('workflow: expected a table');
  const out: WorkflowPlacement = {};
  for (const [key, value] of Object.entries(input)) {
    if (!Object.hasOwn(KEYS, key)) throw new Error(`workflow.${key}: unknown setting`);
    if (typeof value !== 'string' || !value.trim()) throw new Error(`workflow.${key}: expected a nonempty path`);
    if (!isAbsolute(value.trim()) && !value.trim().startsWith('~/')) throw new Error(`workflow.${key}: expected an absolute or ~/ path`);
    out[KEYS[key as keyof typeof KEYS]] = value.trim();
  }
  return out;
}

export function workflowTable(settings: WorkflowPlacement): Record<string, unknown> {
  return {
    ...(settings.trainDirectory ? { train_directory: settings.trainDirectory } : {}),
    ...(settings.wsfsStateDirectory ? { wsfs_state_directory: settings.wsfsStateDirectory } : {}),
  };
}

/** The directory a setting names, with `~/` as the home directory. */
export function placementDirectory(path: string | undefined): string | undefined {
  if (!path) return undefined;
  return path.startsWith('~/') ? join(homedir(), path.slice(2)) : resolve(path);
}
