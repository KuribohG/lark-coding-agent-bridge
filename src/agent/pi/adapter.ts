import { preparedRun, snapshotRunOptions } from '../prepared-run';
import type { PreparedAgentRun } from '../types';
import { startProcessRun } from '../process-run';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SpawnFailed } from '../errors';
import { mergeProcessEnv } from '../../platform/spawn';
import { checkAgentAvailability, type AgentAvailability } from '../preflight';
import { parseEffort } from '../model-settings';
import { validateModelId } from '../models';
import type { ResolvedModelProvider } from '../../model-provider/types';
import { resolveSystemPrompt, type AgentSystemPrompt } from '../system-prompt';
import type {
  AgentAdapter,
  AgentBotIdentity,
  NativeAgentRun,
  AgentRunOptions,
} from '../types';
import { withExecutionContract } from '../execution';
import { PI_EXECUTION_CAPABILITIES } from './capabilities';
import { PiRunTranslator } from './jsonl-translator';
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
    const runFiles = writeSystemPrompt(shellLimits ? `${systemPrompt}\n\n${shellLimits}` : systemPrompt);
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

    return startProcessRun({
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
        } : {}),
        ...(shellLimits ? bashTimeoutEnv(this.bashTimeouts) : {}),
        PI_SKIP_VERSION_CHECK: '1',
        PI_TELEMETRY: '0',
      }),
      stdin: opts.prompt,
      execSandbox: opts.execSandbox,
      translator: new PiRunTranslator(opts.answerIncludesInterimText === true, this.bashTimeouts),
      strictJson: true,
      deadlineAt: opts.deadlineAt,
      stopGraceMs: opts.deadlineAt
        ? Math.max(1000, opts.stopGraceMs ?? 1000)
        : opts.stopGraceMs ?? this.defaultStopGraceMs,
      cleanup: runFiles.cleanup,
    });
  }
}

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
