import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentKind } from '../config/profile-schema';
import { mergeProcessEnv, spawnProcess } from '../platform/spawn';
import { terminateChild } from '../platform/terminate';
import { AGY_OAUTH_SCRUB_ENV } from './agy/adapter';
import { parseAgyModels } from './agy/models';
import { agentBackendSpec, isRegisteredAgentKind } from './backend-spec';
import { CLAUDE_OAUTH_SCRUB_ENV } from './claude/adapter';
import { CODEX_OAUTH_SCRUB_ENV } from './codex/adapter';
import type { AgentAuthMode } from './launch-options';
import { checkAgentAvailability } from './preflight';

export type AgentAuthProbeState = 'configured' | 'missing' | 'unknown';

export interface ProbeAgentAuthOptions {
  binary?: string;
  binaryPath?: string;
  authMode?: AgentAuthMode;
  configDir?: string;
  codexHome?: string;
  inheritCodexHome?: boolean;
  profileDir?: string;
  apiKey?: string;
  authToken?: string;
  baseUrl?: string;
  endpoint?: string;
  models?: readonly unknown[];
  packageRoot?: string;
  home?: string;
  env?: NodeJS.ProcessEnv;
  unsetEnv?: readonly string[];
  timeoutMs?: number;
  minimumVersion?: string;
}

export interface AgentAuthProbeResult {
  kind: AgentKind;
  authMode: AgentAuthMode;
  available: boolean;
  version?: string;
  reason?: string;
  credentialState: AgentAuthProbeState;
  detail?: string;
}

const DEFAULT_PROBE_TIMEOUT_MS = 10_000;
const OUTPUT_LIMIT_BYTES = 65_536;

/**
 * Probe binary availability and local authentication readiness for a registered harness.
 * In `oauth` mode, ambient API-key env vars are scrubbed before invoking the CLI.
 */
export async function probeAgentAuth(
  kind: AgentKind | string,
  options: ProbeAgentAuthOptions = {},
): Promise<AgentAuthProbeResult> {
  if (!isRegisteredAgentKind(kind)) {
    throw new Error(`Unknown agent kind: ${String(kind)}`);
  }
  const authMode: AgentAuthMode = options.authMode ?? (kind === 'dsh' ? 'api_key' : 'oauth');
  if (kind === 'dsh') {
    return probeDshReadiness(authMode, options);
  }

  const spec = agentBackendSpec(kind);
  const command = options.binary ?? options.binaryPath ?? process.env[spec.commandEnv] ?? spec.defaultCommand;
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const { env: envOverrides, unsetEnv, hasApiKey } = buildProbeEnv(kind, authMode, options);

  const availability = await checkAgentAvailability({
    agentId: kind,
    agentName: spec.displayName,
    command,
    binaryPath: command,
    env: envOverrides,
    unsetEnv,
    timeoutMs,
    minimumVersion: options.minimumVersion ?? (kind === 'agy' ? '1.4.10' : undefined),
  });

  if (!availability.ok) {
    const credentialState: AgentAuthProbeState = authMode === 'api_key'
      ? (hasApiKey ? 'configured' : 'missing')
      : 'unknown';
    return {
      kind,
      authMode,
      available: false,
      reason: availability.diagnostic.code,
      credentialState,
      detail: availability.error.message,
    };
  }

  if (authMode === 'api_key') {
    return {
      kind,
      authMode,
      available: true,
      ...(availability.version ? { version: availability.version } : {}),
      credentialState: hasApiKey ? 'configured' : 'missing',
      ...(hasKeyReason(hasApiKey)),
    };
  }

  const childEnv = mergeProcessEnv(process.env, envOverrides, unsetEnv);
  if (kind === 'claude') {
    const status = await probeClaudeOauth(command, childEnv, timeoutMs);
    return {
      kind,
      authMode,
      available: true,
      ...(availability.version ? { version: availability.version } : {}),
      ...status,
    };
  }
  if (kind === 'codex') {
    const status = await probeCodexOauth(command, childEnv, timeoutMs);
    return {
      kind,
      authMode,
      available: true,
      ...(availability.version ? { version: availability.version } : {}),
      ...status,
    };
  }
  if (kind === 'agy') {
    const status = await probeAgyOauth(command, childEnv, timeoutMs);
    return {
      kind,
      authMode,
      available: true,
      ...(availability.version ? { version: availability.version } : {}),
      ...status,
    };
  }
  return {
    kind,
    authMode,
    available: true,
    ...(availability.version ? { version: availability.version } : {}),
    credentialState: 'unknown',
  };
}

function hasKeyReason(hasKey: boolean): { reason?: string } {
  return hasKey ? {} : { reason: 'missing-api-key' };
}

function probeDshReadiness(
  authMode: AgentAuthMode,
  options: ProbeAgentAuthOptions,
): AgentAuthProbeResult {
  if (options.packageRoot && !existsSync(join(options.packageRoot, 'package.json'))) {
    return {
      kind: 'dsh',
      authMode,
      available: false,
      reason: 'harness-runtime-missing',
      credentialState: 'missing',
    };
  }
  const key = options.apiKey?.trim()
    || options.authToken?.trim()
    || readEnvCI(options.env, 'DEEPSEEK_API_KEY')?.trim()
    || readEnvCI(options.env, 'DSH_API_KEY')?.trim();
  const endpointRaw = options.endpoint ?? options.baseUrl;
  if (endpointRaw !== undefined && !endpointRaw.trim()) {
    return { kind: 'dsh', authMode, available: true, reason: 'missing-endpoint', credentialState: 'missing' };
  }
  if (options.models !== undefined && options.models.length === 0) {
    return { kind: 'dsh', authMode, available: true, reason: 'missing-models', credentialState: 'missing' };
  }
  if (!key) {
    return { kind: 'dsh', authMode, available: true, reason: 'not-configured', credentialState: 'missing' };
  }
  return { kind: 'dsh', authMode, available: true, credentialState: 'configured' };
}

function buildProbeEnv(
  kind: Exclude<AgentKind, 'dsh'>,
  authMode: AgentAuthMode,
  options: ProbeAgentAuthOptions,
): { env: NodeJS.ProcessEnv; unsetEnv: string[]; hasApiKey: boolean } {
  const baseEnv: NodeJS.ProcessEnv = { ...options.env };
  const explicitUnset = new Set<string>(options.unsetEnv ?? []);
  for (const [k, v] of Object.entries(baseEnv)) {
    if (v === undefined) {
      explicitUnset.add(k);
      delete baseEnv[k];
    }
  }

  if (kind === 'claude') {
    if (options.configDir) baseEnv.CLAUDE_CONFIG_DIR = options.configDir;
    if (authMode === 'oauth') {
      for (const key of CLAUDE_OAUTH_SCRUB_ENV) explicitUnset.add(key);
      return { env: baseEnv, unsetEnv: [...explicitUnset], hasApiKey: false };
    }
    if (options.apiKey?.trim()) baseEnv.ANTHROPIC_API_KEY = options.apiKey.trim();
    if (options.authToken?.trim()) baseEnv.ANTHROPIC_AUTH_TOKEN = options.authToken.trim();
    if (options.baseUrl?.trim()) baseEnv.ANTHROPIC_BASE_URL = options.baseUrl.trim();
    for (const key of CLAUDE_OAUTH_SCRUB_ENV) {
      if (!readEnvCI(baseEnv, key)) explicitUnset.add(key);
    }
    const hasApiKey = Boolean(
      readEnvCI(baseEnv, 'ANTHROPIC_API_KEY')?.trim()
      || readEnvCI(baseEnv, 'ANTHROPIC_AUTH_TOKEN')?.trim(),
    );
    return { env: baseEnv, unsetEnv: [...explicitUnset], hasApiKey };
  }

  if (kind === 'codex') {
    const resolvedHome = options.codexHome
      ?? (authMode === 'oauth'
        ? (options.inheritCodexHome === false && options.profileDir
            ? join(options.profileDir, 'codex-home')
            : readEnvCI(baseEnv, 'CODEX_HOME') ?? process.env.CODEX_HOME ?? join(homedir(), '.codex'))
        : (options.profileDir ? join(options.profileDir, 'codex-home') : undefined));
    if (resolvedHome) baseEnv.CODEX_HOME = resolvedHome;
    if (authMode === 'oauth') {
      for (const key of CODEX_OAUTH_SCRUB_ENV) explicitUnset.add(key);
      return { env: baseEnv, unsetEnv: [...explicitUnset], hasApiKey: false };
    }
    if (options.apiKey?.trim()) baseEnv.OPENAI_API_KEY = options.apiKey.trim();
    if (options.baseUrl?.trim()) baseEnv.OPENAI_BASE_URL = options.baseUrl.trim();
    for (const key of CODEX_OAUTH_SCRUB_ENV) {
      if (!readEnvCI(baseEnv, key)) explicitUnset.add(key);
    }
    const hasApiKey = Boolean(readEnvCI(baseEnv, 'OPENAI_API_KEY')?.trim());
    return { env: baseEnv, unsetEnv: [...explicitUnset], hasApiKey };
  }

  if (kind === 'agy') {
    if (authMode === 'oauth') {
      for (const key of AGY_OAUTH_SCRUB_ENV) explicitUnset.add(key);
      return { env: baseEnv, unsetEnv: [...explicitUnset], hasApiKey: false };
    }
    if (options.apiKey?.trim()) baseEnv.GEMINI_API_KEY = options.apiKey.trim();
    if (options.baseUrl?.trim()) baseEnv.GOOGLE_GEMINI_BASE_URL = options.baseUrl.trim();
    explicitUnset.add('AGY_ADC_AUTH');
    for (const key of AGY_OAUTH_SCRUB_ENV) {
      if (!readEnvCI(baseEnv, key)) explicitUnset.add(key);
    }
    const hasApiKey = Boolean(readEnvCI(baseEnv, 'GEMINI_API_KEY')?.trim());
    return { env: baseEnv, unsetEnv: [...explicitUnset], hasApiKey };
  }

  // pi
  if (options.apiKey?.trim()) baseEnv.OPENAI_API_KEY = options.apiKey.trim();
  const hasApiKey = Boolean(
    options.apiKey?.trim()
    || readEnvCI(baseEnv, 'OPENAI_API_KEY')?.trim()
    || readEnvCI(baseEnv, 'ANTHROPIC_API_KEY')?.trim(),
  );
  return { env: baseEnv, unsetEnv: [...explicitUnset], hasApiKey };
}

async function probeClaudeOauth(
  command: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<{ credentialState: AgentAuthProbeState; reason?: string }> {
  const res = await runProbeCommand(command, ['auth', 'status', '--json'], env, timeoutMs);
  if (res.timedOut || res.spawnError) return { credentialState: 'unknown', reason: 'auth-probe-failed' };
  const parsed = parseJsonObject(res.stdout);
  if (parsed && typeof parsed.loggedIn === 'boolean') {
    return parsed.loggedIn
      ? { credentialState: 'configured' }
      : { credentialState: 'missing', reason: 'not-logged-in' };
  }
  if (res.exitCode === 0) return { credentialState: 'configured' };
  if (res.exitCode === 1) return { credentialState: 'missing', reason: 'not-logged-in' };
  return { credentialState: 'unknown', reason: 'auth-probe-failed' };
}

async function probeCodexOauth(
  command: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<{ credentialState: AgentAuthProbeState; reason?: string }> {
  const res = await runProbeCommand(command, ['login', 'status'], env, timeoutMs);
  if (res.timedOut || res.spawnError) return { credentialState: 'unknown', reason: 'auth-probe-failed' };
  const combined = `${res.stdout}\n${res.stderr}`;
  if (/\bnot\s+logged\s+in\b/i.test(combined) || res.exitCode === 1) {
    return { credentialState: 'missing', reason: 'not-logged-in' };
  }
  if (res.exitCode === 0) return { credentialState: 'configured' };
  return { credentialState: 'unknown', reason: 'auth-probe-failed' };
}

async function probeAgyOauth(
  command: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<{ credentialState: AgentAuthProbeState; reason?: string }> {
  const authRes = await runProbeCommand(command, ['auth', 'status'], env, timeoutMs);
  if (!authRes.timedOut && !authRes.spawnError) {
    const parsed = parseJsonObject(authRes.stdout);
    const loggedFlag = parsed && (
      typeof parsed.loggedIn === 'boolean' ? parsed.loggedIn
        : typeof parsed.authenticated === 'boolean' ? parsed.authenticated
          : undefined
    );
    if (loggedFlag !== undefined) {
      return loggedFlag
        ? { credentialState: 'configured' }
        : { credentialState: 'missing', reason: 'not-logged-in' };
    }
    const combined = `${authRes.stdout}\n${authRes.stderr}`;
    const unknownSubcommand = authRes.exitCode !== 0 && /unknown command|unknown option|unrecognized|invalid command|usage:/i.test(combined);
    if (!unknownSubcommand) {
      if (/\b(?:not\s+logged\s+in|not\s+signed\s+in|unauthenticated|login\s+required)\b/i.test(combined) || authRes.exitCode === 1) {
        return { credentialState: 'missing', reason: 'not-logged-in' };
      }
      if (authRes.exitCode === 0) return { credentialState: 'configured' };
    }
  }

  const modelsRes = await runProbeCommand(command, ['models'], env, timeoutMs);
  if (modelsRes.timedOut || modelsRes.spawnError) {
    return { credentialState: 'unknown', reason: 'auth-probe-failed' };
  }
  if (modelsRes.exitCode === 0 && parseAgyModels(modelsRes.stdout).length > 0) {
    return { credentialState: 'configured' };
  }
  const combined = `${modelsRes.stdout}\n${modelsRes.stderr}`;
  if (/\b(?:not\s+logged\s+in|not\s+signed\s+in|unauthenticated|unauthorized|login|sign\s*in|credentials?)\b/i.test(combined)) {
    return { credentialState: 'missing', reason: 'not-logged-in' };
  }
  return { credentialState: 'unknown', reason: 'auth-probe-failed' };
}

interface ProbeCommandOutput {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnError: boolean;
}

function runProbeCommand(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<ProbeCommandOutput> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnProcess(command, [...args], {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      resolve({ exitCode: null, stdout: '', stderr: '', timedOut: false, spawnError: true });
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result: ProbeCommandOutput) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      terminateChild(child, 'SIGTERM');
      finish({ exitCode: null, stdout, stderr, timedOut: true, spawnError: false });
    }, timeoutMs);
    timer.unref?.();

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < OUTPUT_LIMIT_BYTES) stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < OUTPUT_LIMIT_BYTES) stderr += chunk.toString('utf8');
    });
    child.once('error', () => {
      finish({ exitCode: null, stdout, stderr, timedOut: false, spawnError: true });
    });
    child.once('close', (exitCode) => {
      finish({ exitCode, stdout, stderr, timedOut: false, spawnError: false });
    });
  });
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function readEnvCI(env: Readonly<NodeJS.ProcessEnv> | undefined, name: string): string | undefined {
  if (!env) return undefined;
  if (env[name] !== undefined) return env[name];
  const wanted = name.toLowerCase();
  return Object.entries(env).find(([key]) => key.toLowerCase() === wanted)?.[1];
}
