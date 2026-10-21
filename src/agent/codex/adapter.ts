import { join } from 'node:path';
import type { SandboxMode } from '../../config/profile-schema';
import { mergeProcessEnv } from '../../platform/spawn';
import { SpawnFailed } from '../../runtime/errors';
import { prefixSystemPrompt, resolveSystemPrompt, type AgentSystemPrompt } from '../system-prompt';
import { checkAgentAvailability, type AgentAvailability } from '../preflight';
import type {
  AgentAdapter,
  AgentBotIdentity,
  AgentRun,
  AgentRunOptions,
} from '../types';
import { parseEffort } from '../model-settings';
import { validateModelId } from '../models';
import { startAppServerRun } from './app-server';
import { withExecutionContract } from '../execution';
import { codexExecutionCapabilities } from './capabilities';

export interface CodexAdapterOptions {
  binary: string;
  systemPrompt?: AgentSystemPrompt;
  transport?: 'app-server';
  profileStateDir: string;
  codexHome?: string;
  inheritCodexHome?: boolean;
  ignoreUserConfig?: boolean;
  ignoreRules?: boolean;
  sandbox?: SandboxMode;
  stopGraceMs?: number;
  env?: NodeJS.ProcessEnv;
}

export class CodexAdapter implements AgentAdapter {
  readonly id = 'codex';
  readonly displayName = 'Codex CLI';
  get capabilities() { return codexExecutionCapabilities(); }

  private readonly binary: string;
  private readonly systemPrompt: AgentSystemPrompt | undefined;
  private readonly profileStateDir: string;
  private readonly codexHome: string | undefined;
  private readonly inheritCodexHome: boolean;
  private readonly sandbox: SandboxMode;
  private readonly defaultStopGraceMs: number;
  private readonly env: NodeJS.ProcessEnv;
  private botIdentity: AgentBotIdentity | undefined;

  constructor(opts: CodexAdapterOptions) {
    if (opts.transport !== undefined && opts.transport !== 'app-server') {
      throw new Error('Codex exec transport has been removed; use transport=app-server');
    }
    if (opts.ignoreUserConfig || opts.ignoreRules) {
      throw new Error('app-server requires ignoreUserConfig=false and ignoreRules=false; exec-only ignore flags are not supported');
    }
    this.binary = opts.binary;
    this.systemPrompt = opts.systemPrompt;
    this.profileStateDir = opts.profileStateDir;
    this.codexHome = opts.codexHome;
    this.inheritCodexHome = opts.inheritCodexHome !== false;
    this.sandbox = opts.sandbox ?? 'danger-full-access';
    this.defaultStopGraceMs = opts.stopGraceMs ?? 5000;
    this.env = { ...opts.env };
  }

  private promptFor(opts: AgentRunOptions): string {
    return prefixSystemPrompt(opts.prompt, opts.systemPrompt ?? resolveSystemPrompt(this.systemPrompt, this.botIdentity));
  }

  setBotIdentity(identity: AgentBotIdentity): void {
    this.botIdentity = identity;
  }

  async isAvailable(): Promise<boolean> {
    return (await this.checkAvailability()).ok;
  }

  async checkAvailability(): Promise<AgentAvailability> {
    return checkAgentAvailability({
      agentId: 'codex',
      agentName: 'Codex CLI',
      command: this.binary,
      binaryPath: this.binary,
    });
  }

  async prepareRun(): Promise<void> {
    const availability = await this.checkAvailability();
    if (!availability.ok) {
      throw new SpawnFailed(
        'codex binary check failed',
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
    if (!opts.cwd) {
      throw new Error('cwd is required for CodexAdapter.run');
    }

    const sandbox = opts.sandbox ?? this.sandbox;
    if (!['read-only', 'workspace-write', 'danger-full-access'].includes(sandbox)) {
      throw new Error(`unsafe sandbox mode: ${sandbox}`);
    }
    if (opts.forkSession && !opts.threadId) throw new Error('fork requires a parent thread');
    if (opts.model) validateModelId(opts.model);
    if (opts.reasoningEffort) parseEffort(opts.reasoningEffort, 'codex');
    const envOverrides: NodeJS.ProcessEnv = { ...this.env };
    if (this.codexHome) {
      envOverrides.CODEX_HOME = this.codexHome;
    } else if (!this.inheritCodexHome) {
      envOverrides.CODEX_HOME = join(this.profileStateDir, 'codex-home');
    }
    const provider = opts.modelProvider?.codex;
    const configOverrides: string[] = [];
    if (provider) {
      Object.assign(envOverrides, opts.modelProvider?.env);
      configOverrides.push(`model_provider=${quoteToml(provider.providerId)}`);
      if (provider.auth === 'api-key') {
        const prefix = `model_providers.${provider.providerId}`;
        configOverrides.push(
          `${prefix}.name=${quoteToml(provider.name)}`,
          `${prefix}.base_url=${quoteToml(provider.baseUrl)}`,
          `${prefix}.wire_api=${quoteToml(provider.wireApi)}`,
          `${prefix}.env_key=${quoteToml(provider.apiKeyEnv)}`,
        );
        if (provider.headersEnv) {
          configOverrides.push(`${prefix}.env_http_headers=${quoteToml(provider.headersEnv)}`);
        }
      } else {
        configOverrides.push('forced_login_method="chatgpt"');
      }
    }
    return startAppServerRun({
      binary: this.binary, opts,
      env: mergeProcessEnv(process.env, envOverrides),
      sandbox,
      prompt: this.promptFor(opts),
      stopGraceMs: opts.stopGraceMs ?? this.defaultStopGraceMs,
      configOverrides,
    });
  }
}

function quoteToml(value: string | Record<string, string>): string {
  return JSON.stringify(value);
}
