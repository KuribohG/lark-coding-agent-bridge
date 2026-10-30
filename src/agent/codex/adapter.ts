import { join } from 'node:path';
import { homedir } from 'node:os';
import type { CodexAppServerMode, SandboxMode } from '../../config/profile-schema';
import { mergeProcessEnv } from '../../platform/spawn';
import { SpawnFailed } from '../../runtime/errors';
import { resolveSystemPrompt, type AgentSystemPrompt } from '../system-prompt';
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
import { ensureCodexAppServerDaemon } from './daemon';
import { prepareManagedCodexConfig } from './managed-config';
import type { ResolvedModelProvider } from '../../model-provider/types';

export interface CodexAdapterOptions {
  binary: string;
  startupProvider?: () => Promise<ResolvedModelProvider | undefined> | undefined;
  systemPrompt?: AgentSystemPrompt;
  transport?: 'app-server';
  appServerMode?: CodexAppServerMode;
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
  private readonly appServerMode: CodexAppServerMode;
  private readonly profileStateDir: string;
  private readonly codexHome: string | undefined;
  private readonly inheritCodexHome: boolean;
  private readonly sandbox: SandboxMode;
  private readonly defaultStopGraceMs: number;
  private readonly env: NodeJS.ProcessEnv;
  private readonly daemonSockets = new WeakMap<AgentRunOptions, string>();
  private readonly startupProvider: CodexAdapterOptions['startupProvider'];
  private startup?: Promise<{ provider?: ResolvedModelProvider; config: Awaited<ReturnType<typeof prepareManagedCodexConfig>> }>;
  private fixedProvider?: ResolvedModelProvider;
  private startupModel?: string;
  private startupId?: string;
  private botIdentity: AgentBotIdentity | undefined;
  private successfulAvailability: Promise<AgentAvailability> | undefined;

  constructor(opts: CodexAdapterOptions) {
    if (opts.transport !== undefined && opts.transport !== 'app-server') {
      throw new Error('Codex exec transport has been removed; use transport=app-server');
    }
    if (opts.ignoreUserConfig || opts.ignoreRules) {
      throw new Error('app-server requires ignoreUserConfig=false and ignoreRules=false; exec-only ignore flags are not supported');
    }
    this.binary = opts.binary;
    this.startupProvider = opts.startupProvider;
    this.systemPrompt = opts.systemPrompt;
    this.appServerMode = opts.appServerMode ?? 'per-run';
    this.profileStateDir = opts.profileStateDir;
    this.codexHome = opts.codexHome;
    this.inheritCodexHome = opts.inheritCodexHome === true;
    this.sandbox = opts.sandbox ?? 'danger-full-access';
    this.defaultStopGraceMs = opts.stopGraceMs ?? 5000;
    this.env = { ...opts.env };
  }

  setBotIdentity(identity: AgentBotIdentity): void {
    this.botIdentity = identity;
  }

  async isAvailable(): Promise<boolean> {
    return (await this.checkAvailability()).ok;
  }

  async checkAvailability(): Promise<AgentAvailability> {
    if (this.successfulAvailability) return this.successfulAvailability;
    const pending = checkAgentAvailability({
      agentId: 'codex',
      agentName: 'Codex CLI',
      command: this.binary,
      binaryPath: this.binary,
      env: this.env,
    });
    this.successfulAvailability = pending;
    pending.then(
      (availability) => {
        if (!availability.ok && this.successfulAvailability === pending) {
          this.successfulAvailability = undefined;
        }
      },
      () => {
        if (this.successfulAvailability === pending) this.successfulAvailability = undefined;
      },
    );
    return pending;
  }

  async prepareRun(opts?: AgentRunOptions): Promise<void> {
    const availability = await this.checkAvailability();
    if (!availability.ok) {
      throw new SpawnFailed(
        'codex binary check failed',
        availability.error,
        availability.diagnostic.code,
        availability.diagnostic,
      );
    }
    const startup = await this.initializeProvider();
    if (this.appServerMode === 'daemon') {
      if (!opts) throw new Error('Codex daemon preparation requires run options');
      const status = await ensureCodexAppServerDaemon({
        binary: this.binary,
        env: this.runEnvironment(opts),
        cwd: opts.cwd,
        timeoutMs: deadlineTimeout(opts.deadlineAt),
        restart: startup.config.changed,
      });
      if (!status.socketPath) throw new Error('Codex app-server daemon returned no socket path');
      this.daemonSockets.set(opts, status.socketPath);
      await startup.config.commit?.();
    }
    startup.config.changed = false;
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
    const requested = opts.modelProvider;
    const rejectedProvider = requested && requested.id !== this.fixedProvider?.id;
    const effectiveOpts = rejectedProvider
      ? { ...opts, model: this.startupModel, reasoningEffort: undefined }
      : opts;
    const provider = this.fixedProvider?.codex;
    const configOverrides: string[] = [];
    const threadConfig: Record<string, unknown> = this.appServerMode === 'daemon'
      ? { shell_environment_policy: { inherit: 'all', ...(opts.env ? { set: opts.env } : {}) } }
      : {};
    if (provider) {
      const prefix = `model_providers.${provider.providerId}`;
      if (this.appServerMode === 'per-run') {
        configOverrides.push(`model_provider=${quoteToml(provider.providerId)}`);
        configOverrides.push(
          `${prefix}.name=${quoteToml(provider.name)}`,
          `${prefix}.base_url=${quoteToml(provider.baseUrl)}`,
          `${prefix}.wire_api=${quoteToml(provider.wireApi)}`,
          `${prefix}.env_key=${quoteToml(provider.apiKeyEnv)}`,
        );
        if (provider.headersEnv) {
          configOverrides.push(`${prefix}.env_http_headers=${quoteToml(provider.headersEnv)}`);
        }
      }
    }
    if (opts.forkSession && this.appServerMode === 'daemon') {
      threadConfig.features = { goals: false };
    }
    const env = this.runEnvironment(opts);
    const daemonSocketPath = this.appServerMode === 'daemon' ? this.daemonSockets.get(opts) : undefined;
    if (this.appServerMode === 'daemon' && !daemonSocketPath) {
      throw new Error('Codex daemon run requires a successful prepareRun');
    }
    return startAppServerRun({
      binary: this.binary, opts: effectiveOpts,
      env,
      sandbox,
      appServerMode: this.appServerMode,
      daemonSocketPath,
      prompt: opts.prompt,
      developerInstructions: opts.systemPrompt
        ?? resolveSystemPrompt(this.systemPrompt, this.botIdentity),
      stopGraceMs: opts.stopGraceMs ?? this.defaultStopGraceMs,
      configOverrides,
      modelProviderId: this.startupId,
      initialNotice: rejectedProvider
        ? `Provider 未切换：当前继续使用 ${this.fixedProvider?.displayName ?? this.startupId ?? '原生默认'}${this.startupModel ? ` / ${this.startupModel}` : ''}。请修改 bridge 启动配置并重启后使用 ${requested.displayName}。`
        : undefined,
      threadConfig: this.appServerMode === 'daemon' ? threadConfig : undefined,
    });
  }

  private initializeProvider() {
    if (!this.startup) this.startup = (async () => {
      const provider = await this.startupProvider?.();
      const home = this.codexHome ?? (this.inheritCodexHome
        ? this.env.CODEX_HOME ?? process.env.CODEX_HOME ?? join(homedir(), '.codex') : join(this.profileStateDir, 'codex-home'));
      const config = await prepareManagedCodexConfig(home, provider);
      this.fixedProvider = provider;
      this.startupModel = config.model;
      this.startupId = config.id;
      return { provider, config };
    })();
    return this.startup;
  }

  async modelProviderState() {
    const { provider, config } = await this.initializeProvider();
    return { id: provider?.id ?? config.id, displayName: provider?.displayName ?? config.id, fixedUntilRestart: true, model: config.model };
  }

  private runEnvironment(opts: AgentRunOptions): NodeJS.ProcessEnv {
    const envOverrides: NodeJS.ProcessEnv = { ...this.env, ...(this.appServerMode === 'per-run' ? opts.env : {}) };
    if (this.codexHome) {
      envOverrides.CODEX_HOME = this.codexHome;
    } else if (!this.inheritCodexHome) {
      envOverrides.CODEX_HOME = join(this.profileStateDir, 'codex-home');
    }
    if (this.fixedProvider) {
      Object.assign(envOverrides, this.fixedProvider.env);
    }
    return mergeProcessEnv(process.env, envOverrides);
  }
}

function deadlineTimeout(deadlineAt: number | undefined): number | undefined {
  if (deadlineAt === undefined) return undefined;
  return Math.max(1000, Math.min(30_000, deadlineAt - Date.now()));
}

function quoteToml(value: string | Record<string, string>): string {
  if (typeof value === 'string') return JSON.stringify(value);
  return `{ ${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)} = ${JSON.stringify(item)}`).join(', ')} }`;
}
