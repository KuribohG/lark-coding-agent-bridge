import { join } from 'node:path';
import { homedir } from 'node:os';
import type { CodexAppServerMode, SandboxMode } from '../../config/profile-schema';
import { preparedRun, snapshotRunOptions } from '../prepared-run';
import { codexExecutionEnvironment } from './environment';
import { SpawnFailed } from '../errors';
import { resolveSystemPrompt, type AgentSystemPrompt } from '../system-prompt';
import { checkAgentAvailability, type AgentAvailability } from '../preflight';
import type {
  AgentAdapter,
  AgentBotIdentity,
  AgentRun,
  PreparedAgentRun,
  AgentRunOptions,
} from '../types';
import { parseEffort } from '../model-settings';
import { validateModelId } from '../models';
import { startAppServerRun } from './app-server';
import { withExecutionContract } from '../execution';
import { codexExecutionCapabilities } from './capabilities';
import { attachedDaemonRuns, codexDaemonHostTag, daemonEnvironmentFingerprint, ensureCodexAppServerDaemon, trackDaemonRun } from './daemon';
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
  /** Trusted profile tool context; provider credentials are resolved separately. */
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
  private readonly profileEnv: Readonly<NodeJS.ProcessEnv>;
  private readonly startupProvider: CodexAdapterOptions['startupProvider'];
  private startup?: Promise<{ provider?: ResolvedModelProvider; config: Awaited<ReturnType<typeof prepareManagedCodexConfig>> }>;
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
    this.profileEnv = Object.freeze({ ...opts.env });
  }

  /** The daemon is shared by every adapter on this home; restarting it would end attached runs. */
  async replacementBlocker(next: AgentAdapter, context: { providersChanged: boolean }): Promise<string | undefined> {
    if (this.appServerMode !== 'daemon' || !(next instanceof CodexAdapter)) return undefined;
    const busy = attachedDaemonRuns(this.binary, this.home());
    if (!busy) return undefined;
    const same = !context.providersChanged && next.daemonIdentity() === this.daemonIdentity()
      && await next.providerSignature() === await this.providerSignature();
    if (same) return undefined;
    return `Codex 后台服务仍有 ${busy} 个任务在运行，新的启动参数需要重启它；任务结束后自动应用`;
  }

  /** The provider this adapter runs with (memoized) or would start with. */
  private async providerSignature(): Promise<string> {
    const provider = await (this.startup ? this.startup.then(startup => startup.provider) : Promise.resolve(this.startupProvider?.()))
      .catch(() => undefined);
    return JSON.stringify(provider ? [provider.id, provider.model, provider.codex, Object.keys(provider.env ?? {}).sort()] : null);
  }

  private home(): string {
    return this.codexHome ?? (this.inheritCodexHome
      ? this.profileEnv.CODEX_HOME ?? process.env.CODEX_HOME ?? join(homedir(), '.codex')
      : join(this.profileStateDir, 'codex-home'));
  }

  private daemonIdentity(): string {
    return JSON.stringify([this.binary, this.home(), this.appServerMode,
      Object.entries(this.profileEnv).sort(([a], [b]) => a.localeCompare(b))]);
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
      env: this.profileEnv,
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

  async prepareRun(input: AgentRunOptions): Promise<PreparedAgentRun> {
    const opts = snapshotRunOptions(input);
    if (!opts.cwd) throw new Error('cwd is required for CodexAdapter.prepareRun');
    const sandbox = opts.sandbox ?? this.sandbox;
    if (!['read-only', 'workspace-write', 'danger-full-access'].includes(sandbox)) {
      throw new Error(`unsafe sandbox mode: ${sandbox}`);
    }
    if (opts.forkSession && !opts.threadId) throw new Error('fork requires a parent thread');
    if (opts.model) validateModelId(opts.model);
    if (opts.reasoningEffort) parseEffort(opts.reasoningEffort, 'codex');
    const availability = await this.checkAvailability();
    if (!availability.ok) {
      throw new SpawnFailed('codex binary check failed', availability.error,
        availability.diagnostic.code, availability.diagnostic);
    }
    const startup = await this.initializeProvider();
    const requested = opts.modelProvider;
    const rejectedProvider = requested && requested.id !== startup.provider?.id;
    const effectiveOpts = snapshotRunOptions({
      ...opts,
      ...(rejectedProvider ? { model: startup.config.model, reasoningEffort: undefined } : {}),
      systemPrompt: opts.systemPrompt ?? resolveSystemPrompt(this.systemPrompt, this.botIdentity),
    });
    const home = this.codexHome ?? (this.inheritCodexHome
      ? this.profileEnv.CODEX_HOME ?? process.env.CODEX_HOME ?? join(homedir(), '.codex')
      : join(this.profileStateDir, 'codex-home'));
    const environment = codexExecutionEnvironment({
      profile: { ...this.profileEnv, CODEX_HOME: home },
      attempt: effectiveOpts.env,
      backend: startup.provider?.env ?? {},
    });
    let daemonSocketPath: string | undefined;
    // A reattached run is already connected through its host; never restart the daemon for it.
    if (this.appServerMode === 'daemon' && !effectiveOpts.host?.attach) {
      const status = await ensureCodexAppServerDaemon({
        binary: this.binary, env: environment.process, cwd: effectiveOpts.cwd,
        timeoutMs: deadlineTimeout(effectiveOpts.deadlineAt), restart: startup.config.changed,
        fingerprint: daemonEnvironmentFingerprint({ ...this.profileEnv, CODEX_HOME: home, ...(startup.provider?.env ?? {}) }),
      });
      if (!status.socketPath) throw new Error('Codex app-server daemon returned no socket path');
      daemonSocketPath = status.socketPath;
      // A deferred restart keeps the change pending so the next run retries it.
      if (!status.restartDeferred) {
        await startup.config.commit?.();
        startup.config.changed = false;
      }
    } else {
      startup.config.changed = false;
    }

    const provider = startup.provider?.codex;
    const configOverrides: string[] = [];
    if (provider && this.appServerMode === 'per-run') {
      const prefix = `model_providers.${provider.providerId}`;
      configOverrides.push(`model_provider=${quoteToml(provider.providerId)}`,
        `${prefix}.name=${quoteToml(provider.name)}`,
        `${prefix}.base_url=${quoteToml(provider.baseUrl)}`,
        `${prefix}.wire_api=${quoteToml(provider.wireApi)}`,
        `${prefix}.env_key=${quoteToml(provider.apiKeyEnv)}`);
      if (provider.headersEnv) configOverrides.push(`${prefix}.env_http_headers=${quoteToml(provider.headersEnv)}`);
    }
    // Both transports use the same thread tool context. A daemon's inherited
    // process environment is neither a profile binding nor an attempt binding.
    const threadConfig = {
      shell_environment_policy: environment.tools,
      ...(opts.forkSession ? { features: { goals: false } } : {}),
    };
    const modelSettings = { model: effectiveOpts.model, reasoningEffort: effectiveOpts.reasoningEffort };
    const daemon = this.appServerMode === 'daemon' ? { binary: this.binary, env: environment.process } : undefined;
    const attach = (run: AgentRun) => daemon ? trackDaemonRun(daemon, run) : run;
    return preparedRun(modelSettings, () => attach(withExecutionContract(startAppServerRun({
      binary: this.binary, opts: effectiveOpts, env: environment.process, sandbox,
      appServerMode: this.appServerMode, daemonSocketPath,
      prompt: effectiveOpts.prompt, developerInstructions: effectiveOpts.systemPrompt,
      stopGraceMs: effectiveOpts.stopGraceMs ?? this.defaultStopGraceMs,
      configOverrides, modelProviderId: startup.config.id, threadConfig,
      ...(daemon ? { hostTag: codexDaemonHostTag(daemon) } : {}),
      initialNotice: rejectedProvider
        ? `Provider 未切换：当前继续使用 ${startup.provider?.displayName ?? startup.config.id ?? '原生默认'}${startup.config.model ? ` / ${startup.config.model}` : ''}。请修改 bridge 启动配置并重启后使用 ${requested.displayName}。`
        : undefined,
    }), this.capabilities)), { id: startup.provider?.id ?? startup.config.id,
      ...(rejectedProvider ? { requestedId: requested.id } : {}) });
  }

  private initializeProvider() {
    if (!this.startup) this.startup = (async () => {
      const provider = await this.startupProvider?.();
      const home = this.codexHome ?? (this.inheritCodexHome
        ? this.profileEnv.CODEX_HOME ?? process.env.CODEX_HOME ?? join(homedir(), '.codex') : join(this.profileStateDir, 'codex-home'));
      const config = await prepareManagedCodexConfig(home, provider);
      return { provider, config };
    })();
    return this.startup;
  }

  async modelProviderState() {
    const { provider, config } = await this.initializeProvider();
    return { id: provider?.id ?? config.id, displayName: provider?.displayName ?? config.id, fixedUntilRestart: true, model: config.model };
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
