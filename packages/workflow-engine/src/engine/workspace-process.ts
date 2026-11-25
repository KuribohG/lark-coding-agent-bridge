import { spawn } from 'node:child_process';
import type { WorkflowProcesses } from './ports';

export interface CommandResult { code: number; stdout: string; stderr: string }

/**
 * What is held of a command's output. It is held in this process's memory, next to the output of every other command
 * of every workflow, so it is bounded whatever the command prints. By default the whole output is the result, and a
 * command that prints more than OUTPUT_LIMIT fails: a caller that reads a list out of the output must not be handed
 * part of the list. A caller that reads only one end of it says so with `keep`, and one that can take stdout as it
 * arrives passes `scan`; either way the command prints as much as it likes.
 */
export interface CommandOutput {
  /** Names the command when it is refused for printing too much. */
  name?: string;
  /** Holds only the first or the last `bytes` of each stream. */
  keep?: 'head' | 'tail';
  bytes?: number;
  /** Takes stdout chunk by chunk; none of it is held. It may throw, which stops the command with that error. */
  scan?(chunk: Buffer): void;
}
const OUTPUT_LIMIT = 2_000_000;
const KEPT_BYTES = 65_536;

/** Calls `each` with the records of a stream as its chunks arrive; every record ends with the separator. */
export function records(each: (record: string) => void, separator = '\0'): (chunk: Buffer) => void {
  let rest: Buffer | undefined;
  return chunk => {
    const data = rest ? Buffer.concat([rest, chunk]) : chunk;
    let start = 0;
    for (let end = data.indexOf(separator, start); end >= 0; end = data.indexOf(separator, start)) {
      each(data.toString('utf8', start, end)); start = end + 1;
    }
    rest = start < data.length ? data.subarray(start) : undefined;
    // A path or a status line is far shorter; anything else is not the list the caller asked for.
    if (rest && rest.length > OUTPUT_LIMIT) throw new Error('Workspace command printed a record without an end');
  };
}

function holder(keep: 'head' | 'tail' | undefined, bytes: number) {
  const chunks: Buffer[] = [];
  let held = 0;
  return {
    add(chunk: Buffer) {
      if (keep === 'head') chunk = chunk.subarray(0, bytes - held);
      if (!chunk.length) return;
      chunks.push(chunk); held += chunk.length;
      while (keep === 'tail' && held - chunks[0]!.length >= bytes) held -= chunks.shift()!.length;
    },
    text() {
      const all = Buffer.concat(chunks);
      return (keep === 'tail' ? all.subarray(Math.max(0, all.length - bytes)) : all).toString();
    },
  };
}

export const nodeProcesses: WorkflowProcesses = { spawn: (command, args, options) => spawn(command, [...args], options), killTree: child => { child.kill('SIGKILL'); } };

/** Foreground, bounded commands. Keep the promise pending until process stdio closes. */
export function workspaceCommand(command: string, args: string[], cwd: string, signal: AbortSignal,
  timeoutMs = 60_000, env = process.env, processes = nodeProcesses, output: CommandOutput = {}): Promise<CommandResult> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = processes.spawn(command, args, { cwd, env, shell: false, windowsHide: true,
      detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    // What a scanned command writes to stderr is only ever read as the reason it failed.
    const keep = output.keep ?? (output.scan ? 'tail' : undefined), room = output.bytes ?? KEPT_BYTES;
    const stdout = holder(keep, room), stderr = holder(keep, room);
    let bytes = 0, failure: Error | undefined;
    const stop = (reason: Error) => {
      failure ??= reason;
      if (process.platform !== 'win32' && child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      } else processes.killTree(child);
    };
    const abort = () => stop(new Error('Workspace command aborted'));
    const timer = setTimeout(() => stop(new Error('Workspace command timed out')), timeoutMs);
    timer.unref(); signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    const collect = (chunk: Buffer, error: boolean) => {
      if (failure) return;
      if (output.scan && !error) {
        try { output.scan(chunk); } catch (thrown) { stop(thrown instanceof Error ? thrown : new Error(String(thrown))); }
        return;
      }
      if (!keep && (bytes += chunk.length) > OUTPUT_LIMIT) {
        stop(new Error(`Workspace command output limit reached: ${output.name ?? command} printed more than ${OUTPUT_LIMIT / 1e6} MB`));
        return;
      }
      (error ? stderr : stdout).add(chunk);
    };
    child.stdout?.on('data', chunk => collect(chunk, false));
    child.stderr?.on('data', chunk => collect(chunk, true));
    child.once('error', error => { failure = error; });
    child.once('close', code => {
      clearTimeout(timer); signal.removeEventListener('abort', abort);
      if (failure) reject(failure); else resolve({ code: code ?? -1, stdout: stdout.text(), stderr: stderr.text() });
    });
  });
}
