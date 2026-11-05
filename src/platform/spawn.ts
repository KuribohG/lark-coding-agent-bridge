import type {
  ChildProcess,
  ChildProcessByStdio,
  SpawnOptions,
  SpawnSyncOptions,
} from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import crossSpawn from 'cross-spawn';

export function spawnProcess(
  command: string,
  args: readonly string[] = [],
  options: SpawnOptions = {},
): ChildProcess {
  // The tray-launched supervisor has no console. Without this flag every
  // console child (node.exe, .cmd shims such as claude/codex/lark-cli) opens a
  // visible window on Windows; callers can still opt out explicitly.
  return crossSpawn(command, [...args], { windowsHide: true, ...options });
}

export function spawnProcessSync(
  command: string,
  args: readonly string[] = [],
  options: SpawnSyncOptions = {},
) {
  return crossSpawn.sync(command, [...args], { windowsHide: true, ...options });
}

export function mergeProcessEnv(
  base: NodeJS.ProcessEnv = process.env,
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    for (const existing of Object.keys(out)) {
      if (existing.toLowerCase() === key.toLowerCase()) {
        delete out[existing];
      }
    }
    if (value !== undefined) out[key] = value;
  }
  return out;
}

export type SpawnedProcessByStdio<
  Stdin extends Writable | null,
  Stdout extends Readable | null,
  Stderr extends Readable | null,
> = ChildProcessByStdio<Stdin, Stdout, Stderr>;
