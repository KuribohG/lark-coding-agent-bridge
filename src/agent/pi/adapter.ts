import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { log } from '../../core/logger';
import { SpawnFailed } from '../../runtime/errors';
import { terminateChild } from '../../platform/terminate';
import { mergeProcessEnv, type SpawnedProcessByStdio } from '../../platform/spawn';
import { checkAgentAvailability, type AgentAvailability } from '../preflight';
import { spawnWithDeadline } from '../deadline';
import { parseEffort } from '../model-settings';
import { validateModelId } from '../models';
import type { ResolvedModelProvider } from '../../model-provider/provider';
import { resolveSystemPrompt, type AgentSystemPrompt } from '../system-prompt';
import type {
  AgentAdapter,
  AgentBotIdentity,
  AgentEvent,
  AgentRun,
  AgentRunOptions,
} from '../types';
import { withExecutionContract } from '../execution';
import { PI_EXECUTION_CAPABILITIES } from './capabilities';
import { readPiJsonLines } from './jsonl';
import { PiRunTranslator } from './jsonl-translator';

export interface PiAdapterOptions {
  binary?: string;
  systemPrompt?: AgentSystemPrompt;
  env?: NodeJS.ProcessEnv;
  stopGraceMs?: number;
  profileStateDir?: string;
}

type PiChild = SpawnedProcessByStdio<Writable, Readable, Readable>;

export class PiAdapter implements AgentAdapter {
  readonly id = 'pi';
  readonly displayName = 'Pi Coding Agent';
  readonly capabilities = PI_EXECUTION_CAPABILITIES;

  private readonly binary: string;
  private readonly systemPrompt: AgentSystemPrompt | undefined;
  private readonly env: NodeJS.ProcessEnv;
  private readonly defaultStopGraceMs: number;
  private readonly profileStateDir: string;
  private botIdentity: AgentBotIdentity | undefined;

  constructor(opts: PiAdapterOptions = {}) {
    this.binary = opts.binary ?? 'pi';
    this.systemPrompt = opts.systemPrompt;
    this.env = { ...opts.env };
    this.defaultStopGraceMs = opts.stopGraceMs ?? 5000;
    this.profileStateDir = opts.profileStateDir ?? join(tmpdir(), 'lark-channel-pi-providers');
  }

  setBotIdentity(identity: AgentBotIdentity): void {
    this.botIdentity = identity;
  }

  async isAvailable(): Promise<boolean> {
    return (await this.checkAvailability()).ok;
  }

  async checkAvailability(): Promise<AgentAvailability> {
    return checkAgentAvailability({
      agentId: 'pi',
      agentName: this.displayName,
      command: this.binary,
      binaryPath: this.binary,
    });
  }

  async prepareRun(opts: AgentRunOptions): Promise<void> {
    if (opts.sandbox === 'workspace-write') {
      throw new SpawnFailed(
        'pi workspace sandbox unavailable',
        new Error('Pi has no portable workspace sandbox; use read-only or full access'),
        'agent-prepare-failed',
      );
    }
    const availability = await this.checkAvailability();
    if (!availability.ok) {
      throw new SpawnFailed(
        'pi binary check failed',
        availability.error,
        availability.diagnostic.code,
        availability.diagnostic,
      );
    }
  }

  run(opts: AgentRunOptions): AgentRun {
    return withExecutionContract(this.runNative(opts), this.capabilities);
  }

  private runNative(opts: AgentRunOptions): AgentRun {
    if (!opts.cwd) throw new Error('cwd is required for PiAdapter.run');
    if (opts.forkSession && !opts.sessionId) throw new Error('fork requires a parent session');
    const sandbox = opts.sandbox ?? 'danger-full-access';
    if (sandbox === 'workspace-write') {
      throw new Error('Pi has no portable workspace sandbox; use read-only or full access');
    }

    const runFiles = writeSystemPrompt(
      opts.systemPrompt ?? resolveSystemPrompt(this.systemPrompt, this.botIdentity),
    );
    const args = ['--mode', 'json', '--append-system-prompt', runFiles.systemPromptPath];
    if (opts.forkSession) args.push('--fork', opts.sessionId!);
    else if (opts.sessionId) args.push('--session', opts.sessionId);
    if (opts.model) args.push('--model', validateModelId(opts.model));
    if (opts.reasoningEffort) {
      args.push('--thinking', piThinkingLevel(parseEffort(opts.reasoningEffort, 'pi')!));
    }
    if (opts.modelProvider?.pi) {
      args.push('--extension', writePiProviderExtension(this.profileStateDir, opts.modelProvider));
    }
    if (sandbox === 'read-only') {
      args.push('--no-extensions', '--tools', 'read,grep,find,ls');
    } else if (opts.deadlineAt !== undefined) {
      // No built-in scheduling exists, but extensions can add arbitrary tools
      // that outlive the bridge deadline.
      args.push('--no-extensions');
    }

    const child = spawnWithDeadline(this.binary, args, {
      cwd: opts.cwd,
      env: mergeProcessEnv(process.env, {
        ...this.env,
        ...opts.modelProvider?.env,
        PI_SKIP_VERSION_CHECK: '1',
        PI_TELEMETRY: '0',
      }),
      stdio: ['pipe', 'pipe', 'pipe'],
    }, opts.deadlineAt) as PiChild;

    log.info('agent', 'spawn', {
      pid: child.pid ?? null,
      cwd: opts.cwd,
      hasSession: Boolean(opts.sessionId),
      promptChars: opts.prompt.length,
      model: opts.model,
      modelProvider: opts.modelProvider?.id,
      reasoningEffort: opts.reasoningEffort,
      access: sandbox,
    });

    const stderrChunks: Buffer[] = [];
    let runtimeError: Error | undefined;
    let interrupted = false;
    let stderrBuffer = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
      if (stderrChunks.length > 32) stderrChunks.shift();
      stderrBuffer += chunk.toString('utf8');
      let newline = stderrBuffer.indexOf('\n');
      while (newline !== -1) {
        const line = stderrBuffer.slice(0, newline);
        stderrBuffer = stderrBuffer.slice(newline + 1);
        if (line.trim()) log.warn('agent', 'stderr', { line });
        if (isWindowsCommandNotFoundLine(line)) {
          runtimeError = new Error(`failed to spawn pi: ${line.trim()}`);
          child.stdout.destroy();
          terminateChild(child);
        }
        newline = stderrBuffer.indexOf('\n');
      }
    });
    child.on('error', (error) => {
      runtimeError = error;
      runFiles.cleanup();
    });
    child.on('exit', (code, signal) => {
      log.info('agent', 'exit', { pid: child.pid ?? null, code, signal });
      runFiles.cleanup();
    });
    child.stdin.on('error', (error) => {
      log.warn('agent', 'stdin-error', { message: error.message });
    });
    child.stdin.end(opts.prompt, 'utf8');

    const stopGraceMs = opts.deadlineAt
      ? Math.max(1000, opts.stopGraceMs ?? 1000)
      : opts.stopGraceMs ?? this.defaultStopGraceMs;

    return {
      runId: opts.runId,
      events: createEventStream(child, stderrChunks, {
        getError: () => runtimeError,
        isInterrupted: () => interrupted,
        deadlineAt: opts.deadlineAt,
      }),
      async stop() {
        interrupted = true;
        if (child.exitCode !== null || child.signalCode !== null) return;
        log.info('agent', 'stop-sigterm', { pid: child.pid ?? null, graceMs: stopGraceMs });
        terminateChild(child, 'SIGTERM');
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) {
              log.warn('agent', 'stop-sigkill', {
                pid: child.pid ?? null,
                graceMs: stopGraceMs,
                reason: 'grace-period-expired',
              });
              terminateChild(child, 'SIGKILL');
            }
            resolve();
          }, stopGraceMs);
          child.once('exit', () => {
            clearTimeout(timer);
            resolve();
          });
        });
      },
      waitForExit(timeoutMs: number): Promise<boolean> {
        if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
        return new Promise<boolean>((resolve) => {
          const onExit = (): void => {
            clearTimeout(timer);
            resolve(true);
          };
          const timer = setTimeout(() => {
            child.removeListener('exit', onExit);
            resolve(false);
          }, timeoutMs);
          child.once('exit', onExit);
        });
      },
    };
  }
}

function writePiProviderExtension(
  stateDir: string,
  provider: ResolvedModelProvider,
): string {
  const registration = provider.pi!;
  const config = {
    name: registration.name,
    baseUrl: registration.baseUrl,
    api: registration.api,
    apiKey: `$${registration.apiKeyEnv}`,
    authHeader: true,
    ...(registration.headers
      ? { headers: Object.fromEntries(Object.entries(registration.headers).map(([name, env]) => [name, `$${env}`])) }
      : {}),
    models: [registration.model],
  };
  const text = `export default function register(pi) {\n  pi.registerProvider(${JSON.stringify(registration.providerId)}, ${JSON.stringify(config, null, 2)});\n}\n`;
  const hash = createHash('sha256').update(text).digest('hex').slice(0, 16);
  const dir = join(stateDir, 'pi-model-providers');
  const file = join(dir, `${hash}.js`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(file, text, { encoding: 'utf8', mode: 0o600 });
  return file;
}

async function* createEventStream(
  child: PiChild,
  stderrChunks: Buffer[],
  state: {
    getError(): Error | undefined;
    isInterrupted(): boolean;
    deadlineAt?: number;
  },
): AsyncGenerator<AgentEvent> {
  if (!child.pid) {
    const error = state.getError();
    yield {
      type: 'error',
      message: error ? `failed to spawn pi: ${error.message}` : 'spawn returned no pid',
      terminationReason: 'failed',
    };
    return;
  }

  const translator = new PiRunTranslator();
  try {
    for await (const line of readPiJsonLines(child.stdout.iterator({ destroyOnReturn: false }))) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      const events = translator.translate(parsed);
      for (const event of events) yield event;
      if (translator.terminalEmitted()) return;
    }
  } finally {
    // Pi can still flush output after a terminal event or consumer return.
    child.stdout.resume();
  }

  const exitCode = await new Promise<number | null>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve(child.exitCode);
    else child.once('exit', (code) => resolve(code));
  });
  const events = translator.finish({
    exitCode,
    stderr: Buffer.concat(stderrChunks).toString('utf8').trim(),
    ...(state.getError() ? { runtimeError: state.getError() } : {}),
    interrupted: state.isInterrupted() || child.signalCode === 'SIGTERM' || child.signalCode === 'SIGINT',
    timedOut: state.deadlineAt !== undefined && (
      exitCode === 124 || state.deadlineAt <= Date.now()
    ),
  });
  for (const event of events) yield event;
}

function writeSystemPrompt(systemPrompt: string): {
  systemPromptPath: string;
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), 'lark-pi-'));
  const systemPromptPath = join(dir, 'append-system-prompt.md');
  writeFileSync(systemPromptPath, systemPrompt, 'utf8');
  return {
    systemPromptPath,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup; the OS will eventually reclaim the temp dir.
      }
    },
  };
}

function piThinkingLevel(effort: string): string {
  if (effort === 'max') return 'xhigh';
  if (effort === 'none') return 'off';
  return effort;
}

function isWindowsCommandNotFoundLine(line: string): boolean {
  return process.platform === 'win32' &&
    /is not recognized as an internal or external command|operable program or batch file/i.test(line);
}
