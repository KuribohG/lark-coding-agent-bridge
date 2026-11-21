import type { Readable, Writable } from 'node:stream';
import { log } from '../core/logger';
import { terminateChild } from '../platform/terminate';
import type { ExecSandboxSettings } from '../platform/exec-sandbox';
import type { SpawnedProcessByStdio } from '../platform/spawn';
import { readJsonLines } from './jsonl';
import { hostedProcessOf, spawnAgentProcess, type RunHostBinding } from './run-host';
import type { AgentEvent, NativeAgentRun } from './types';

export interface ProcessStreamFinish {
  exitCode: number | null;
  stderr: string;
  runtimeError?: Error;
  interrupted: boolean;
  timedOut: boolean;
}

export interface ProcessEventTranslator {
  translate(value: unknown): AgentEvent[];
  finish(state: ProcessStreamFinish): AgentEvent[];
  terminalEmitted(): boolean;
  stderr?(line: string): void;
}

/** Process ownership and framing are shared; each backend owns its wire protocol. */
export function startProcessRun(input: {
  agent: string;
  runId: string;
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Bytes written to the process's stdin before it starts working. */
  stdin: string;
  /** Leave stdin open after those bytes, so the caller can write more through `onStdin`. */
  keepStdinOpen?: boolean;
  /** Receives the run's stdin, for an adapter whose agent reads further input while it runs. */
  onStdin?(stdin: Writable): void;
  /** Sees every parsed stdout record before translation, for a transport that answers commands. */
  onRecord?(record: unknown): void;
  translator: ProcessEventTranslator;
  deadlineAt?: number;
  /** Landlock allowlist for this run; the whole process tree inherits it. */
  execSandbox?: ExecSandboxSettings;
  /**
   * Run under a detached run host, or attach to the process already running under it. A reattached run replays the
   * output the previous bridge process did not see; an agent that reads input while it runs also keeps accepting it.
   */
  host?: RunHostBinding;
  stopGraceMs: number;
  stopSignal?: NodeJS.Signals;
  strictJson?: boolean;
  cleanup?(): void;
}): NativeAgentRun {
  type Child = SpawnedProcessByStdio<Writable, Readable, Readable>;
  let child: Child;
  try {
    child = spawnAgentProcess(input.command, input.args, {
      cwd: input.cwd, env: input.env, stdio: ['pipe', 'pipe', 'pipe'],
    }, { agent: input.agent, deadlineAt: input.deadlineAt, host: input.host, execSandbox: input.execSandbox }) as Child;
  } catch (error) {
    input.cleanup?.();
    throw error;
  }
  const hosted = hostedProcessOf(child);
  // The process an earlier bridge started has its input already.
  const attached = Boolean(hosted && input.host?.attach);
  let runtimeError: Error | undefined;
  let interrupted = false;
  let stderr = '';
  let stderrLine = '';
  let closed = false;
  let stop: Promise<void> | undefined;
  let resolveExit!: () => void;
  const exited = new Promise<void>(resolve => { resolveExit = resolve; });
  let cleaned = false;
  const cleanup = () => {
    // A detached agent is still running and may read its files again.
    if (cleaned || hosted?.detached) return;
    cleaned = true;
    input.cleanup?.();
  };
  child.stderr.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString('utf8')).slice(-65_536);
    stderrLine += chunk.toString('utf8');
    for (;;) {
      const newline = stderrLine.indexOf('\n');
      if (newline < 0) break;
      const line = stderrLine.slice(0, newline).trim();
      stderrLine = stderrLine.slice(newline + 1);
      if (line) {
        log.warn('agent', 'stderr', { agent: input.agent, line });
        input.translator.stderr?.(line);
        if (process.platform === 'win32' && /is not recognized as an internal or external command|operable program or batch file/i.test(line)) {
          runtimeError = new Error(`failed to spawn ${input.agent}: ${line}`);
          child.stdout.destroy();
          terminateChild(child);
        }
      }
    }
    stderrLine = stderrLine.slice(-65_536);
  });
  child.once('error', error => { runtimeError = error; cleanup(); });
  child.once('close', (code, signal) => {
    closed = true;
    if (stderrLine.trim()) input.translator.stderr?.(stderrLine.trim());
    cleanup();
    resolveExit();
    log.info('agent', 'exit', { agent: input.agent, pid: child.pid, code, signal });
  });
  child.stdin.on('error', error => {
    if ((error as NodeJS.ErrnoException).code !== 'EPIPE') runtimeError = error;
  });
  input.onStdin?.(child.stdin);
  if (!attached) {
    if (input.stdin) child.stdin.write(input.stdin, 'utf8');
    if (!input.keepStdinOpen) child.stdin.end();
  }
  log.info('agent', attached ? 'attach' : 'spawn', { agent: input.agent, pid: child.pid, cwd: input.cwd,
    ...(hosted ? { runHost: hosted.key } : {}) });

  const finishState = (): ProcessStreamFinish => ({
    exitCode: child.exitCode,
    stderr: stderr.trim(),
    runtimeError,
    interrupted: interrupted || child.signalCode === 'SIGINT' || child.signalCode === 'SIGTERM',
    timedOut: input.deadlineAt !== undefined && child.exitCode === 124,
  });
  async function* events(): AsyncGenerator<AgentEvent> {
    try {
      for await (const line of readJsonLines(child.stdout.iterator({ destroyOnReturn: false }))) {
        if (!line.trim()) continue;
        let value: unknown;
        try { value = JSON.parse(line); }
        catch {
          if (!input.strictJson) continue;
          runtimeError = new Error(`${input.agent} emitted invalid JSON`);
          terminateChild(child, 'SIGKILL');
          break;
        }
        input.onRecord?.(value);
        const translated = input.translator.translate(value);
        if (interrupted || (input.deadlineAt !== undefined && input.deadlineAt <= Date.now())) {
          yield { type: 'done', terminationReason: interrupted ? 'interrupted' : 'timeout' };
          return;
        }
        yield* translated;
        if (input.translator.terminalEmitted()) return;
      }
    } catch (error) {
      runtimeError = error instanceof Error ? error : new Error(String(error));
      terminateChild(child, 'SIGKILL');
    } finally {
      // A native terminal event can precede telemetry and stdout cleanup.
      child.stdout.resume();
    }
    await exited;
    yield* input.translator.finish(finishState());
  }
  return {
    runId: input.runId,
    ...(hosted ? { detachOnShutdown: true } : {}),
    events: events(),
    stop(reason) {
      interrupted = true;
      if (stop) return stop;
      stop = (async () => {
        if (closed) return;
        // The agent keeps running under its host for the next bridge process to reattach.
        if (hosted && reason === 'shutdown') { await hosted.detach(); return; }
        terminateChild(child, input.stopSignal ?? 'SIGTERM');
        const exitedInTime = await waitForExit(input.stopGraceMs);
        if (!exitedInTime) terminateChild(child, 'SIGKILL');
      })();
      return stop;
    },
    waitForExit,
  };

  async function waitForExit(timeoutMs: number): Promise<boolean> {
    if (closed) return true;
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        exited.then(() => true),
        new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); }),
      ]);
    } finally { if (timer) clearTimeout(timer); }
  }
}
