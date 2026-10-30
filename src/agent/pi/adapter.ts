import { startProcessRun } from '../process-run';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SpawnFailed } from '../../runtime/errors';
import { mergeProcessEnv } from '../../platform/spawn';
import { checkAgentAvailability, type AgentAvailability } from '../preflight';
import { parseEffort } from '../model-settings';
import { validateModelId } from '../models';
import type { ResolvedModelProvider } from '../../model-provider/types';
import { resolveSystemPrompt, type AgentSystemPrompt } from '../system-prompt';
import type {
  AgentAdapter,
  AgentBotIdentity,
  AgentRun,
  AgentRunOptions,
} from '../types';
import { withExecutionContract } from '../execution';
import { PI_EXECUTION_CAPABILITIES } from './capabilities';
import { PiRunTranslator } from './jsonl-translator';

export interface PiAdapterOptions {
  binary?: string;
  agentDir?: string;
  systemPrompt?: AgentSystemPrompt;
  env?: NodeJS.ProcessEnv;
  stopGraceMs?: number;
  profileStateDir?: string;
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
  private botIdentity: AgentBotIdentity | undefined;

  constructor(opts: PiAdapterOptions = {}) {
    this.binary = opts.binary ?? 'pi';
    this.agentDir = opts.agentDir;
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
      env: this.env,
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
        PI_SKIP_VERSION_CHECK: '1',
        PI_TELEMETRY: '0',
      }),
      stdin: opts.prompt,
      translator: new PiRunTranslator(),
      strictJson: true,
      deadlineAt: opts.deadlineAt,
      stopGraceMs: opts.deadlineAt
        ? Math.max(1000, opts.stopGraceMs ?? 1000)
        : opts.stopGraceMs ?? this.defaultStopGraceMs,
      cleanup: runFiles.cleanup,
    });
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
