import { preparedRun, snapshotRunOptions } from '../prepared-run';
import type { PreparedAgentRun } from '../types';
import { startProcessRun } from '../process-run';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { SpawnFailed } from '../errors';
import { mergeProcessEnv } from '../../platform/spawn';
import { checkAgentAvailability, type AgentAvailability } from '../preflight';
import { readRunHostInput, runHostFilesDir, runHostsSupported, type RunHostBinding } from '../run-host';
import { parseEffort } from '../model-settings';
import { validateModelId } from '../models';
import type { ResolvedModelProvider } from '../../model-provider/types';
import { resolveSystemPrompt, type AgentSystemPrompt } from '../system-prompt';
import type {
  AgentAdapter,
  AgentBotIdentity,
  AgentEvent,
  AgentInputReceipt,
  NativeAgentRun,
  AgentRunOptions,
} from '../types';
import { withExecutionContract } from '../execution';
import { PI_EXECUTION_CAPABILITIES } from './capabilities';
import { PiRunTranslator } from './jsonl-translator';
import { PiRpcInput, type PiImageContent } from './rpc-input';
import { piThinkingLevel } from './thinking';
import { currentModelGate, modelGateExtensionPath } from '../../model-gate/location';
import { bashTimeoutEnv, bashTimeoutInstructions, piBashTimeouts, type PiBashTimeouts } from './bash-timeout';

export interface PiAdapterOptions {
  binary?: string;
  agentDir?: string;
  systemPrompt?: AgentSystemPrompt;
  env?: NodeJS.ProcessEnv;
  stopGraceMs?: number;
  profileStateDir?: string;
  /** Time limits of the shell tool; the defaults of `piBashTimeouts()` when omitted. */
  bashTimeouts?: PiBashTimeouts;
}


export class PiAdapter implements AgentAdapter {
  readonly id = 'pi';
  readonly displayName = 'Pi Coding Agent';
  readonly capabilities = PI_EXECUTION_CAPABILITIES;

  private readonly binary: string;
  private readonly agentDir: string | undefined;
  private readonly systemPrompt: AgentSystemPrompt | undefined;
  private readonly env: NodeJS.ProcessEnv;
  private readonly defaultStopGraceMs: number;
  private readonly profileStateDir: string;
  private readonly bashTimeouts: PiBashTimeouts;
  private botIdentity: AgentBotIdentity | undefined;

  constructor(opts: PiAdapterOptions = {}) {
    this.binary = opts.binary ?? 'pi';
    this.agentDir = opts.agentDir;
    this.systemPrompt = opts.systemPrompt;
    this.env = { ...opts.env };
    this.defaultStopGraceMs = opts.stopGraceMs ?? 5000;
    this.profileStateDir = opts.profileStateDir ?? join(tmpdir(), 'lark-channel-pi-providers');
    this.bashTimeouts = opts.bashTimeouts ?? piBashTimeouts();
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
      env: this.env,
    });
  }

  async prepareRun(input: AgentRunOptions): Promise<PreparedAgentRun> {
    const opts = snapshotRunOptions({ ...input, systemPrompt: input.systemPrompt ?? resolveSystemPrompt(this.systemPrompt, this.botIdentity) });
    if (!opts.cwd) throw new Error('cwd is required for pi preparation');
    if (opts.forkSession && !opts.sessionId) throw new Error('fork requires a parent session');
    if (opts.model) validateModelId(opts.model);
    if (opts.reasoningEffort) parseEffort(opts.reasoningEffort, 'pi');
    if (opts.sandbox === 'workspace-write') {
      throw new SpawnFailed(
        'Pi has no portable workspace sandbox; use read-only or full access',
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
    return preparedRun({ model: opts.model, reasoningEffort: opts.reasoningEffort },
      () => withExecutionContract(this.runNative(opts), this.capabilities));
  }

  private runNative(opts: AgentRunOptions): NativeAgentRun {
    if (!opts.cwd) throw new Error('cwd is required for PiAdapter.run');
    if (opts.forkSession && !opts.sessionId) throw new Error('fork requires a parent session');
    const sandbox = opts.sandbox ?? 'danger-full-access';
    if (sandbox === 'workspace-write') {
      throw new Error('Pi has no portable workspace sandbox; use read-only or full access');
    }

    // A read-only run has no shell tool to bound.
    const shellLimits = sandbox === 'read-only' ? undefined : bashTimeoutInstructions(this.bashTimeouts);
    const systemPrompt = opts.systemPrompt ?? resolveSystemPrompt(this.systemPrompt, this.botIdentity);
    const runFiles = writeSystemPrompt(shellLimits ? `${systemPrompt}\n\n${shellLimits}` : systemPrompt, opts.host);
    // RPC mode keeps the process alive for the whole turn, so a message the user
    // writes while tools run can steer it instead of waiting for the next turn.
    const args = ['--mode', 'rpc', '--append-system-prompt', runFiles.systemPromptPath];
    if (opts.forkSession) args.push('--fork', opts.sessionId!);
    else if (opts.sessionId) args.push('--session', opts.sessionId);
    if (opts.model) args.push('--model', validateModelId(opts.model));
    if (opts.reasoningEffort) {
      args.push('--thinking', piThinkingLevel(parseEffort(opts.reasoningEffort, 'pi')!));
    }
    if (opts.modelProvider?.pi) {
      args.push('--extension', writePiProviderExtension(this.profileStateDir, opts.modelProvider));
    }
    // The gate is a bridge-wide service; asked per provider request, not per
    // run, so a run executing tools holds no concurrency slot. `--no-extensions`
    // below does not disable an explicit `--extension` path.
    const gate = currentModelGate();
    if (gate) args.push('--extension', modelGateExtensionPath());
    // Gives the shell tool a default time limit and a cap; like the gate, it survives `--no-extensions`.
    if (shellLimits) args.push('--extension', bashTimeoutExtensionPath());
    if (sandbox === 'read-only') {
      args.push('--no-extensions', '--tools', 'read,grep,find,ls');
    } else if (opts.deadlineAt !== undefined) {
      // No built-in scheduling exists, but extensions can add arbitrary tools
      // that outlive the bridge deadline.
      args.push('--no-extensions');
    }

    const attached = Boolean(opts.host?.attach && runHostsSupported());
    let input: PiRpcInput | undefined;
    let stopped = false;
    const stopGraceMs = opts.deadlineAt
      ? Math.max(1000, opts.stopGraceMs ?? 1000)
      : opts.stopGraceMs ?? this.defaultStopGraceMs;

    const base = startProcessRun({
      agent: this.id,
      runId: opts.runId,
      command: this.binary,
      args,
      cwd: opts.cwd,
      env: mergeProcessEnv(process.env, {
        ...this.env,
        ...opts.env,
        ...opts.modelProvider?.env,
        ...(this.agentDir ? { PI_CODING_AGENT_DIR: this.agentDir } : {}),
        ...(gate ? {
          LARK_MODEL_GATE_SOCKET: gate.socketPath,
          // Interactive runs (no deadline) go first; workflow workers queue behind them.
          LARK_MODEL_GATE_PRIORITY: String(opts.deadlineAt !== undefined ? 1 : 0),
          // The limit is the provider's: the id this model was registered under differs from model to model.
          ...(opts.modelProvider?.pi
            ? { LARK_MODEL_GATE_PROVIDER_NAMES: JSON.stringify({ [opts.modelProvider.pi.providerId]: opts.modelProvider.id }) }
            : {}),
        } : {}),
        ...(shellLimits ? bashTimeoutEnv(this.bashTimeouts) : {}),
        PI_SKIP_VERSION_CHECK: '1',
        PI_TELEMETRY: '0',
      }),
      // The prompt is a protocol command, written by the input channel below.
      stdin: '',
      keepStdinOpen: true,
      onStdin(stdin) {
        input = new PiRpcInput(stdin);
        if (attached) input.restore(readRunHostInput(opts.host!.key));
        else input.start(opts.prompt, piImages(opts.images));
      },
      onRecord(record) {
        input?.receive(record);
      },
      execSandbox: opts.execSandbox,
      signalCell: opts.signalCell,
      host: opts.host,
      translator: new PiRunTranslator(opts.answerIncludesInterimText === true, this.bashTimeouts, opts.cwd),
      strictJson: true,
      deadlineAt: opts.deadlineAt,
      stopGraceMs,
      cleanup: runFiles.cleanup,
    });

    const events = (async function* (): AsyncGenerator<AgentEvent> {
      for await (const event of base.events) {
        if (event.type !== 'done' && event.type !== 'error') {
          yield event;
          continue;
        }
        // A stop owns the outcome even if Pi exited without recording the abort.
        // Close before yielding: a consumer that stops at this event must not
        // leave the process waiting for an EOF it will never get.
        input?.close();
        if (stopped) {
          yield event.type === 'done'
            ? (event.terminationReason === 'interrupted' ? event : { ...event, terminationReason: 'interrupted' as const })
            : { type: 'done' as const, terminationReason: 'interrupted' as const };
        } else {
          yield event;
        }
        return;
      }
    })();

    return {
      runId: opts.runId,
      ...(base.detachOnShutdown ? { detachOnShutdown: true } : {}),
      events,
      async sendInput({ text, messageId, images }): Promise<AgentInputReceipt> {
        const receipt = await (input?.steer(text, messageId, piImages(images)) ?? Promise.resolve('inactive'));
        if (receipt === 'accepted') return { status: 'accepted', messageId, scope: 'active-turn' };
        if (receipt === 'inactive') return { status: 'inactive', messageId };
        return { status: 'unknown', messageId, message: 'Pi did not answer the steer; delivery is unknown' };
      },
      async stop(reason) {
        stopped = true;
        // Under a run host, shutdown hands the process to the next bridge with its stdin still open.
        if (reason === 'shutdown' && opts.host && runHostsSupported()) return base.stop(reason);
        await input?.cancel(stopGraceMs);
        if (await base.waitForExit(stopGraceMs)) return;
        await base.stop(reason);
      },
      waitForExit: (timeoutMs: number) => base.waitForExit(timeoutMs),
    };
  }
}

/** The run's images as Pi's RPC message content; an unreadable file is left to Pi's own tools. */
function piImages(paths: readonly string[] | undefined): PiImageContent[] {
  const images: PiImageContent[] = [];
  for (const path of paths ?? []) {
    const mimeType = PI_IMAGE_MIME[basename(path).split('.').pop()?.toLowerCase() ?? ''];
    if (!mimeType) continue;
    try {
      images.push({ type: 'image', data: readFileSync(path).toString('base64'), mimeType });
    } catch {
      // The prompt still lists the attachment path, so the agent can read it itself.
    }
  }
  return images;
}

const PI_IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};

/** The Pi CLI extension that bounds shell calls, resolved from src or dist. */
function bashTimeoutExtensionPath(): string {
  if (import.meta.url.endsWith('.ts')) {
    return fileURLToPath(new URL('./bash-timeout-extension.ts', import.meta.url));
  }
  const bundled = fileURLToPath(new URL('./pi-bash-timeout.js', import.meta.url));
  return existsSync(bundled) ? bundled : fileURLToPath(new URL('../dist/pi-bash-timeout.js', import.meta.url));
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

/**
 * A run under a run host can outlive this process. Its file is kept with the host: the bridge process that
 * continues the run finds the file the agent was started with, and whoever ends the host removes it.
 */
function writeSystemPrompt(systemPrompt: string, host?: RunHostBinding): {
  systemPromptPath: string;
  cleanup: () => void;
} {
  const hosted = host && runHostsSupported();
  const dir = hosted ? runHostFilesDir(host.key) : mkdtempSync(join(tmpdir(), 'lark-pi-'));
  const systemPromptPath = join(dir, 'append-system-prompt.md');
  if (!(hosted && host.attach)) writeFileSync(systemPromptPath, systemPrompt, { encoding: 'utf8', mode: 0o600 });
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
