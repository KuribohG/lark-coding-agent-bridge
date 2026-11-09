import { preparedRun, snapshotRunOptions } from '../prepared-run';
import type { PreparedAgentRun } from '../types';
import { terminateChild } from '../../platform/terminate';
import { ULTRA_EFFORT, parseEffort } from '../model-settings';
import { validateModelId } from '../models';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { log } from '../../core/logger';
import { mergeProcessEnv, type SpawnedProcessByStdio } from '../../platform/spawn';
import { resolveSystemPrompt, type AgentSystemPrompt } from '../system-prompt';
import { checkAgentAvailability, type AgentAvailability } from '../preflight';
import {
  CLAUDE_DEFAULT_PERMISSION_MODE,
  type AgentAdapter,
  type AgentBotIdentity,
  type AgentEvent,
  type AgentQuestionAnswer,
  type NativeAgentRun,
  type AgentRunOptions,
} from '../types';
import { ClaudeRunTranslator, isTaskNotificationResult } from './stream-json';
import { ClaudeStreamInput } from './stream-input';
import { ClaudeQuestionControl } from './questions';
import { ClaudeBackgroundTasks } from './background-tasks';
import { hostedProcessOf, readRunHostInput, spawnAgentProcess } from '../run-host';
import { withExecutionContract } from '../execution';
import { CLAUDE_EXECUTION_CAPABILITIES } from './capabilities';

export interface ClaudeAdapterOptions {
  binary?: string;
  configDir?: string;
  /** Extra `--mcp-config` file; see ClaudeConfig.mcpConfig. */
  mcpConfig?: string;
  /** Pins auto-memory to one directory regardless of the run's cwd. */
  autoMemoryDirectory?: string;
  systemPrompt?: AgentSystemPrompt;
  env?: NodeJS.ProcessEnv;
  /** How long a run may wait for background tasks after its turn ends. */
  backgroundWaitMs?: number;
  /** How long stdin stays open after the tasks drain without starting a notification turn. */
  backgroundDrainGraceMs?: number;
}

type ClaudeChild = SpawnedProcessByStdio<Writable, Readable, Readable>;

export class ClaudeAdapter implements AgentAdapter {
  readonly id = 'claude';
  readonly displayName = 'Claude Code';
  readonly capabilities = CLAUDE_EXECUTION_CAPABILITIES;

  private readonly binary: string;
  private readonly configDir: string | undefined;
  private readonly mcpConfig: string | undefined;
  private readonly autoMemoryDirectory: string | undefined;
  private readonly systemPrompt: AgentSystemPrompt | undefined;
  private readonly env: NodeJS.ProcessEnv;
  private readonly backgroundWaitMs: number;
  private readonly backgroundDrainGraceMs: number;
  private botIdentity: AgentBotIdentity | undefined;

  constructor(opts: ClaudeAdapterOptions = {}) {
    this.binary = opts.binary ?? 'claude';
    this.configDir = opts.configDir;
    this.mcpConfig = opts.mcpConfig;
    this.autoMemoryDirectory = opts.autoMemoryDirectory;
    this.systemPrompt = opts.systemPrompt;
    this.env = { ...opts.env };
    this.backgroundWaitMs = opts.backgroundWaitMs ?? DEFAULT_BACKGROUND_WAIT_MS;
    this.backgroundDrainGraceMs = opts.backgroundDrainGraceMs ?? DEFAULT_BACKGROUND_DRAIN_GRACE_MS;
  }

  setBotIdentity(identity: AgentBotIdentity): void {
    this.botIdentity = identity;
  }

  async isAvailable(): Promise<boolean> {
    return (await this.checkAvailability()).ok;
  }

  async checkAvailability(): Promise<AgentAvailability> {
    return checkAgentAvailability({
      agentId: 'claude',
      agentName: 'Claude Code',
      command: this.binary,
      binaryPath: this.binary,
      env: this.env,
    });
  }

  async prepareRun(input: AgentRunOptions): Promise<PreparedAgentRun> {
    const opts = snapshotRunOptions({ ...input, systemPrompt: input.systemPrompt ?? resolveSystemPrompt(this.systemPrompt, this.botIdentity) });
    if (!opts.cwd) throw new Error('cwd is required for claude preparation');
    if (opts.forkSession && !opts.sessionId) throw new Error('fork requires a parent session');
    if (opts.model) validateModelId(opts.model);
    if (opts.reasoningEffort && opts.reasoningEffort !== ULTRA_EFFORT) parseEffort(opts.reasoningEffort, 'claude');
    return preparedRun({ model: opts.model, reasoningEffort: opts.reasoningEffort },
      () => withExecutionContract(this.runNative(opts), this.capabilities));
  }

  private runNative(opts: AgentRunOptions): NativeAgentRun {
    if (opts.forkSession && !opts.sessionId) throw new Error('fork requires a parent session');
    if (!opts.cwd) {
      throw new Error('cwd is required for ClaudeAdapter.run');
    }

    // The prompt and bridge system prompt must NOT go through argv. On Windows,
    // `claude` resolves to a `claude.cmd` shim and cross-spawn routes it through
    // `cmd.exe /d /s /c`, which interprets `<` and `>` as redirection operators
    // — that silently eats the prompt's `<bridge_context>` XML, so claude runs
    // with an empty request and replies with its default greeting instead of a
    // stream-json response. Pass the prompt via stdin and the appended system
    // prompt via a temp file (the same approach the Codex adapter uses) so no
    // special characters ever reach the shell.
    const ultra = opts.reasoningEffort === ULTRA_EFFORT;
    const settings = {
      ...(ultra ? ULTRACODE_SETTINGS : {}),
      ...(this.autoMemoryDirectory ? { autoMemoryDirectory: this.autoMemoryDirectory } : {}),
    };
    const runFiles = writeRunFiles(opts.systemPrompt ?? resolveSystemPrompt(this.systemPrompt, this.botIdentity),
      Object.keys(settings).length > 0 ? settings : undefined);

    const args = [
      '-p',
      '--output-format',
      'stream-json',
      '--input-format',
      'stream-json',
      '--replay-user-messages',
      '--verbose',
      '--permission-mode',
      opts.permissionMode ?? CLAUDE_DEFAULT_PERMISSION_MODE,
      '--append-system-prompt-file',
      runFiles.systemPromptPath,
    ];
    if (opts.sessionId) args.push('--resume', opts.sessionId);
    if (opts.forkSession) args.push('--fork-session');
    if (opts.model) args.push('--model', validateModelId(opts.model));
    if (this.mcpConfig) args.push('--mcp-config', this.mcpConfig);
    // ultra maps to the ultracode session setting, which also pins effort to xhigh; it has no --effort value.
    if (runFiles.settingsPath) args.push('--settings', runFiles.settingsPath);
    if (opts.reasoningEffort && !ultra) args.push('--effort', parseEffort(opts.reasoningEffort, 'claude')!);
    if (opts.deadlineAt !== undefined) args.push('--disallowedTools', DEADLINE_DISALLOWED_TOOLS.join(','));
    // Without a prompt tool, -p mode removes AskUserQuestion; stdio routes it to the host.
    if (opts.userQuestions) args.push('--permission-prompt-tool', 'stdio');

    const child = spawnAgentProcess(this.binary, args, {
      cwd: opts.cwd,
      env: mergeProcessEnv(process.env, {
        ...PARENT_SESSION_ENV,
        ...BACKGROUND_TASKS_ENV,
        ...this.env,
        ...opts.env,
        ...(this.configDir ? { CLAUDE_CONFIG_DIR: this.configDir } : {}),
      }),
      stdio: ['pipe', 'pipe', 'pipe'],
    }, { agent: this.id, deadlineAt: opts.deadlineAt, host: opts.host }) as ClaudeChild;
    const hosted = hostedProcessOf(child);

    log.info('agent', opts.host?.attach ? 'attach' : 'spawn', {
      pid: child.pid ?? null,
      cwd: opts.cwd ?? process.cwd(),
      hasSession: Boolean(opts.sessionId),
      promptChars: opts.prompt.length,
      model: opts.model,
      reasoningEffort: opts.reasoningEffort,
      ...(opts.host ? { runHost: opts.host.key } : {}),
    });

    // Listeners MUST be attached synchronously here, before we return.
    // The 'error' and exit-related events can fire in the next tick; if we
    // defer attachment to the async-generator body, those events fire into
    // the void and the generator hangs.
    const stderrChunks: Buffer[] = [];
    const tasks = new ClaudeBackgroundTasks();
    const input = new ClaudeStreamInput(child.stdin, opts.sessionId, undefined, () => tasks.running > 0);
    const questions = new ClaudeQuestionControl(input);
    let runtimeError: Error | null = null;
    let interrupted = false;
    let stderrBuffer = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
      stderrBuffer += chunk.toString('utf8');
      let nl = stderrBuffer.indexOf('\n');
      while (nl !== -1) {
        const line = stderrBuffer.slice(0, nl);
        stderrBuffer = stderrBuffer.slice(nl + 1);
        if (line.trim()) log.warn('agent', 'stderr', { line });
        if (isWindowsCommandNotFoundLine(line)) {
          runtimeError = new Error(`failed to spawn claude: ${line.trim()}`);
          child.stdout.destroy();
          terminateChild(child);
        }
        nl = stderrBuffer.indexOf('\n');
      }
    });

    child.on('error', (err) => {
      runtimeError = err;
      input.close();
      runFiles.cleanup();
    });
    child.on('exit', (code, signal) => {
      input.close();
      questions.close();
      log.info('agent', 'exit', { pid: child.pid ?? null, code, signal });
      // A detached agent is still running and may read its settings again.
      if (!hosted?.detached) runFiles.cleanup();
    });
    child.stdin.on('error', (err) => {
      log.warn('agent', 'stdin-error', { message: err.message });
      input.close();
    });
    if (opts.host?.attach) {
      // The previous bridge process already sent the prompt and answered some requests.
      const written = readRunHostInput(opts.host.key);
      input.restore(written);
      questions.restore(written);
    } else {
      input.start(opts.prompt);
    }

    // Default 5s if caller didn't specify — claude often has live
    // subprocesses (lark-cli waiting for OAuth, long Bash, etc.) and the
    // old 500ms was nowhere near enough for them to flush state before the
    // SIGKILL cascade. Callers (channel.ts, /doctor) override per-run with
    // a value derived from preferences.
    const stopGraceMs = opts.deadlineAt ? Math.max(1000, opts.stopGraceMs ?? 1000) : opts.stopGraceMs ?? 5000;

    return {
      runId: opts.runId,
      ...(hosted ? { detachOnShutdown: true } : {}),
      events: createEventStream(child, stderrChunks, () => runtimeError, input, questions, tasks, this.backgroundWaitMs,
        this.backgroundDrainGraceMs, () => interrupted, opts.deadlineAt, opts.answerIncludesInterimText),
      async sendInput({ text, messageId }) {
        return await input.steer(text, messageId) === 'accepted'
          ? { status: 'accepted', messageId, scope: 'active-session' }
          : { status: 'inactive', messageId };
      },
      ...(opts.userQuestions ? { answerUserInput: (id: string, answer: AgentQuestionAnswer) => questions.answer(id, answer) } : {}),
      async stop(reason) {
        interrupted = true;
        if (hosted && reason === 'shutdown') {
          // Detach before closing input so the agent's stdin stays open for the next bridge.
          hosted.detach();
          input.close();
          return;
        }
        // Let Claude end the turn itself so its transcript records an interruption, not a killed tool.
        // Signalling while it still stops a tool would orphan that tool, which runs in its own group.
        const settleMs = Math.min(stopGraceMs, INTERRUPT_SETTLE_MS);
        const turnInterrupted = input.interrupt() && await turnEnded(child, settleMs);
        input.close();
        // After an interrupted turn Claude exits on EOF, having stopped its tools, tasks and MCP servers.
        if (turnInterrupted ? await exitWithin(child, settleMs) : child.exitCode !== null || child.signalCode !== null) return;
        log.info('agent', 'stop-sigterm', { pid: child.pid ?? null, graceMs: stopGraceMs, turnInterrupted });
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
        return exitWithin(child, timeoutMs);
      },
    };
  }
}

async function* createEventStream(
  child: ClaudeChild,
  stderrChunks: Buffer[],
  getError: () => Error | null,
  input: ClaudeStreamInput,
  questions: ClaudeQuestionControl,
  tasks: ClaudeBackgroundTasks,
  backgroundWaitMs: number,
  backgroundDrainGraceMs: number,
  isInterrupted: () => boolean,
  deadlineAt?: number,
  answerIncludesInterimText?: boolean,
): AsyncGenerator<AgentEvent> {
  // If fork itself failed synchronously, child.pid is undefined. The 'error'
  // event (ENOENT etc.) fires in the next tick, so also check getError().
  if (!child.pid) {
    const err = getError();
    yield {
      type: 'error',
      message: err ? `failed to spawn claude: ${err.message}` : 'spawn returned no pid',
      terminationReason: 'failed',
    };
    return;
  }

  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  let sawStdout = false;
  const translator = new ClaudeRunTranslator(answerIncludesInterimText);
  let silentExitTimer: ReturnType<typeof setTimeout> | undefined;
  const closeSilentStdout = (): void => {
    silentExitTimer = setTimeout(() => {
      if (!sawStdout && !child.stdout.readableEnded) child.stdout.destroy();
    }, 50);
  };
  child.once('exit', closeSilentStdout);
  // The latest turn result that arrived while background tasks were still running.
  let held: { type?: string; is_error?: boolean; subtype?: string } | undefined;
  let waitTimer: ReturnType<typeof setTimeout> | undefined;
  let waitExpired = false;
  // Between a top-level init and its result; such a turn's result decides whether the run ends.
  let turnOpen = false;
  let drainTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    for await (const line of rl) {
      sawStdout = true;
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      const control = questions.receive(parsed);
      if (control) {
        yield* control;
        continue;
      }
      tasks.receive(parsed);
      const event = parsed as { type?: string; subtype?: string; parent_tool_use_id?: string } | null;
      if (event && typeof event === 'object' && !event.parent_tool_use_id) {
        if (event.type === 'system' && event.subtype === 'init') turnOpen = true;
        else if (event.type === 'result') turnOpen = false;
      }
      // -p starts a notification turn for each finished task with stdin still open, and that turn
      // may launch more tasks, so stdin stays open for supplements. Close it only when the tasks
      // drain and no turn follows, so -p exits and the held result answers.
      if (held && tasks.running === 0 && !turnOpen) {
        drainTimer ??= setTimeout(() => {
          drainTimer = undefined;
          if (tasks.running === 0 && !turnOpen && !input.awaitingResult) input.close();
        }, backgroundDrainGraceMs);
      } else if (drainTimer) {
        clearTimeout(drainTimer);
        drainTimer = undefined;
      }
      if (isTaskNotificationResult(parsed) && !tasks.launchedHere(parsed)) continue;
      parsed = input.receive(parsed);
      if (parsed === undefined) continue;
      let terminal = false;
      if (parsed && typeof parsed === 'object') {
        const result = parsed as { type?: string; parent_tool_use_id?: string; is_error?: boolean; subtype?: string };
        terminal = result.type === 'result' && !result.parent_tool_use_id;
        if (terminal && tasks.running > 0 && !result.is_error && !result.subtype?.startsWith('error')) {
          held = result;
          yield* translator.flushProgress();
          yield { type: 'status', code: 'background_tasks', content: tasks.describe() };
          waitTimer ??= setTimeout(() => {
            waitExpired = true;
            log.warn('agent', 'background-wait-expired', { pid: child.pid ?? null, waitMs: backgroundWaitMs });
            terminateChild(child, 'SIGTERM');
          }, backgroundWaitMs);
          continue;
        }
      }
      // An interrupted turn ends in an error result; the run reports the interruption instead.
      if (terminal && isInterrupted()) break;
      yield* translator.translate(parsed);
      if (terminal) return;
    }
  } finally {
    input.close();
    if (waitTimer) clearTimeout(waitTimer);
    if (drainTimer) clearTimeout(drainTimer);
    if (silentExitTimer) clearTimeout(silentExitTimer);
    child.removeListener('exit', closeSilentStdout);
    rl.close();
  }
  yield* translator.flushProgress();

  const earlyRuntimeError = getError();
  if (earlyRuntimeError && child.exitCode === null && child.signalCode === null) {
    yield {
      type: 'error',
      message: input.errorMessage(`claude runtime error: ${earlyRuntimeError.message}`),
      terminationReason: 'failed',
    };
    return;
  }

  // When the child is killed by a signal, exitCode stays null and signalCode
  // carries the name. Both must be checked or we'll attach an 'exit' listener
  // for an event that already fired and hang forever.
  const exitCode = await new Promise<number | null>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve(child.exitCode);
    } else {
      child.once('exit', (code) => resolve(code));
    }
  });

  const runtimeError = getError();
  if (deadlineAt !== undefined && exitCode === 124) {
    yield { type: 'done', terminationReason: 'timeout' };
  } else if (held && !isInterrupted() && (exitCode === 0 || waitExpired)) {
    if (waitExpired) {
      const hours = Math.round(backgroundWaitMs / 360_000) / 10;
      yield { type: 'status', code: 'background_tasks_expired', content: `⚠️ 后台任务 ${hours} 小时内未全部完成，已停止等待并结束这些任务。` };
    }
    yield* translator.finishHeld(held);
  } else if (isInterrupted() || child.signalCode === 'SIGTERM' || child.signalCode === 'SIGINT' || exitCode === 130) {
    yield { type: 'done', terminationReason: 'interrupted' };
  } else if (exitCode !== 0 && exitCode !== null) {
    const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
    const detail = stderr ? `: ${stderr.slice(0, 500)}` : '';
    yield {
      type: 'error',
      message: input.errorMessage(`claude exited with code ${exitCode}${detail}`),
      terminationReason: 'failed',
    };
  } else if (runtimeError) {
    yield {
      type: 'error',
      message: input.errorMessage(`claude runtime error: ${runtimeError.message}`),
      terminationReason: 'failed',
    };
  } else {
    yield { type: 'error', message: input.errorMessage('claude exited without a final result'), terminationReason: 'failed' };
  }
}

function exitWithin(child: ClaudeChild, timeoutMs: number): Promise<boolean> {
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
}

/** True once the child prints a top-level result; false if it exits or the timeout passes first. */
function turnEnded(child: ClaudeChild, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let pending = '';
    const finish = (ended = false): void => {
      clearTimeout(timer);
      child.stdout.removeListener('data', onData);
      child.removeListener('exit', onExit);
      resolve(ended);
    };
    const onExit = (): void => finish();
    const onData = (chunk: Buffer | string): void => {
      pending += chunk.toString();
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        try {
          const event = JSON.parse(line) as { type?: string; parent_tool_use_id?: string | null };
          if (event?.type === 'result' && !event.parent_tool_use_id) return finish(true);
        } catch { /* not a protocol line */ }
      }
    };
    const timer = setTimeout(() => finish(), timeoutMs);
    child.stdout.on('data', onData);
    child.once('exit', onExit);
    if (child.exitCode !== null || child.signalCode !== null) finish();
  });
}

const ULTRACODE_SETTINGS = { ultracode: true, workflowSizeGuideline: 'large' };
// Claude Code answers an interrupt and exits within a second; past this the signal path takes over.
const INTERRUPT_SETTLE_MS = 3_000;
// Session scheduling tools could fire after the watchdog's deadline.
const DEADLINE_DISALLOWED_TOOLS = ['CronCreate', 'CronDelete', 'CronList', 'ScheduleWakeup'];

// A run owns its process, and it now lasts until the background tasks it
// launched have finished and Claude has answered their notifications, so the
// model can wait on a task instead of sleeping in a foreground shell. Set
// explicitly so an inherited `1` cannot hide `run_in_background`; profile and
// per-run env still win, and `1` there restores foreground-only runs.
const BACKGROUND_TASKS_ENV = { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '0' };

// A bridge started from a Claude Code shell inherits that session's markers.
// Left in place, every run counts as its child session and registers with its
// messaging socket. Unset them; profile and per-run env can still set any.
const PARENT_SESSION_ENV: NodeJS.ProcessEnv = Object.fromEntries([
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
].map((key) => [key, undefined]));
const DEFAULT_BACKGROUND_WAIT_MS = 6 * 60 * 60 * 1000;
// Notification turns start within milliseconds of the drain; this only catches tasks that end without one.
const DEFAULT_BACKGROUND_DRAIN_GRACE_MS = 5_000;

/**
 * Persist the appended system prompt (and optional flag settings) to throwaway
 * temp files so neither goes through argv. Returns the paths plus an
 * idempotent, best-effort cleanup that removes the temp directory.
 */
function writeRunFiles(systemPrompt: string, settings?: object): {
  systemPromptPath: string;
  settingsPath?: string;
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), 'lark-claude-'));
  const systemPromptPath = join(dir, 'append-system-prompt.md');
  writeFileSync(systemPromptPath, systemPrompt, 'utf8');
  const settingsPath = settings ? join(dir, 'settings.json') : undefined;
  if (settingsPath) writeFileSync(settingsPath, JSON.stringify(settings), 'utf8');
  return {
    systemPromptPath,
    ...(settingsPath ? { settingsPath } : {}),
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort: the OS will reclaim the temp dir eventually
      }
    },
  };
}

function isWindowsCommandNotFoundLine(line: string): boolean {
  return (
    process.platform === 'win32' &&
    /is not recognized as an internal or external command|operable program or batch file/i.test(line)
  );
}
