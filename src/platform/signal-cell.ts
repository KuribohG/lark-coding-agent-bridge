import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Signal confinement for agent runs (Linux seccomp, kernel 5.5+).
 *
 * A run started in a cell goes through `bin/signal-cell`: its processes can signal each other and the processes of
 * other runs with the same cell ID, and nothing else on the machine. That keeps one workflow member's `pkill` from
 * reaching another member's build. It guards against accidents and is not a security boundary. See
 * docs/signal-isolation.md.
 */
export interface SignalCell {
  /** Runs that share an ID share a cell. */
  id: string;
  /** File that gets one line for each signal the cell denied. */
  log?: string;
}

export interface SignalCellInput {
  cell: SignalCell | undefined;
  platform?: NodeJS.Platform;
  launcher?: string;
}

/** Path of the compiled launcher; resolved the same way as bin/landlock-exec. */
function signalCellLauncherPath(): string {
  return fileURLToPath(new URL(
    import.meta.url.endsWith('.ts') ? '../../bin/signal-cell' : '../bin/signal-cell', import.meta.url,
  ));
}

/** Whether this machine starts a run that is given a cell through the launcher: Linux, with the launcher built. */
export function signalCellsAvailable(input: Omit<SignalCellInput, 'cell'> = {}): boolean {
  return (input.platform ?? process.platform) === 'linux' && existsSync(input.launcher ?? signalCellLauncherPath());
}

/**
 * Wrap a command line in the cell launcher. Returns it unchanged without a cell or where cells are not available, so
 * callers can pass every spawn through here. On a kernel that cannot confine signals the launcher runs the command
 * unconfined and says so in the cell's log.
 */
export function buildSignalCellCommand(
  command: string,
  args: readonly string[],
  input: SignalCellInput,
): { command: string; args: string[] } {
  const cell = input.cell;
  if (!cell || !signalCellsAvailable(input)) return { command, args: [...args] };
  const launcher = input.launcher ?? signalCellLauncherPath();
  // The ID comes first: a supervisor reads it off another's command line to tell whether they share a cell.
  return { command: launcher, args: ['--cell', cell.id, ...(cell.log ? ['--log', cell.log] : []), '--', command, ...args] };
}
