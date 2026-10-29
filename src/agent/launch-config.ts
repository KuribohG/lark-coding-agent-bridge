import { AGENT_KINDS, agentBackendSpec, type AgentKind } from './backend-spec';
import { normalizeClaude, type ClaudeConfig } from './claude/config';
import { normalizeCodex, type CodexConfig } from './codex/config';
import { normalizePi, type PiConfig } from './pi/config';
import { normalizeAgy, type AgyConfig } from './agy/config';
import type { AgentLaunchConfig } from './launch-options';

export interface AgentLaunchConfigMap {
  claude: ClaudeConfig;
  codex: CodexConfig;
  pi: PiConfig;
  agy: AgyConfig;
}

export type AgentLaunchProfiles = Partial<AgentLaunchConfigMap>;

const NORMALIZERS = {
  claude: normalizeClaude,
  codex: normalizeCodex,
  pi: normalizePi,
  agy: normalizeAgy,
} satisfies { [K in AgentKind]: (input: AgentLaunchConfigMap[K]) => AgentLaunchConfigMap[K] };

function normalize<K extends AgentKind>(kind: K, value: AgentLaunchConfigMap[K]): AgentLaunchConfigMap[K] {
  const normalizer = NORMALIZERS[kind] as (input: AgentLaunchConfigMap[K]) => AgentLaunchConfigMap[K];
  return normalizer(value);
}

/** Backend-specific fields are validated by their owning backend. */
export function normalizeAgentLaunches(input: AgentLaunchProfiles): AgentLaunchProfiles {
  return Object.fromEntries(AGENT_KINDS.flatMap(kind => {
    const value = input[kind];
    return value ? [[kind, normalize(kind, value)]] : [];
  }));
}

export function resolveAgentLaunches(
  selected: AgentKind,
  load: (kind: AgentKind) => AgentLaunchConfig,
): AgentLaunchProfiles {
  return Object.fromEntries(AGENT_KINDS.flatMap(kind => {
    const spec = agentBackendSpec(kind);
    const value = load(kind);
    if (!Object.keys(value).length && !(selected === kind && spec.launchRequired)) return [];
    const input = { ...(spec.launchRequired ? { binaryPath: spec.defaultCommand } : {}), ...value };
    return [[kind, normalize(kind, input as unknown as AgentLaunchConfigMap[typeof kind])]];
  }));
}

export function agentLaunches(input: AgentLaunchProfiles): AgentLaunchProfiles {
  return Object.fromEntries(AGENT_KINDS.filter(kind => input[kind]).map(kind => [kind, input[kind]]));
}
