export type AgentKind = 'claude' | 'codex' | 'pi';
export type AgentAccessMode = 'read-only' | 'workspace' | 'full';
export type AgentCapabilityId = AgentKind;
export type AgentSessionKind = 'claude-session' | 'codex-thread' | 'pi-session';
export type AgentSessionIdField = 'sessionId' | 'threadId';
export type AgentImageInput = 'paths' | 'attachments';
export type PromptInjectionMode = 'append-system-prompt' | 'stdin-prefix';
export type AgentHistorySource = 'codex-thread-list' | 'claude-jsonl' | 'catalog';
export type AgentPermissionView = 'permission' | 'sandbox' | 'tools';
export type AgentModelEnvironmentSource = 'claude-settings' | 'codex-config' | 'catalog';
export type AgentModelCatalog = 'claude' | 'codex' | 'pi';
export type AgentResponsesBinding = 'codex-config' | 'pi-extension';

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
  stateDirectory: AgentStateDirectorySpec;
  includeStateDirectoryInPolicy: boolean;
  sessionKind: AgentSessionKind;
  sessionIdField: AgentSessionIdField;
  imageInput: AgentImageInput;
  legacySessionStore: boolean;
  promptInjection: PromptInjectionMode;
  supportsNativeHistory: boolean;
  historySource: AgentHistorySource;
  permissionView: AgentPermissionView;
  modelEnvironmentSource: AgentModelEnvironmentSource;
  supportsResponsesProvider: boolean;
  responsesBinding?: AgentResponsesBinding;
  supportsProfileResponsesService: boolean;
  modelCatalog: AgentModelCatalog;
  reasoningEfforts: readonly string[];
  timedRunReasoningEfforts?: readonly string[];
  supportedAccess?: readonly AgentAccessMode[];
  webDefaultAccess: 'workspace' | 'full';
  backgroundDefaults?: {
    model: string;
    reasoningEffort: string;
  };
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
  launchKeys: Object.freeze([...COMMON_AGENT_LAUNCH_KEYS, 'configDir']),
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
  modelEnvironmentSource: 'claude-settings',
  supportsResponsesProvider: false,
  supportsProfileResponsesService: false,
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
  modelEnvironmentSource: 'codex-config',
  supportsResponsesProvider: true,
  responsesBinding: 'codex-config',
  supportsProfileResponsesService: true,
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
  modelEnvironmentSource: 'catalog',
  supportsResponsesProvider: true,
  responsesBinding: 'pi-extension',
  supportsProfileResponsesService: false,
  modelCatalog: 'pi',
  reasoningEfforts: Object.freeze(['minimal', 'low', 'medium', 'high', 'xhigh']),
  supportedAccess: Object.freeze(['read-only', 'full'] as AgentAccessMode[]),
  webDefaultAccess: 'full',
});

export const AGENT_BACKEND_SPECS: Readonly<Record<AgentKind, AgentBackendSpec>> =
  Object.freeze({
    claude: CLAUDE_SPEC,
    codex: CODEX_SPEC,
    pi: PI_SPEC,
  });

export const AGENT_KINDS = Object.freeze(
  Object.keys(AGENT_BACKEND_SPECS) as AgentKind[],
);

export function isAgentKind(value: unknown): value is AgentKind {
  return typeof value === 'string' &&
    Object.prototype.hasOwnProperty.call(AGENT_BACKEND_SPECS, value);
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

