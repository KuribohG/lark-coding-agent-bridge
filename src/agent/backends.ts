import { ClaudeAdapter } from './claude/adapter';
import { CLAUDE_EXECUTION_CAPABILITIES } from './claude/capabilities';
import { CodexAdapter } from './codex/adapter';
import { codexExecutionCapabilities } from './codex/capabilities';
import { PiAdapter } from './pi/adapter';
import { PI_EXECUTION_CAPABILITIES } from './pi/capabilities';
import {
  agentLaunchPatch,
  capabilityForBackend,
  type AgentCapability,
} from './capability';
import {
  AGENT_BACKEND_SPECS,
  AGENT_KINDS,
  agentDisplayName,
  isAgentKind,
  type AgentBackendSpec,
} from './backend-spec';
import type { AgentAdapter, AgentExecutionCapabilities } from './types';
import type { AgentSystemPrompt } from './system-prompt';
import type { AgentExecutionProfile, AgentKind } from '../config/profile-schema';
import { accessToCodexSandbox } from '../config/permissions';
import { buildAgentEnvironment } from './launch-env';

export interface AgentBackend extends AgentBackendSpec {
  capability(profile: Pick<AgentExecutionProfile, 'agentKind' | 'permissions'>): AgentCapability;
  executionCapabilities(
    profile: Pick<AgentExecutionProfile, 'agentKind' | 'permissions'>,
  ): AgentExecutionCapabilities;
  existingProfile(profile: AgentExecutionProfile): Partial<AgentExecutionProfile>;
  launchPatch(binaryPath: string): Pick<AgentExecutionProfile, 'claude' | 'codex' | 'pi'>;
  createAdapter(input: CreateAgentAdapterInput): AgentAdapter;
}

export interface CreateAgentAdapterInput {
  profile: AgentExecutionProfile;
  profileDir: string;
  env: NodeJS.ProcessEnv;
  systemPrompt: AgentSystemPrompt;
}

const BACKENDS: Record<AgentKind, AgentBackend> = {
  claude: {
    ...AGENT_BACKEND_SPECS.claude,
    capability: (profile) => capabilityForBackend('claude', profile),
    executionCapabilities: () => CLAUDE_EXECUTION_CAPABILITIES,
    existingProfile: (profile) => profile.claude ? { claude: profile.claude } : {},
    launchPatch: (binaryPath) => agentLaunchPatch('claude', binaryPath),
    createAdapter: ({ profile, env, systemPrompt }) => new ClaudeAdapter({
      binary: profile.claude?.binaryPath,
      configDir: profile.claude?.configDir,
      env: buildAgentEnvironment(env, profile.claude?.env),
      systemPrompt,
    }),
  },
  codex: {
    ...AGENT_BACKEND_SPECS.codex,
    capability: (profile) => capabilityForBackend('codex', profile),
    executionCapabilities: () => codexExecutionCapabilities(),
    existingProfile: (profile) => profile.codex ? { codex: profile.codex } : {},
    launchPatch: (binaryPath) => agentLaunchPatch('codex', binaryPath),
    createAdapter: ({ profile, profileDir, env, systemPrompt }) => {
      const codex = profile.codex;
      if (!codex?.binaryPath) throw new Error('codex profile requires codex.binaryPath');
      return new CodexAdapter({
        binary: codex.binaryPath,
        systemPrompt,
        transport: codex.transport,
        appServerMode: codex.appServerMode,
        profileStateDir: profileDir,
        ...(codex.codexHome ? { codexHome: codex.codexHome } : {}),
        inheritCodexHome: codex.inheritCodexHome !== false,
        ignoreUserConfig: codex.ignoreUserConfig === true,
        ignoreRules: codex.ignoreRules,
        sandbox: profile.sandbox?.defaultMode ?? accessToCodexSandbox(profile.permissions.defaultAccess),
        env: buildAgentEnvironment(env, codex.env),
      });
    },
  },
  pi: {
    ...AGENT_BACKEND_SPECS.pi,
    capability: (profile) => capabilityForBackend('pi', profile),
    executionCapabilities: () => PI_EXECUTION_CAPABILITIES,
    existingProfile: (profile) => profile.pi ? { pi: profile.pi } : {},
    launchPatch: (binaryPath) => agentLaunchPatch('pi', binaryPath),
    createAdapter: ({ profile, profileDir, env, systemPrompt }) => {
      const pi = profile.pi;
      if (!pi?.binaryPath) throw new Error('pi profile requires pi.binaryPath');
      return new PiAdapter({
        binary: pi.binaryPath,
        agentDir: pi.agentDir,
        profileStateDir: profileDir,
        env: buildAgentEnvironment(env, pi.env),
        systemPrompt,
      });
    },
  },
};

export { AGENT_KINDS };
export const AGENT_OPTIONS = Object.freeze(AGENT_KINDS.map((kind) => ({
  value: kind,
  label: BACKENDS[kind].displayName,
})));

export function backendFor(kind: AgentKind): AgentBackend {
  return BACKENDS[kind];
}

export { agentDisplayName, isAgentKind };

export function capabilityForProfile(
  profile: Pick<AgentExecutionProfile, 'agentKind' | 'permissions'>,
): AgentCapability {
  return backendFor(profile.agentKind).capability(profile);
}

export function executionCapabilitiesForProfile(
  profile: Pick<AgentExecutionProfile, 'agentKind' | 'permissions'>,
): AgentExecutionCapabilities {
  return backendFor(profile.agentKind).executionCapabilities(profile);
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
