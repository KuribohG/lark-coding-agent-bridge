import type { ModelProtocol } from '../model-service/config';
export type AgentKind = 'claude' | 'codex' | 'pi' | 'agy' | 'dsh';
export type AgentAccessMode = 'read-only' | 'workspace' | 'full';
export type AgentCapabilityId = AgentKind;
export type AgentSessionKind = `${AgentKind}-session` | 'codex-thread';
export type AgentSessionIdField = 'sessionId' | 'threadId';
export type AgentImageInput = 'paths' | 'attachments';
export type PromptInjectionMode = 'append-system-prompt' | 'stdin-prefix';
export type AgentHistorySource = 'codex-thread-list' | 'claude-jsonl' | 'catalog';
export type AgentPermissionView = 'permission' | 'sandbox' | 'tools';
export type AgentModelCatalog = AgentKind;
export type AgentProviderBinding = 'codex-config' | 'pi-extension' | 'agy-gemini';

export interface AgentStateDirectorySpec {
  field: string;
  envName: 'CLAUDE_CONFIG_DIR' | 'CODEX_HOME' | 'PI_CODING_AGENT_DIR';
}

/**
 * Static facts shared by configuration, runtime policy, commands and backend
 * construction. Native protocols and adapter construction remain backend-owned.
 */
export interface AgentBackendSpec {
  kind: AgentKind;
  displayName: string;
  shortDisplayName: string;
  defaultCommand: string;
  commandEnv: string;
  launchRequired: boolean;
  launchKeys: readonly string[];
  stateDirectory?: AgentStateDirectorySpec;
  includeStateDirectoryInPolicy: boolean;
  sessionKind: AgentSessionKind;
  sessionIdField: AgentSessionIdField;
  imageInput: AgentImageInput;
  legacySessionStore: boolean;
  promptInjection: PromptInjectionMode;
  supportsNativeHistory: boolean;
  historySource: AgentHistorySource;
  permissionView: AgentPermissionView;
  providerBindings: Partial<Record<ModelProtocol, AgentProviderBinding>>;
  providerSwitching?: 'startup';
  modelCatalog: AgentModelCatalog;
  reasoningEfforts: readonly string[];
  timedRunReasoningEfforts?: readonly string[];
  supportedAccess?: readonly AgentAccessMode[];
  webDefaultAccess: 'workspace' | 'full';
  backgroundDefaults?: {
    model: string;
    reasoningEffort: string;
  };
  /** Only an embedding host can supply this adapter; profiles, flags and channel options never select it. */
  hostManaged?: boolean;
}

const COMMON_AGENT_LAUNCH_KEYS = Object.freeze([
  'binaryPath',
  'env',
  'realpath',
  'version',
  'sha256',
  'owner',
  'mode',
]);

const CLAUDE_SPEC: AgentBackendSpec = Object.freeze({
  kind: 'claude',
  displayName: 'Claude Code',
  shortDisplayName: 'Claude',
  defaultCommand: 'claude',
  commandEnv: 'LARK_CHANNEL_CLAUDE_BIN',
  launchRequired: false,
  launchKeys: Object.freeze([...COMMON_AGENT_LAUNCH_KEYS, 'configDir', 'mcpConfig']),
  stateDirectory: Object.freeze({ field: 'configDir', envName: 'CLAUDE_CONFIG_DIR' }),
  includeStateDirectoryInPolicy: true,
  sessionKind: 'claude-session',
  sessionIdField: 'sessionId',
  imageInput: 'attachments',
  legacySessionStore: true,
  promptInjection: 'append-system-prompt',
  supportsNativeHistory: true,
  historySource: 'claude-jsonl',
  permissionView: 'permission',
  providerBindings: Object.freeze({}),
  modelCatalog: 'claude',
  reasoningEfforts: Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']),
  timedRunReasoningEfforts: Object.freeze(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']),
  webDefaultAccess: 'workspace',
});

const CODEX_SPEC: AgentBackendSpec = Object.freeze({
  kind: 'codex',
  displayName: 'Codex CLI',
  shortDisplayName: 'Codex',
  defaultCommand: 'codex',
  commandEnv: 'LARK_CHANNEL_CODEX_BIN',
  launchRequired: true,
  launchKeys: Object.freeze([
    ...COMMON_AGENT_LAUNCH_KEYS,
    'transport',
    'appServerMode',
    'provider',
    'codexHome',
    'inheritCodexHome',
    'ignoreUserConfig',
    'ignoreRules',
  ]),
  stateDirectory: Object.freeze({ field: 'codexHome', envName: 'CODEX_HOME' }),
  includeStateDirectoryInPolicy: false,
  sessionKind: 'codex-thread',
  sessionIdField: 'threadId',
  imageInput: 'paths',
  legacySessionStore: false,
  promptInjection: 'stdin-prefix',
  supportsNativeHistory: false,
  historySource: 'codex-thread-list',
  permissionView: 'sandbox',
  providerBindings: Object.freeze({ responses: 'codex-config' }),
  providerSwitching: 'startup',
  modelCatalog: 'codex',
  reasoningEfforts: Object.freeze(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']),
  webDefaultAccess: 'workspace',
  backgroundDefaults: Object.freeze({
    model: 'deepseek-flash',
    reasoningEffort: 'max',
  }),
});

const PI_SPEC: AgentBackendSpec = Object.freeze({
  kind: 'pi',
  displayName: 'Pi Coding Agent',
  shortDisplayName: 'Pi',
  defaultCommand: 'pi',
  commandEnv: 'LARK_CHANNEL_PI_BIN',
  launchRequired: true,
  launchKeys: Object.freeze([...COMMON_AGENT_LAUNCH_KEYS, 'agentDir']),
  stateDirectory: Object.freeze({ field: 'agentDir', envName: 'PI_CODING_AGENT_DIR' }),
  includeStateDirectoryInPolicy: true,
  sessionKind: 'pi-session',
  sessionIdField: 'sessionId',
  imageInput: 'attachments',
  legacySessionStore: false,
  promptInjection: 'append-system-prompt',
  supportsNativeHistory: true,
  historySource: 'catalog',
  permissionView: 'tools',
  providerBindings: Object.freeze({ responses: 'pi-extension' }),
  modelCatalog: 'pi',
  reasoningEfforts: Object.freeze(['minimal', 'low', 'medium', 'high', 'xhigh']),
  supportedAccess: Object.freeze(['read-only', 'full'] as AgentAccessMode[]),
  webDefaultAccess: 'full',
});

const AGY_SPEC: AgentBackendSpec = Object.freeze({
  kind: 'agy',
  displayName: 'Antigravity CLI',
  shortDisplayName: 'Antigravity',
  defaultCommand: 'agy',
  commandEnv: 'LARK_CHANNEL_AGY_BIN',
  launchRequired: true,
  launchKeys: COMMON_AGENT_LAUNCH_KEYS,
  includeStateDirectoryInPolicy: false,
  sessionKind: 'agy-session',
  sessionIdField: 'sessionId',
  imageInput: 'paths',
  legacySessionStore: false,
  promptInjection: 'stdin-prefix',
  supportsNativeHistory: true,
  historySource: 'catalog',
  permissionView: 'tools',
  providerBindings: Object.freeze({ gemini: 'agy-gemini' }),
  modelCatalog: 'agy',
  reasoningEfforts: Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']),
  supportedAccess: Object.freeze(['full'] as AgentAccessMode[]),
  webDefaultAccess: 'full',
});

const DSH_SPEC: AgentBackendSpec = Object.freeze({
  kind: 'dsh',
  displayName: 'DeepSeek Harness',
  shortDisplayName: 'DSH',
  defaultCommand: 'dsh',
  commandEnv: 'LARK_CHANNEL_DSH_BIN',
  launchRequired: false,
  launchKeys: COMMON_AGENT_LAUNCH_KEYS,
  includeStateDirectoryInPolicy: false,
  sessionKind: 'dsh-session',
  sessionIdField: 'sessionId',
  imageInput: 'attachments',
  legacySessionStore: false,
  promptInjection: 'append-system-prompt',
  supportsNativeHistory: false,
  historySource: 'catalog',
  permissionView: 'tools',
  providerBindings: Object.freeze({}),
  modelCatalog: 'dsh',
  // A fallback only: DSH advertises its levels per model, and `off` is a native value.
  reasoningEfforts: Object.freeze(['off', 'low', 'medium', 'high', 'xhigh', 'max']),
  // Host-registered tools, each validating its own lease, are the boundary.
  supportedAccess: Object.freeze(['full'] as AgentAccessMode[]),
  webDefaultAccess: 'full',
  hostManaged: true,
});

export const AGENT_BACKEND_SPECS: Readonly<Record<AgentKind, AgentBackendSpec>> =
  Object.freeze({
    claude: CLAUDE_SPEC,
    codex: CODEX_SPEC,
    pi: PI_SPEC,
    agy: AGY_SPEC,
    dsh: DSH_SPEC,
  });

/** Every registered backend, including those only an embedding host can supply. */
export const REGISTERED_AGENT_KINDS = Object.freeze(
  Object.keys(AGENT_BACKEND_SPECS) as AgentKind[],
);

/** Backends a profile, CLI flag or channel option can select on its own. */
export const AGENT_KINDS = Object.freeze(
  REGISTERED_AGENT_KINDS.filter((kind) => !AGENT_BACKEND_SPECS[kind].hostManaged),
);

export function isAgentKind(value: unknown): value is AgentKind {
  return (AGENT_KINDS as readonly unknown[]).includes(value);
}

export function isRegisteredAgentKind(value: unknown): value is AgentKind {
  return (REGISTERED_AGENT_KINDS as readonly unknown[]).includes(value);
}

export function agentBackendSpec(kind: AgentKind): AgentBackendSpec {
  return AGENT_BACKEND_SPECS[kind];
}

export function sessionIdFieldForAgent(
  kind: AgentKind,
): AgentSessionIdField {
  return agentBackendSpec(kind).sessionIdField;
}

export function agentDisplayName(kind: AgentKind): string {
  return agentBackendSpec(kind).displayName;
}

export function agentShortDisplayName(kind: AgentKind): string {
  return agentBackendSpec(kind).shortDisplayName;
}

