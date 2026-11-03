import { spawn } from 'node:child_process';
import type { WorkflowProcesses } from './ports';

export interface CommandResult { code: number; stdout: string; stderr: string }

export const nodeProcesses: WorkflowProcesses = { spawn: (command, args, options) => spawn(command, [...args], options), killTree: child => { child.kill('SIGKILL'); } };

/** Foreground, bounded commands. Keep the promise pending until process stdio closes. */
export function workspaceCommand(command: string, args: string[], cwd: string, signal: AbortSignal,
  timeoutMs = 60_000, env = process.env, processes = nodeProcesses): Promise<CommandResult> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = processes.spawn(command, args, { cwd, env, shell: false, windowsHide: true,
      detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', bytes = 0, failure: Error | undefined;
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
      bytes += chunk.length;
      if (bytes > 2_000_000) { stop(new Error('Workspace command output limit reached')); return; }
      if (error) stderr += chunk.toString(); else stdout += chunk.toString();
    };
    child.stdout?.on('data', chunk => collect(chunk, false));
    child.stderr?.on('data', chunk => collect(chunk, true));
    child.once('error', error => { failure = error; });
    child.once('close', code => {
      clearTimeout(timer); signal.removeEventListener('abort', abort);
      if (failure) reject(failure); else resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}
