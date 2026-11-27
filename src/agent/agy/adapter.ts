import { preparedRun, snapshotRunOptions } from '../prepared-run';
import type { PreparedAgentRun } from '../types';
import { isAbsolute } from 'node:path';
import { mergeProcessEnv } from '../../platform/spawn';
import type { AgentAuthMode } from '../launch-options';
import { SpawnFailed } from '../errors';
import { checkAgentAvailability, type AgentAvailability } from '../preflight';
import { withExecutionContract } from '../execution';
import { parseEffort } from '../model-settings';
import { append1mSuffix, resolveModelArg, strip1mSuffix, validateModelId } from '../models';
import { startProcessRun } from '../process-run';
import { resolveSystemPrompt, type AgentSystemPrompt } from '../system-prompt';
import type { AgentAdapter, AgentBotIdentity, AgentExecutionCapabilities, AgentRun, AgentRunOptions } from '../types';
import { AgyStreamTranslator } from './stream-json';
import { agyProviderLaunch, DEFAULT_AGY_CONTEXT_WINDOW } from './provider';

export type AgyAuthMode = AgentAuthMode;

export const AGY_OAUTH_SCRUB_ENV = Object.freeze([
  'GEMINI_API_KEY',
  'GOOGLE_GEMINI_BASE_URL',
] as const);

export const AGY_EXECUTION_CAPABILITIES: AgentExecutionCapabilities = Object.freeze({
  finalAnswer: 'separate-event', input: 'unsupported',
});

export interface AgyAdapterOptions {
  binary?: string;
  authMode?: AgyAuthMode;
  /** Explicit Gemini API key used in `api_key` mode (injected as GEMINI_API_KEY). */
  apiKey?: string;
  /** Optional custom Gemini base URL used in `api_key` mode (GOOGLE_GEMINI_BASE_URL). */
  baseUrl?: string;
  /** Optional default model override when per-run `options.model` is omitted. */
  model?: string;
  /** Optional context window size when configuring a custom Gemini endpoint in `api_key` mode. */
  contextWindow?: number;
  /** Enable 1M context window routing when supported. */
  context1m?: boolean;
  /** Additional workspace directories to pass via `--add-dir` in `workspace-write` mode. */
  additionalDirs?: readonly string[];
  unsetEnv?: readonly string[];
  env?: NodeJS.ProcessEnv;
  systemPrompt?: AgentSystemPrompt;
}

export class AgyAdapter implements AgentAdapter {
  readonly id = 'agy';
  readonly displayName = 'Antigravity CLI';
  readonly capabilities = AGY_EXECUTION_CAPABILITIES;
  private botIdentity?: AgentBotIdentity;

  constructor(private readonly options: AgyAdapterOptions = {}) {}
  setBotIdentity(identity: AgentBotIdentity): void { this.botIdentity = identity; }
  async isAvailable(): Promise<boolean> { return (await this.checkAvailability()).ok; }
  checkAvailability(): Promise<AgentAvailability> {
    const binary = this.options.binary ?? 'agy';
    const unsetEnv = this.options.authMode === 'oauth' || this.options.authMode === 'api_key'
      ? [...(this.options.unsetEnv ?? []), ...AGY_OAUTH_SCRUB_ENV]
      : this.options.unsetEnv;
    return checkAgentAvailability({
      agentId: 'agy',
      agentName: this.displayName,
      command: binary,
      binaryPath: binary,
      env: this.options.env,
      unsetEnv,
      minimumVersion: '1.4.10',
    });
  }
  async prepareRun(input: AgentRunOptions): Promise<PreparedAgentRun> {
    const context1m = input.context1m ?? this.options.context1m;
    const rawModel = resolveModelArg('agy', input.model ?? this.options.model);
    const model = resolveAgyEffectiveModel(rawModel, this.options.authMode, context1m);
    const options = snapshotRunOptions({
      ...input,
      ...(model !== undefined ? { model } : {}),
      ...(context1m !== undefined ? { context1m } : {}),
      systemPrompt: input.systemPrompt ?? resolveSystemPrompt(this.options.systemPrompt, this.botIdentity),
    });
    validateRun(options, this.options);
    const availability = await this.checkAvailability();
    if (!availability.ok) throw new SpawnFailed('agy binary check failed', availability.error,
      availability.diagnostic.code, availability.diagnostic);
    return preparedRun({ model: options.model, reasoningEffort: options.reasoningEffort }, () => this.runNative(options));
  }
  private runNative(options: AgentRunOptions): AgentRun {
    validateRun(options, this.options);
    const sandbox = options.sandbox ?? 'danger-full-access';
    const context1m = options.context1m ?? this.options.context1m;
    const provider = options.modelProvider ? agyProviderLaunch(options.modelProvider) : undefined;
    const authMode = this.options.authMode;
    const explicitApiKey = this.options.apiKey?.trim()
      || readEnvCI(this.options.env, 'GEMINI_API_KEY')
      || readEnvCI(options.env, 'GEMINI_API_KEY');
    const explicitBaseUrl = this.options.baseUrl?.trim()
      || readEnvCI(this.options.env, 'GOOGLE_GEMINI_BASE_URL')
      || readEnvCI(options.env, 'GOOGLE_GEMINI_BASE_URL');
    const rawRequested = resolveModelArg('agy', options.model ?? this.options.model);
    const requestedModel = resolveAgyEffectiveModel(rawRequested, authMode, context1m);
    if (requestedModel) validateModelId(requestedModel);

    let customLaunch: {
      model?: string;
      env: NodeJS.ProcessEnv;
      settings: Record<string, unknown>;
    } | undefined;
    if (!provider && authMode === 'api_key') {
      const contextWindow = context1m === true
        ? DEFAULT_AGY_CONTEXT_WINDOW
        : (this.options.contextWindow ?? DEFAULT_AGY_CONTEXT_WINDOW);
      customLaunch = {
        ...(requestedModel ? { model: requestedModel } : {}),
        env: {
          GEMINI_API_KEY: explicitApiKey,
          ...(explicitBaseUrl ? { GOOGLE_GEMINI_BASE_URL: explicitBaseUrl } : {}),
          AGY_ADC_AUTH: undefined,
        },
        settings: {
          modelProvider: 'gemini',
          ...(explicitBaseUrl && requestedModel ? {
            customModelsConfig: {
              customModels: {
                [requestedModel]: {
                  modelName: `gemini-api://${requestedModel}`,
                  label: requestedModel,
                  maxTokens: contextWindow,
                },
              },
            },
          } : {}),
        },
      };
    }

    const activeLaunch = provider ?? customLaunch;
    const settingsObj = {
      ...activeLaunch?.settings,
      artifactReviewPolicy: 'always-proceed',
      allowNonWorkspaceAccess: sandbox === 'danger-full-access',
    };
    const args = ['--input-format', 'stream-json', '--output-format', 'stream-json',
      '--disable-slash-commands', '--print-timeout', '0'];
    if (sandbox === 'read-only') {
      args.push('--mode', 'plan');
    } else if (sandbox === 'workspace-write') {
      args.push('--sandbox', '--dangerously-skip-permissions');
      const dirs = [...new Set((options.additionalDirs ?? this.options.additionalDirs ?? []).map((d) => d.trim()).filter(Boolean))];
      for (const dir of dirs) args.push('--add-dir', dir);
    } else {
      args.push('--dangerously-skip-permissions');
    }
    args.push('--settings', JSON.stringify(settingsObj));
    if (options.sessionId) args.push('--conversation', options.sessionId);
    const model = provider?.model ?? customLaunch?.model ?? requestedModel;
    if (model) args.push('--model', model);
    if (options.reasoningEffort) args.push('--effort', parseEffort(options.reasoningEffort, 'agy')!);
    const instructions = options.systemPrompt ?? resolveSystemPrompt(this.options.systemPrompt, this.botIdentity);
    const attachments = options.images?.length ? `\n\nAttached image files (absolute paths):\n${JSON.stringify(options.images)}` : '';
    const content = `${instructions}\n\n${options.prompt}${attachments}`;

    let spawnEnv: NodeJS.ProcessEnv;
    if (authMode === 'oauth') {
      spawnEnv = mergeProcessEnv(
        mergeProcessEnv(mergeProcessEnv(process.env, this.options.env), options.env),
        {},
        [...(this.options.unsetEnv ?? []), ...AGY_OAUTH_SCRUB_ENV],
      );
    } else if (authMode === 'api_key') {
      const cleanBase = mergeProcessEnv(
        process.env,
        {},
        [...(this.options.unsetEnv ?? []), ...AGY_OAUTH_SCRUB_ENV],
      );
      spawnEnv = mergeProcessEnv(
        mergeProcessEnv(mergeProcessEnv(cleanBase, this.options.env), activeLaunch?.env),
        options.env,
        this.options.unsetEnv,
      );
    } else {
      spawnEnv = mergeProcessEnv(
        mergeProcessEnv(mergeProcessEnv(process.env, this.options.env), activeLaunch?.env),
        options.env,
        this.options.unsetEnv,
      );
    }

    return withExecutionContract(startProcessRun({
      agent: this.id, runId: options.runId, command: this.options.binary ?? 'agy', args,
      cwd: options.cwd!, env: spawnEnv,
      stdin: `${JSON.stringify({ event: 'user', message: { content } })}\n`,
      translator: new AgyStreamTranslator(options.answerIncludesInterimText === true), strictJson: true,
      deadlineAt: options.deadlineAt, execSandbox: options.execSandbox, signalCell: options.signalCell, stopGraceMs: options.stopGraceMs ?? 1000, stopSignal: 'SIGINT',
    }), this.capabilities);
  }
}

function validateRun(options: AgentRunOptions, adapterOptions: AgyAdapterOptions): void {
  if (!options.cwd) throw new Error('cwd is required for AgyAdapter.run');
  if (options.forkSession) throw new Error('Antigravity headless mode does not support conversation forks');
  if (adapterOptions.authMode === 'oauth' && options.modelProvider) {
    throw new Error('Antigravity oauth mode cannot be combined with a modelProvider binding');
  }
  if (options.modelProvider && !options.modelProvider.agy) throw new Error('Antigravity requires a native Gemini provider binding');
  if (adapterOptions.authMode === 'api_key' && !options.modelProvider) {
    const key = adapterOptions.apiKey?.trim()
      || readEnvCI(adapterOptions.env, 'GEMINI_API_KEY')
      || readEnvCI(options.env, 'GEMINI_API_KEY');
    if (!key) {
      throw new Error('Antigravity api_key authMode requires apiKey, modelProvider, or GEMINI_API_KEY in env');
    }
  }
  const sandbox = options.sandbox ?? 'danger-full-access';
  if (!['read-only', 'workspace-write', 'danger-full-access'].includes(sandbox)) {
    throw new Error(`unsafe sandbox mode: ${sandbox}`);
  }
  const additionalDirs = options.additionalDirs ?? adapterOptions.additionalDirs;
  if (additionalDirs?.some((dir) => !isAbsolute(dir))) {
    throw new Error('Antigravity additionalDirs paths must be absolute');
  }
  if (options.sessionId && !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,255}$/.test(options.sessionId)) throw new Error('Invalid Antigravity conversation ID');
  if (options.images?.some(path => !isAbsolute(path))) throw new Error('Antigravity image paths must be absolute');
}

function resolveAgyEffectiveModel(
  rawModel: string | undefined,
  authMode: AgyAuthMode | undefined,
  context1m: boolean | undefined,
): string | undefined {
  if (!rawModel) return undefined;
  if (authMode === 'api_key') {
    if (context1m === true) return append1mSuffix(rawModel);
    if (context1m === false) return strip1mSuffix(rawModel);
    return rawModel;
  }
  // Google OAuth Gemini models are natively 1M; never append `[1m]` to their model ID.
  return context1m !== undefined ? strip1mSuffix(rawModel) : rawModel;
}

function readEnvCI(env: Readonly<NodeJS.ProcessEnv> | undefined, name: string): string | undefined {
  if (!env) return undefined;
  if (env[name] !== undefined) return env[name];
  const wanted = name.toLowerCase();
  return Object.entries(env).find(([key]) => key.toLowerCase() === wanted)?.[1];
}
