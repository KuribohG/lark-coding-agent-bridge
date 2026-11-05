import { lstatSync, mkdirSync, readdirSync, readlinkSync, realpathSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { agentBackendSpec, type AgentKind } from './backend-spec';
import type { AgentLaunchProfiles } from './launch-config';

/**
 * Bridge-wide placement of agent-local state. A harness's memory follows its
 * state directory (Codex, pi) or its working directory (Claude), so both are
 * resolved here from one `[state]` table instead of per profile.
 */
export type AgentMemoryScope = 'agent' | 'workspace';

export interface AgentStateSettings {
  /** Runtime only: directory of the loaded config.toml; defaults are derived from it. */
  bridgeRoot?: string;
  /** Default workspaces live at `<workspaceRoot>/<agent>/default`. */
  workspaceRoot?: string;
  /** Bridge-owned agent homes live at `<agentHomeRoot>/<agent>`. */
  agentHomeRoot?: string;
  /** `agent`: one memory per harness regardless of cwd. `workspace`: harness-native behaviour. */
  memory?: AgentMemoryScope;
  shared?: {
    /** Linked as the harness's global instruction file (CLAUDE.md / AGENTS.md). */
    instructions?: string;
    /** Each child directory is linked into the harness's skills directory. */
    skills?: string;
  };
}

export type AgentHomeSource = 'launch' | 'native' | 'bridge' | 'profile';

export interface AgentStateLayout {
  kind: AgentKind;
  /** Directory exported through `homeEnv`; native homes are still reported for diagnostics. */
  home?: string;
  homeEnv?: string;
  homeSource?: AgentHomeSource;
  /** Whether the bridge must export `homeEnv`; native homes inherit the process environment. */
  exportHome: boolean;
  defaultWorkspace?: string;
  /** Claude only: auto-memory directory pinned independently of cwd. */
  memoryDir?: string;
}

interface StateProfile extends AgentLaunchProfiles {
  agentKind: AgentKind;
  state?: AgentStateSettings;
  workspaces?: { default?: string };
}

export interface AgentStateContext {
  /** Host state directory; holds the Codex home when no bridge root is configured. */
  profileDir?: string;
  env?: NodeJS.ProcessEnv;
}

const SETTINGS_KEYS = ['workspace_root', 'agent_home_root', 'memory', 'shared'];
const SHARED_KEYS = ['instructions', 'skills'];

/** Validate the TOML `[state]` table and convert it to settings. */
export function parseAgentStateTable(input: unknown): AgentStateSettings {
  const table = plainTable(input, 'state');
  for (const key of Object.keys(table)) if (!SETTINGS_KEYS.includes(key)) throw new Error(`state.${key}: unknown setting`);
  const out: AgentStateSettings = {};
  const path = (key: string, value: unknown) => {
    if (typeof value !== 'string' || !value.trim()) throw new Error(`${key}: expected a nonempty path`);
    if (!isAbsolute(value.trim()) && !value.trim().startsWith('~/')) throw new Error(`${key}: expected an absolute or ~/ path`);
    return value.trim();
  };
  if (table.workspace_root !== undefined) out.workspaceRoot = path('state.workspace_root', table.workspace_root);
  if (table.agent_home_root !== undefined) out.agentHomeRoot = path('state.agent_home_root', table.agent_home_root);
  if (table.memory !== undefined) {
    if (table.memory !== 'agent' && table.memory !== 'workspace') throw new Error('state.memory: expected agent or workspace');
    out.memory = table.memory;
  }
  if (table.shared !== undefined) {
    const shared = plainTable(table.shared, 'state.shared');
    for (const key of Object.keys(shared)) if (!SHARED_KEYS.includes(key)) throw new Error(`state.shared.${key}: unknown setting`);
    out.shared = {
      ...(shared.instructions !== undefined ? { instructions: path('state.shared.instructions', shared.instructions) } : {}),
      ...(shared.skills !== undefined ? { skills: path('state.shared.skills', shared.skills) } : {}),
    };
  }
  return out;
}

export function agentStateTable(settings: AgentStateSettings): Record<string, unknown> {
  return {
    ...(settings.workspaceRoot ? { workspace_root: settings.workspaceRoot } : {}),
    ...(settings.agentHomeRoot ? { agent_home_root: settings.agentHomeRoot } : {}),
    ...(settings.memory ? { memory: settings.memory } : {}),
    ...(settings.shared && Object.keys(settings.shared).length > 0 ? { shared: { ...settings.shared } } : {}),
  };
}

function expand(path: string): string {
  return path.startsWith('~/') ? join(homedir(), path.slice(2)) : resolve(path);
}

/** Roots are known only from `[state]` or the loaded config's directory; profiles built in memory have none. */
function workspaceRoot(settings: AgentStateSettings | undefined): string | undefined {
  if (settings?.workspaceRoot) return expand(settings.workspaceRoot);
  return settings?.bridgeRoot ? `${settings.bridgeRoot}-workspaces` : undefined;
}

function agentHomeRoot(settings: AgentStateSettings | undefined): string | undefined {
  if (settings?.agentHomeRoot) return expand(settings.agentHomeRoot);
  return settings?.bridgeRoot ? join(settings.bridgeRoot, 'agents') : undefined;
}

/** The bridge-managed workspace for an engine, ignoring any profile override. */
export function managedWorkspaceFor(settings: AgentStateSettings | undefined, kind: AgentKind): string | undefined {
  const root = workspaceRoot(settings);
  return root ? join(root, kind, 'default') : undefined;
}

/**
 * Default cwd for a scope without `/cd`. A profile's explicit
 * `workspaces.default` is kept for its own engine only; an engine switched in
 * from another profile gets that engine's bridge-wide workspace, so engine
 * identity (and Claude's cwd-keyed history) never depends on the hosting bot.
 */
export function defaultWorkspaceFor(profile: StateProfile, kind: AgentKind = profile.agentKind): string | undefined {
  if (kind === profile.agentKind && profile.workspaces?.default) return profile.workspaces.default;
  return managedWorkspaceFor(profile.state, kind);
}

/** Resolve state directory, workspace and memory placement for one engine. */
export function resolveAgentState(profile: StateProfile, kind: AgentKind, context: AgentStateContext = {}): AgentStateLayout {
  const env = context.env ?? process.env;
  const spec = agentBackendSpec(kind);
  const defaultWorkspace = defaultWorkspaceFor(profile, kind);
  const layout: AgentStateLayout = { kind, exportHome: false, defaultWorkspace };
  if (!spec.stateDirectory) return layout;
  layout.homeEnv = spec.stateDirectory.envName;
  const launch = profile[kind] as Record<string, unknown> | undefined;
  const configured = launch?.[spec.stateDirectory.field];
  const launchEnv = (launch?.env ?? {}) as Record<string, string>;
  if (typeof configured === 'string' && configured) {
    Object.assign(layout, { home: expand(configured), homeSource: 'launch', exportHome: true });
  } else if (kind === 'codex' && launch?.inheritCodexHome !== true) {
    // Codex is the only engine whose bridge-managed provider config requires a private home.
    const root = agentHomeRoot(profile.state);
    if (root) Object.assign(layout, { home: join(root, kind), homeSource: 'bridge', exportHome: true });
    else if (context.profileDir) Object.assign(layout, { home: join(context.profileDir, 'codex-home'), homeSource: 'profile', exportHome: true });
  } else {
    const native = launchEnv[spec.stateDirectory.envName] ?? env[spec.stateDirectory.envName] ?? nativeHome(kind);
    Object.assign(layout, { home: native, homeSource: 'native', exportHome: false });
  }
  if (kind === 'claude' && defaultWorkspace && (profile.state?.memory ?? 'agent') === 'agent') {
    layout.memoryDir = join(layout.home!, 'projects', encodeClaudeProject(canonical(defaultWorkspace)), 'memory');
  }
  return layout;
}

function nativeHome(kind: AgentKind): string | undefined {
  if (kind === 'claude') return join(homedir(), '.claude');
  if (kind === 'codex') return join(homedir(), '.codex');
  if (kind === 'pi') return join(homedir(), '.pi', 'agent');
  return undefined;
}

/** Same project-directory encoding Claude Code uses under `projects/`. */
export function encodeClaudeProject(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

function canonical(path: string): string {
  try { return realpathSync(path); } catch { return path; }
}

const INSTRUCTION_FILES: Partial<Record<AgentKind, string>> = { claude: 'CLAUDE.md', codex: 'AGENTS.md', pi: 'AGENTS.md' };

export interface SharedAssetReport {
  linked: string[];
  conflicts: string[];
}

/**
 * Link `[state.shared]` instructions and skills into an engine home. Existing
 * files and foreign links are reported, never replaced.
 */
export function ensureSharedAgentAssets(layout: AgentStateLayout, shared: AgentStateSettings['shared']): SharedAssetReport {
  const report: SharedAssetReport = { linked: [], conflicts: [] };
  if (!shared || !layout.home) return report;
  const instructionFile = INSTRUCTION_FILES[layout.kind];
  const links: Array<[string, string]> = [];
  if (shared.instructions && instructionFile) links.push([expand(shared.instructions), join(layout.home, instructionFile)]);
  if (shared.skills) {
    const source = expand(shared.skills);
    const target = join(layout.home, 'skills');
    if (canonical(source) !== canonical(target)) {
      let names: string[] = [];
      try { names = readdirSync(source).filter(name => !name.startsWith('.')); } catch { report.conflicts.push(`${source}: unreadable`); }
      for (const name of names) links.push([join(source, name), join(target, name)]);
    }
  }
  for (const [source, target] of links) {
    if (canonical(source) === canonical(target)) continue;
    const current = linkTarget(target);
    if (current === undefined) {
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      symlinkSync(source, target);
      report.linked.push(target);
    } else if (current === null || canonical(current) !== canonical(source)) {
      report.conflicts.push(`${target}: exists and is not linked to ${basename(source)}`);
    }
  }
  return report;
}

/** undefined: missing; null: a regular file or directory; string: link target. */
function linkTarget(path: string): string | null | undefined {
  try {
    const stat = lstatSync(path);
    if (!stat.isSymbolicLink()) return null;
    const target = readlinkSync(path);
    return isAbsolute(target) ? target : resolve(dirname(path), target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

function plainTable(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path}: expected a table`);
  return value as Record<string, unknown>;
}
