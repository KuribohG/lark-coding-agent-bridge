import { ClaudeAdapter } from './claude/adapter';
import { CLAUDE_EXECUTION_CAPABILITIES } from './claude/capabilities';
import { CodexAdapter } from './codex/adapter';
import { codexExecutionCapabilities } from './codex/capabilities';
import { PiAdapter } from './pi/adapter';
import { PI_EXECUTION_CAPABILITIES } from './pi/capabilities';
import {
  claudeCapability,
  codexCapability,
  piCapability,
  type AgentCapability,
} from './capability';
import type { AgentAdapter, AgentExecutionCapabilities } from './types';
import type { AgentSystemPrompt } from './system-prompt';
import type { AgentKind, ProfileConfig } from '../config/profile-schema';

export interface AgentBackend {
  readonly kind: AgentKind;
  readonly displayName: string;
  readonly defaultCommand: string;
  readonly commandEnv: string;
  capability(profile: Pick<ProfileConfig, 'agentKind' | 'permissions'>): AgentCapability;
  executionCapabilities(
    profile: Pick<ProfileConfig, 'agentKind' | 'permissions'>,
  ): AgentExecutionCapabilities;
  createAdapter(input: CreateAgentAdapterInput): AgentAdapter;
}

export interface CreateAgentAdapterInput {
  profile: ProfileConfig;
  profileDir: string;
  env: NodeJS.ProcessEnv;
  systemPrompt: AgentSystemPrompt;
}

const BACKENDS: Record<AgentKind, AgentBackend> = {
  claude: {
    kind: 'claude',
    displayName: 'Claude Code',
    defaultCommand: 'claude',
    commandEnv: 'LARK_CHANNEL_CLAUDE_BIN',
    capability: claudeCapability,
    executionCapabilities: () => CLAUDE_EXECUTION_CAPABILITIES,
    createAdapter: ({ profile, env, systemPrompt }) => new ClaudeAdapter({
      binary: profile.claude?.binaryPath,
      env,
      systemPrompt,
    }),
  },
  codex: {
    kind: 'codex',
    displayName: 'Codex CLI',
    defaultCommand: 'codex',
    commandEnv: 'LARK_CHANNEL_CODEX_BIN',
    capability: codexCapability,
    executionCapabilities: () => codexExecutionCapabilities(),
    createAdapter: ({ profile, profileDir, env, systemPrompt }) => {
      const codex = profile.codex;
      if (!codex?.binaryPath) throw new Error('codex profile requires codex.binaryPath');
      return new CodexAdapter({
        binary: codex.binaryPath,
        systemPrompt,
        transport: codex.transport,
        profileStateDir: profileDir,
        ...(codex.codexHome ? { codexHome: codex.codexHome } : {}),
        inheritCodexHome: codex.inheritCodexHome === true,
        ignoreUserConfig: codex.ignoreUserConfig === true,
        ignoreRules: codex.ignoreRules,
        sandbox: profile.sandbox.defaultMode,
        env,
      });
    },
  },
  pi: {
    kind: 'pi',
    displayName: 'Pi Coding Agent',
    defaultCommand: 'pi',
    commandEnv: 'LARK_CHANNEL_PI_BIN',
    capability: piCapability,
    executionCapabilities: () => PI_EXECUTION_CAPABILITIES,
    createAdapter: ({ profile, env, systemPrompt }) => {
      const pi = profile.pi;
      if (!pi?.binaryPath) throw new Error('pi profile requires pi.binaryPath');
      return new PiAdapter({ binary: pi.binaryPath, env, systemPrompt });
    },
  },
};

export const AGENT_BACKENDS = Object.freeze(BACKENDS);
export const AGENT_KINDS = Object.freeze(Object.keys(BACKENDS) as AgentKind[]);

export function backendFor(kind: AgentKind): AgentBackend {
  return BACKENDS[kind];
}

export function isAgentKind(value: string): value is AgentKind {
  return Object.prototype.hasOwnProperty.call(BACKENDS, value);
}

export function capabilityForProfile(
  profile: Pick<ProfileConfig, 'agentKind' | 'permissions'>,
): AgentCapability {
  return backendFor(profile.agentKind).capability(profile);
}

export function executionCapabilitiesForProfile(
  profile: Pick<ProfileConfig, 'agentKind' | 'permissions'>,
): AgentExecutionCapabilities {
  return backendFor(profile.agentKind).executionCapabilities(profile);
}

export function agentDisplayName(kind: AgentKind): string {
  return backendFor(kind).displayName;
}

export function detectedAgentCandidates(): Array<{
  kind: AgentKind;
  command: string;
}> {
  return AGENT_KINDS.map((kind) => {
    const backend = backendFor(kind);
    return {
      kind,
      command: process.env[backend.commandEnv] ?? backend.defaultCommand,
    };
  });
}

export function createAgentAdapter(input: CreateAgentAdapterInput): AgentAdapter {
  return backendFor(input.profile.agentKind).createAdapter(input);
}
