import { readFile } from 'node:fs/promises';
import {
  parseDocument,
  resolveChannels,
  resolveExecutionProfile,
  resolveRun,
  type ConfigDocument,
} from '../../config/document';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { realpath } from 'node:fs/promises';
import { ChannelHost } from '../../channels/plugin';
import { createWebPlugin } from '../../channels/web/server';
import { WEB_SYSTEM_PROMPT } from '../../channels/web/runtime';
import { isAgentKind } from '../../agent/backends';
import type {
  AgentExecutionProfile,
  AgentKind,
  RunProfileConfig,
} from '../../config/profile-schema';
import { configureLogger, closeLogger } from '../../core/logger';
import { ProfileExecutionController } from '../../runtime/execution-controller';
import { checkRuntimeAgentAvailability } from '../../runtime/agent-runtime';
import { ScopeExecutionStore } from '../../session/scope-execution';
import { normalizeModelServices } from '../../model-service/config';
import { ModelProviderRegistry } from '../../model-provider/provider';

export interface RunWebOptions {
  agent?: string;
  profile?: string;
  config?: string;
  workspace: string;
  stateDir?: string;
  port?: string;
  binary?: string;
  model?: string;
}

/** Standalone browser channel: no Lark profile, credential bootstrap or SDK connection. */
export async function runWeb(options: RunWebOptions): Promise<void> {
  if (options.agent !== undefined && !isAgentKind(options.agent)) {
    throw new Error('agent must be claude, codex, or pi');
  }
  const port = options.port === undefined ? 8787 : Number(options.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('invalid port');
  const workspace = await realpath(resolve(options.workspace));
  const stateDir = resolve(options.stateDir ?? join(homedir(), '.lark-channel', 'web', 'default'));
  configureLogger({ logsDir: join(stateDir, 'logs') });
  const doc = options.config ? parseDocument(await readFile(options.config, 'utf8')) : undefined;
  const profile = selectWebProfile(doc, options.profile);
  const defaultAgentKind = selectDefaultAgent(doc, profile, options.agent);
  const profileConfig = webProfile(doc, profile, defaultAgentKind, workspace, options);
  const configForAgent = (kind: AgentKind): RunProfileConfig =>
    webProfile(doc, profile, kind, workspace, options, defaultAgentKind);

  const scopeExecution = new ScopeExecutionStore(join(stateDir, 'scope-execution.json'));
  await scopeExecution.load();
  const execution = new ProfileExecutionController({
    profileConfig,
    scopeExecution,
    appPaths: { profileDir: stateDir },
    systemPrompt: WEB_SYSTEM_PROMPT,
    modelProviders: new ModelProviderRegistry(normalizeModelServices(doc?.model_services)),
  });
  const initialAgent = execution.defaultAgent();
  const availability = await checkRuntimeAgentAvailability(initialAgent);
  if (!availability.ok) throw availability.error;

  const host = new ChannelHost();
  const connection = await host.connect(createWebPlugin({
    execution,
    config: configForAgent(defaultAgentKind),
    configForAgent,
    stateDir,
    namespace: 'web',
    systemPrompt: WEB_SYSTEM_PROMPT,
    port,
    display: doc ? resolveChannels(doc, profile).web : undefined,
  }));
  console.log(`Bridge Chat: ${connection.url} (engine: ${defaultAgentKind})`);
  await new Promise<void>((resolve, reject) => {
    let closing = false;
    const close = () => {
      if (closing) return;
      closing = true;
      process.off('SIGINT', close); process.off('SIGTERM', close);
      host.close().finally(closeLogger).then(resolve, reject);
    };
    process.on('SIGINT', close); process.on('SIGTERM', close);
  });
}

const WEB_FALLBACK_PERMISSIONS = {
  defaultAccess: 'workspace' as const,
  maxAccess: 'workspace' as const,
};
const WEB_PI_FALLBACK_PERMISSIONS = {
  defaultAccess: 'full' as const,
  maxAccess: 'full' as const,
};

function selectWebProfile(doc: ConfigDocument | undefined, requested?: string): string | undefined {
  if (!doc) {
    if (requested) throw new Error('--profile requires --config');
    return undefined;
  }
  const profile = requested ?? doc.bridge?.active_profile ?? Object.keys(doc.profiles)[0];
  if (profile && !doc.profiles[profile]) throw new Error(`profile not found: ${profile}`);
  return profile;
}

function selectDefaultAgent(
  doc: ConfigDocument | undefined,
  profile: string | undefined,
  requested: string | undefined,
): AgentKind {
  if (requested !== undefined) return requested as AgentKind;
  const selected = profile ? doc?.profiles[profile]?.agent : undefined;
  if (typeof selected === 'string' && isAgentKind(selected)) return selected;
  const first = doc ? Object.values(doc.profiles).find(entry => isAgentKind(entry.agent))?.agent : undefined;
  return typeof first === 'string' && isAgentKind(first) ? first : 'claude';
}

function webProfile(
  doc: ConfigDocument | undefined,
  profile: string | undefined,
  agentKind: AgentKind,
  workspace: string,
  options: RunWebOptions,
  initialAgentKind: AgentKind = agentKind,
): RunProfileConfig {
  const fallbackPermissions = agentKind === 'pi'
    ? WEB_PI_FALLBACK_PERMISSIONS
    : WEB_FALLBACK_PERMISSIONS;
  const execution = resolveExecutionProfile(doc ?? { version: 3, profiles: {} }, agentKind, {
    profile,
    fallbackPermissions,
  });
  const withBinary = options.binary && agentKind === initialAgentKind
    ? applyBinaryOverride(execution, agentKind, options.binary)
    : execution;
  const profileLayer = profile && doc?.profiles[profile]?.agent === agentKind ? profile : undefined;
  const preferences = {
    maxConcurrentRuns: 4,
    ...(doc ? resolveRun(doc, agentKind, profileLayer).preferences : {}),
    ...(options.model && agentKind === initialAgentKind ? { model: options.model } : {}),
  };
  return {
    ...withBinary,
    preferences,
    workspaces: { default: workspace },
    access: { allowedUsers: ['local'], allowedChats: [], admins: [], requireMentionInGroup: false },
    attachments: { maxCount: 0, maxBytes: 0, maxFileBytes: 0, imageMaxBytes: 0, cacheTtlMs: 0, cacheMaxBytes: 0 },
  };
}

function applyBinaryOverride(
  profile: AgentExecutionProfile,
  kind: AgentKind,
  binary: string,
): AgentExecutionProfile {
  if (kind === 'codex') {
    return { ...profile, codex: { ...(profile.codex ?? { binaryPath: binary }), binaryPath: binary } };
  }
  if (kind === 'pi') return { ...profile, pi: { ...(profile.pi ?? { binaryPath: binary }), binaryPath: binary } };
  return { ...profile, claude: { ...(profile.claude ?? {}), binaryPath: binary } };
}
