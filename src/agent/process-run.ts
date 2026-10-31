import type { Readable, Writable } from 'node:stream';
import { log } from '../core/logger';
import { terminateChild } from '../platform/terminate';
import type { SpawnedProcessByStdio } from '../platform/spawn';
import { spawnWithDeadline } from './deadline';
import { readJsonLines } from './jsonl';
import type { AgentEvent, AgentRun } from './types';

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
  stdin: string;
  translator: ProcessEventTranslator;
  deadlineAt?: number;
  stopGraceMs: number;
  stopSignal?: NodeJS.Signals;
  strictJson?: boolean;
  cleanup?(): void;
}): AgentRun {
  type Child = SpawnedProcessByStdio<Writable, Readable, Readable>;
  let child: Child;
  try {
    child = spawnWithDeadline(input.command, input.args, {
      cwd: input.cwd, env: input.env, stdio: ['pipe', 'pipe', 'pipe'],
    }, input.deadlineAt) as Child;
  } catch (error) {
    input.cleanup?.();
    throw error;
  }
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
    if (cleaned) return;
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
  child.stdin.end(input.stdin, 'utf8');
  log.info('agent', 'spawn', { agent: input.agent, pid: child.pid, cwd: input.cwd });

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
    events: events(),
    stop() {
      interrupted = true;
      if (stop) return stop;
      stop = (async () => {
        if (closed) return;
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
