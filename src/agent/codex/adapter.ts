import { realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import type { CodexAppServerMode, SandboxMode } from '../../config/profile-schema';
import type { AgentAuthMode } from '../launch-options';
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
import { append1mSuffix, strip1mSuffix, validateModelId } from '../models';
import { startAppServerRun } from './app-server';
import { withExecutionContract } from '../execution';
import { codexExecutionCapabilities } from './capabilities';
import { attachedDaemonRuns, codexDaemonHostTag, daemonEnvironmentFingerprint, ensureCodexAppServerDaemon, trackDaemonRun } from './daemon';
import { prepareManagedCodexConfig } from './managed-config';
import type { ResolvedModelProvider } from '../../model-provider/types';

export type CodexAuthMode = AgentAuthMode;

export const CODEX_OAUTH_SCRUB_ENV = Object.freeze(['OPENAI_API_KEY', 'OPENAI_BASE_URL'] as const);
const CODEX_1M_CONTEXT_WINDOW = 1_000_000;
const CODEX_1M_AUTO_COMPACT_LIMIT = 900_000;

export interface CodexAdapterOptions {
  binary: string;
  authMode?: CodexAuthMode;
  /** Explicit API key used in `api_key` mode when `startupProvider` is omitted. */
  apiKey?: string;
  /** Optional custom OpenAI-compatible base URL (supports http:// or https://) for `api_key` mode. */
  baseUrl?: string;
  /** Optional default model override when per-run `opts.model` is omitted. */
  model?: string;
  /** Enable 1M context window (`model_context_window=1000000`, `model_auto_compact_token_limit=900000`, and `[1m]` in `api_key` mode). */
  context1m?: boolean;
  unsetEnv?: readonly string[];
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
  private readonly authMode: CodexAuthMode | undefined;
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string | undefined;
  private readonly model: string | undefined;
  private readonly context1m: boolean | undefined;
  private readonly unsetEnv: readonly string[];
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
    this.authMode = opts.authMode;
    this.apiKey = opts.apiKey?.trim() || undefined;
    this.baseUrl = opts.baseUrl ? normalizeCodexGatewayUrl(opts.baseUrl) : undefined;
    this.model = opts.model?.trim() || undefined;
    this.context1m = opts.context1m;
    this.unsetEnv = Object.freeze([...(opts.unsetEnv ?? [])]);
    this.startupProvider = opts.startupProvider;
    this.systemPrompt = opts.systemPrompt;
    this.appServerMode = opts.appServerMode ?? 'per-run';
    this.profileStateDir = opts.profileStateDir;
    this.codexHome = opts.codexHome;
    this.inheritCodexHome = this.authMode === 'api_key'
      ? false
      : this.authMode === 'oauth'
        ? (opts.inheritCodexHome ?? true)
        : opts.inheritCodexHome === true;
    if (this.authMode === 'api_key' && this.codexHome && isPersonalCodexHome(this.codexHome)) {
      throw new Error('Codex api_key mode requires an isolated codexHome, not ~/.codex');
    }
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
    const provider = await (this.startup ? this.startup.then(startup => startup.provider) : Promise.resolve(this.resolveStartupProvider()))
      .catch(() => undefined);
    return JSON.stringify(provider ? [provider.id, provider.model, provider.codex, Object.keys(provider.env ?? {}).sort()] : null);
  }

  private home(): string {
    if (this.authMode === 'api_key') {
      const target = this.codexHome ?? join(this.profileStateDir, 'codex-home');
      if (isPersonalCodexHome(target)) {
        throw new Error('Codex api_key mode requires an isolated codexHome, not ~/.codex');
      }
      return target;
    }
    return this.codexHome ?? (this.inheritCodexHome
      ? readEnvCI(this.profileEnv, 'CODEX_HOME') ?? process.env.CODEX_HOME ?? join(homedir(), '.codex')
      : join(this.profileStateDir, 'codex-home'));
  }

  private effectiveUnsetEnv(): string[] {
    if (this.authMode === 'oauth' || this.authMode === 'api_key') {
      return [...new Set([...this.unsetEnv, ...CODEX_OAUTH_SCRUB_ENV])];
    }
    return [...this.unsetEnv];
  }

  private resolveExplicitApiKey(attemptEnv?: Readonly<Record<string, string>>): string | undefined {
    return this.apiKey
      ?? readEnvCI(this.profileEnv, 'OPENAI_API_KEY')
      ?? readEnvCI(attemptEnv, 'OPENAI_API_KEY');
  }

  private resolveExplicitBaseUrl(attemptEnv?: Readonly<Record<string, string>>): string | undefined {
    const raw = this.baseUrl
      ?? readEnvCI(this.profileEnv, 'OPENAI_BASE_URL')
      ?? readEnvCI(attemptEnv, 'OPENAI_BASE_URL');
    return raw ? normalizeCodexGatewayUrl(raw) : undefined;
  }

  private async resolveStartupProvider(): Promise<ResolvedModelProvider | undefined> {
    if (this.authMode === 'oauth') return undefined;
    if (this.startupProvider) return this.startupProvider();
    if (this.authMode !== 'api_key') return undefined;
    const baseUrl = this.resolveExplicitBaseUrl();
    if (!baseUrl) return undefined;
    const apiKey = this.resolveExplicitApiKey();
    return {
      id: 'openai_custom',
      displayName: 'Custom OpenAI',
      model: this.model ?? '',
      env: {
        ...(apiKey ? { OPENAI_API_KEY: apiKey } : {}),
        OPENAI_BASE_URL: baseUrl,
      },
      codex: {
        providerId: 'lark_custom',
        name: 'Custom OpenAI',
        baseUrl,
        wireApi: 'responses',
        apiKeyEnv: 'OPENAI_API_KEY',
      },
    };
  }

  private daemonIdentity(): string {
    return JSON.stringify([this.binary, this.home(), this.appServerMode, this.authMode ?? null,
      this.unsetEnv, Object.entries(this.profileEnv).sort(([a], [b]) => a.localeCompare(b))]);
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
      unsetEnv: this.effectiveUnsetEnv(),
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
    const context1m = input.context1m ?? this.context1m;
    const requestedModel = resolveCodexEffectiveModel(input.model ?? this.model, this.authMode, context1m);
    const opts = snapshotRunOptions({
      ...input,
      ...(requestedModel ? { model: requestedModel } : {}),
      ...(context1m !== undefined ? { context1m } : {}),
    });
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
    const home = this.home();
    const unsetEnv = this.effectiveUnsetEnv();
    const backendEnv: NodeJS.ProcessEnv = { ...(startup.provider?.env ?? {}) };
    if (this.authMode === 'api_key') {
      const explicitKey = this.resolveExplicitApiKey(effectiveOpts.env);
      const explicitBaseUrl = this.resolveExplicitBaseUrl(effectiveOpts.env);
      if (!startup.provider && !explicitKey) {
        throw new Error('Codex api_key authMode requires apiKey, startupProvider, or OPENAI_API_KEY in env');
      }
      if (explicitKey && !startup.provider) backendEnv.OPENAI_API_KEY = explicitKey;
      if (explicitBaseUrl && !startup.provider) backendEnv.OPENAI_BASE_URL = explicitBaseUrl;
    }
    const environment = codexExecutionEnvironment({
      profile: { ...this.profileEnv, CODEX_HOME: home },
      attempt: effectiveOpts.env,
      backend: backendEnv,
      unsetEnv,
    });
    let daemonSocketPath: string | undefined;
    // Routing this run must use; a deferred restart keeps the daemon on its previous one.
    let deferred = false;
    // A reattached run is already connected through its host; never restart the daemon for it.
    if (this.appServerMode === 'daemon' && !effectiveOpts.host?.attach) {
      const status = await ensureCodexAppServerDaemon({
        binary: this.binary, env: environment.process, cwd: effectiveOpts.cwd,
        timeoutMs: deadlineTimeout(effectiveOpts.deadlineAt), restart: startup.config.changed,
        fingerprint: daemonEnvironmentFingerprint(fingerprintEnv({ ...this.profileEnv, CODEX_HOME: home, ...backendEnv }, unsetEnv)),
      });
      if (!status.socketPath) throw new Error('Codex app-server daemon returned no socket path');
      daemonSocketPath = status.socketPath;
      // A deferred restart keeps the change pending so the next run retries it; the
      // file must go back to the routing the still-running daemon was launched with.
      if (!status.restartDeferred) {
        await startup.config.commit?.();
        startup.config.changed = false;
      } else {
        deferred = true;
        await startup.config.revert();
      }
    } else {
      startup.config.changed = false;
    }

    // A daemon that could not restart yet keeps serving its previous provider, and
    // its environment only carries that provider's credentials.
    const routing = deferred ? startup.config.previous
      : { id: startup.config.id, model: startup.config.model };
    const routingPending = deferred && startup.config.changed;

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
    if (context1m === true) {
      configOverrides.push(
        `model_context_window=${CODEX_1M_CONTEXT_WINDOW}`,
        `model_auto_compact_token_limit=${CODEX_1M_AUTO_COMPACT_LIMIT}`,
      );
    }
    // Both transports use the same thread tool context. A daemon's inherited
    // process environment is neither a profile binding nor an attempt binding.
    const threadConfig = {
      shell_environment_policy: environment.tools,
      ...(opts.forkSession ? { features: { goals: false } } : {}),
      ...(context1m === true ? {
        model_context_window: CODEX_1M_CONTEXT_WINDOW,
        model_auto_compact_token_limit: CODEX_1M_AUTO_COMPACT_LIMIT,
      } : {}),
    };
    const modelSettings = { model: deferred ? routing.model : effectiveOpts.model, reasoningEffort: effectiveOpts.reasoningEffort };
    const daemon = this.appServerMode === 'daemon' ? { binary: this.binary, env: environment.process } : undefined;
    const attach = (run: AgentRun) => daemon ? trackDaemonRun(daemon, run) : run;
    return preparedRun(modelSettings, () => attach(withExecutionContract(startAppServerRun({
      binary: this.binary, opts: effectiveOpts, env: environment.process, sandbox,
      appServerMode: this.appServerMode, daemonSocketPath,
      prompt: effectiveOpts.prompt, developerInstructions: effectiveOpts.systemPrompt,
      stopGraceMs: effectiveOpts.stopGraceMs ?? this.defaultStopGraceMs,
      configOverrides, modelProviderId: routing.id, threadConfig,
      ...(daemon ? { hostTag: codexDaemonHostTag(daemon) } : {}),
      initialNotice: routingPending
        ? `模型 Provider 切换要等当前任务结束后生效，本轮继续使用 ${routing.id}${routing.model ? ` / ${routing.model}` : ''}。`
        : rejectedProvider
          ? `Provider 未切换：当前继续使用 ${startup.provider?.displayName ?? startup.config.id ?? '原生默认'}${startup.config.model ? ` / ${startup.config.model}` : ''}。请修改 bridge 启动配置并重启后使用 ${requested.displayName}。`
          : undefined,
    }), this.capabilities)), { id: startup.provider?.id ?? routing.id,
      ...(rejectedProvider ? { requestedId: requested.id } : {}) });
  }

  private initializeProvider() {
    if (!this.startup) this.startup = (async () => {
      const provider = await this.resolveStartupProvider();
      const home = this.home();
      const config = await prepareManagedCodexConfig(home, provider, { readOnly: this.authMode === 'oauth' });
      return { provider, config };
    })();
    return this.startup;
  }

  async modelProviderState() {
    const { provider, config } = await this.initializeProvider();
    return { id: provider?.id ?? config.id, displayName: provider?.displayName ?? config.id, fixedUntilRestart: true, model: config.model };
  }
}

function readEnvCI(env: Readonly<NodeJS.ProcessEnv> | undefined, name: string): string | undefined {
  if (!env) return undefined;
  if (env[name] !== undefined) return env[name];
  const wanted = name.toLowerCase();
  return Object.entries(env).find(([key]) => key.toLowerCase() === wanted)?.[1];
}

function isPersonalCodexHome(candidate: string): boolean {
  const canonical = (target: string) => {
    try { return realpathSync(target); } catch { return resolve(target); }
  };
  return canonical(candidate) === canonical(join(homedir(), '.codex'));
}

function normalizeCodexGatewayUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error('Codex baseUrl must be a valid HTTP(S) URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Codex baseUrl must use http:// or https:// without credentials, query, or hash');
  }
  return url.href.replace(/\/+$/, '');
}

function fingerprintEnv(env: NodeJS.ProcessEnv, unsetEnv: readonly string[]): NodeJS.ProcessEnv {
  if (!unsetEnv.length) return env;
  const out: NodeJS.ProcessEnv = { ...env };
  const drop = new Set(unsetEnv.map(key => key.toLowerCase()));
  for (const key of Object.keys(out)) {
    if (drop.has(key.toLowerCase()) && out[key] === undefined) delete out[key];
  }
  return out;
}

function deadlineTimeout(deadlineAt: number | undefined): number | undefined {
  if (deadlineAt === undefined) return undefined;
  return Math.max(1000, Math.min(30_000, deadlineAt - Date.now()));
}

function quoteToml(value: string | Record<string, string>): string {
  if (typeof value === 'string') return JSON.stringify(value);
  return `{ ${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)} = ${JSON.stringify(item)}`).join(', ')} }`;
}

function resolveCodexEffectiveModel(
  rawModel: string | undefined,
  authMode: CodexAuthMode | undefined,
  context1m: boolean | undefined,
): string | undefined {
  const trimmed = rawModel?.trim();
  const raw = trimmed && trimmed !== 'default' ? trimmed : undefined;
  if (!raw) return undefined;
  if (authMode === 'api_key') {
    if (context1m === true) return append1mSuffix(raw);
    if (context1m === false) return strip1mSuffix(raw);
    return raw;
  }
  // ChatGPT Plus/Pro OAuth uses model_context_window / model_auto_compact_token_limit, never `[1m]`.
  return context1m !== undefined ? strip1mSuffix(raw) : raw;
}
