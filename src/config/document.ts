import { parse, stringify, TomlError } from 'smol-toml';
import {
  normalizeProfileConfig,
  type AgentExecutionProfile,
  type AgentKind,
  type ProfileConfig,
  type RootConfig,
} from './profile-schema';
import {
  normalizePermissions,
  permissionsToLegacySandbox,
  type PermissionConfig,
} from './permissions';
import { larkDisplay } from './lark-display';
import { WEB_DISPLAY_DEFAULTS } from '../channels/web/config';
import { normalizeFileLinks } from './file-links';
import type { RunPreferences } from './schema';
import { parseEffort } from '../agent/model-settings';
import { parseWorkItemConcurrency } from '../work-items/concurrency';
import {
  AGENT_KINDS,
  agentBackendSpec,
  isAgentKind,
} from '../agent/backend-spec';

export type Table = Record<string, any>;
export interface ConfigDocument extends Table {
  version: 3;
  bridge?: Table;
  defaults?: { run?: Table };
  agents?: Partial<Record<AgentKind, { run?: Table; launch?: Table }>>;
  channels?: Table;
  profiles: Record<string, Table>;
}

export const RUN_KEYS = {
  model: 'model', effort: 'reasoningEffort', max_concurrent_runs: 'maxConcurrentRuns',
  idle_timeout_minutes: 'runIdleTimeoutMinutes', stop_grace_ms: 'agentStopGraceMs',
} as const;
const PROFILE_KEYS = ['agent', 'run', 'mode', 'accounts', 'secrets', 'access', 'workspaces', 'permissions', 'attachments', 'meeting', 'larkCli', 'launch'];
const LARK_KEYS = ['reply_mode', 'show_tools', 'progress', 'message_debounce_ms', 'file_links'];
const WEB_KEYS = ['show_tools', 'show_reasoning'];
function object(value: unknown, path: string): Table {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) throw new Error(`${path}: expected a table`);
  return value as Table;
}
function keys(value: unknown, allowed: readonly string[], path: string): Table {
  const table = object(value, path);
  for (const key of Object.keys(table)) if (!allowed.includes(key) || ['__proto__', 'constructor', 'prototype'].includes(key)) {
    throw new Error(`${path}.${key}: unknown setting`);
  }
  return table;
}
function selection(value: unknown): boolean {
  return typeof value === 'string' && !!value.trim() || !!value && typeof value === 'object' &&
    Object.keys(value).length === 1 && (value as Table).source === 'native';
}
function checkRun(value: unknown, path: string, agent?: AgentKind): void {
  const run = keys(value, Object.keys(RUN_KEYS), path);
  for (const [key, v] of Object.entries(run)) {
    if (key === 'model' || key === 'effort') {
      if (!selection(v)) throw new Error(`${path}.${key}: expected a value or { source = "native" }`);
      if (key === 'effort' && typeof v === 'string') parseEffort(v, agent ?? 'codex');
    } else {
      const [min, max] = key === 'max_concurrent_runs' ? [1, 50] : key === 'idle_timeout_minutes' ? [0, 120] : [100, 30000];
      if (!Number.isSafeInteger(v) || v < min! || v > max!) throw new Error(`${path}.${key}: expected integer ${min}..${max}`);
    }
  }
}
function checkDisplay(value: unknown, channel: string, path: string): void {
  const display = keys(value, channel === 'lark' ? LARK_KEYS : WEB_KEYS, path);
  for (const [k, v] of Object.entries(display)) {
    if (k.startsWith('show_') && typeof v !== 'boolean') throw new Error(`${path}.${k}: expected boolean`);
    if (k === 'reply_mode' && !['markdown', 'text', 'card'].includes(v)) throw new Error(`${path}.${k}: invalid reply mode`);
    if (k === 'progress' && !['off', 'brief', 'detailed'].includes(v)) throw new Error(`${path}.${k}: invalid progress mode`);
    if (k === 'message_debounce_ms' && (!Number.isSafeInteger(v) || v < 0 || v > 5000)) {
      throw new Error(`${path}.${k}: expected integer 0..5000`);
    }
    if (k === 'file_links') {
      normalizeFileLinks(v);
      for (const rule of v) keys(rule, ['localRoot', 'fileBaseUrl', 'browseBaseUrl', 'markdownPreviewUrl'], `${path}.file_links`);
    }
  }
}
function checkLaunch(value: unknown, agent: string, path: string): void {
  if (!isAgentKind(agent)) throw new Error(`${path}: unsupported agent ${agent}`);
  const spec = agentBackendSpec(agent);
  const launch = keys(value, spec.launchKeys, path);
  for (const [k, v] of Object.entries(launch)) {
    if (k === 'env') {
      const env = object(v, `${path}.env`);
      for (const [name, value] of Object.entries(env)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
          throw new Error(`${path}.env.${name}: invalid environment variable name`);
        }
        if (typeof value !== 'string') {
          throw new Error(`${path}.env.${name}: expected string`);
        }
      }
      continue;
    }
    const kind = ['inheritCodexHome', 'ignoreUserConfig', 'ignoreRules'].includes(k) ? 'boolean' : ['mode', 'owner'].includes(k) ? 'number' : 'string';
    if (typeof v !== kind) throw new Error(`${path}.${k}: expected ${kind}`);
    if (k === 'transport' && v !== 'app-server') throw new Error(`${path}.transport: Codex exec transport has been removed; use app-server`);
    if (k === 'appServerMode' && !['daemon', 'per-run'].includes(v)) {
      throw new Error(`${path}.${k}: expected daemon or per-run`);
    }
    if (['ignoreUserConfig', 'ignoreRules'].includes(k) && v) throw new Error(`${path}.${k}: app-server requires false`);
  }
}

function fields(value: unknown, schema: Record<string, string>, path: string): Table {
  const table = keys(value, Object.keys(schema), path);
  for (const [key, v] of Object.entries(table)) {
    const kind = schema[key];
    const valid = kind === 'strings' ? Array.isArray(v) && v.every(x => typeof x === 'string')
      : kind === 'table' ? !!v && Object.getPrototypeOf(v) === Object.prototype
      : kind === 'integer' ? Number.isSafeInteger(v) && v >= 0 : typeof v === kind;
    if (!valid) throw new Error(`${path}.${key}: expected ${kind}`);
  }
  return table;
}
function checkSecrets(value: unknown, path: string): void {
  const table = fields(value, { providers: 'table', defaults: 'table' }, path);
  if (table.defaults !== undefined) fields(table.defaults, { env: 'string', file: 'string', exec: 'string' }, `${path}.defaults`);
  for (const [name, value] of Object.entries(table.providers ?? {})) {
    const p = fields(value, { source: 'string', allowlist: 'strings', path: 'string', command: 'string', args: 'strings', env: 'table', passEnv: 'strings', noOutputTimeoutMs: 'integer', maxOutputBytes: 'integer' }, `${path}.providers.${name}`);
    if (!['env', 'file', 'exec'].includes(p.source)) throw new Error(`${path}.providers.${name}.source: invalid source`);
    if (p.env !== undefined && Object.values(p.env).some(v => typeof v !== 'string')) throw new Error(`${path}.providers.${name}.env: expected string values`);
  }
}
function checkProfile(p: Table, path: string): void {
  if (p.accounts !== undefined) {
    const accounts = keys(p.accounts, ['app'], `${path}.accounts`);
    const app = keys(accounts.app, ['id', 'secret', 'tenant'], `${path}.accounts.app`);
    if (typeof app.id !== 'string' || !app.id || !['feishu', 'lark'].includes(app.tenant)) throw new Error(`${path}.accounts.app: incomplete account`);
    if (typeof app.secret !== 'string') {
      const ref = fields(app.secret, { source: 'string', provider: 'string', id: 'string' }, `${path}.accounts.app.secret`);
      if (!['env', 'file', 'exec'].includes(ref.source) || !ref.id) throw new Error(`${path}.accounts.app.secret: invalid reference`);
    } else if (!app.secret) throw new Error(`${path}.accounts.app.secret: expected nonempty string`);
  }
  if (p.access !== undefined) {
    const a = fields(p.access, { allowedUsers: 'strings', allowedChats: 'strings', admins: 'strings', requireMentionInGroup: 'boolean', chatRequireMention: 'table' }, `${path}.access`);
    if (a.chatRequireMention && Object.values(a.chatRequireMention).some(v => typeof v !== 'boolean')) throw new Error(`${path}.access.chatRequireMention: expected boolean values`);
  }
  if (p.workspaces !== undefined) fields(p.workspaces, { default: 'string' }, `${path}.workspaces`);
  if (p.permissions !== undefined) {
    const permissions = keys(p.permissions, ['defaultAccess', 'maxAccess', 'claude'], `${path}.permissions`);
    if (permissions.claude !== undefined) fields(permissions.claude, { permissionMode: 'string' }, `${path}.permissions.claude`);
  }
  if (p.attachments !== undefined) {
    const a = fields(p.attachments, { maxCount: 'integer', maxBytes: 'integer', maxFileBytes: 'integer', imageMaxBytes: 'integer', cacheTtlMs: 'integer', cacheMaxBytes: 'integer' }, `${path}.attachments`);
    if (Object.values(a).some(v => v <= 0)) throw new Error(`${path}.attachments: expected positive integers`);
  }
  if (p.meeting !== undefined) {
    const m = fields(p.meeting, { enabled: 'boolean', autoJoinOnInvite: 'boolean', transcript: 'table', respondIn: 'string', trigger: 'string', pollIntervalMs: 'integer', summaryOnEnd: 'boolean', summaryTarget: 'string' }, `${path}.meeting`);
    if (m.transcript !== undefined) fields(m.transcript, { keep: 'integer', stabilizeMs: 'integer' }, `${path}.meeting.transcript`);
    if (m.respondIn !== undefined && !['meeting', 'im', 'both'].includes(m.respondIn)) throw new Error(`${path}.meeting.respondIn: invalid destination`);
    if (m.summaryTarget !== undefined && !['origin', 'owner'].includes(m.summaryTarget)) throw new Error(`${path}.meeting.summaryTarget: invalid target`);
  }
  if (p.larkCli !== undefined) {
    const c = fields(p.larkCli, { identityPreset: 'string', localUserImport: 'table' }, `${path}.larkCli`);
    if (c.identityPreset !== undefined && !['bot-only', 'user-default'].includes(c.identityPreset)) throw new Error(`${path}.larkCli.identityPreset: invalid preset`);
    if (c.localUserImport !== undefined) fields(c.localUserImport, { status: 'string', attemptedAt: 'string', importedAt: 'string', reason: 'string' }, `${path}.larkCli.localUserImport`);
  }
  if (p.secrets !== undefined) checkSecrets(p.secrets, `${path}.secrets`);
}

function validateDocument(input: unknown): ConfigDocument {
  const doc = keys(input, ['version', 'bridge', 'defaults', 'agents', 'channels', 'profiles', 'secrets', 'migrations', 'model_services', 'monitoring'], 'config');
  if (doc.version !== 3) throw new Error('config.version must be 3');
  if (doc.bridge !== undefined) {
    const bridge = keys(doc.bridge, ['active_profile', 'autostart_profiles', 'monitors_file'], 'bridge');
    for (const k of ['active_profile', 'monitors_file']) {
      const value = bridge[k];
      if (value !== undefined && (typeof value !== 'string' || !value)) {
        throw new Error(`bridge.${k}: expected nonempty string`);
      }
    }
    if (bridge.autostart_profiles !== undefined) {
      if (!Array.isArray(bridge.autostart_profiles)
        || bridge.autostart_profiles.some(value => typeof value !== 'string' || !value.trim())) {
        throw new Error('bridge.autostart_profiles: expected nonempty profile names');
      }
      if (new Set(bridge.autostart_profiles).size !== bridge.autostart_profiles.length) {
        throw new Error('bridge.autostart_profiles: duplicate profile');
      }
    }
  }
  const profiles = object(doc.profiles ?? {}, 'profiles');
  for (const [name, value] of Object.entries(profiles)) {
    if (!name.trim() || /[\u0000-\u001f\s/\\:*?"<>|]/.test(name) || ['.', '..', '__proto__', 'prototype', 'constructor'].includes(name)) throw new Error('invalid profile name');
    const p = keys(value, PROFILE_KEYS, `profiles.${name}`);
    if (!isAgentKind(p.agent)) {
      throw new Error(`profiles.${name}.agent: expected one of ${AGENT_KINDS.join(', ')}`);
    }
    if (p.run !== undefined) checkRun(p.run, `profiles.${name}.run`, p.agent);
    if (p.launch !== undefined) checkLaunch(p.launch, p.agent, `profiles.${name}.launch`);
    checkProfile(p, `profiles.${name}`);
    if (p.mode !== undefined && p.mode !== 'personal' && p.mode !== 'team') throw new Error(`profiles.${name}.mode: invalid mode`);
  }
  if (doc.defaults !== undefined) {
    keys(doc.defaults, ['run'], 'defaults');
    if (doc.defaults.run !== undefined) checkRun(doc.defaults.run, 'defaults.run');
  }
  if (doc.agents !== undefined) for (const [agent, value] of Object.entries(keys(doc.agents, AGENT_KINDS, 'agents'))) {
    const layer = keys(value, ['run', 'launch'], `agents.${agent}`);
    if (!isAgentKind(agent)) throw new Error(`agents.${agent}: unsupported agent`);
    if (layer.run !== undefined) checkRun(layer.run, `agents.${agent}.run`, agent);
    if (layer.launch !== undefined) checkLaunch(layer.launch, agent, `agents.${agent}.launch`);
  }
  if (doc.channels !== undefined) for (const [channel, value] of Object.entries(keys(doc.channels, ['lark', 'web'], 'channels'))) {
    const c = object(value, `channels.${channel}`);
    const { profiles: overrides, ...display } = c;
    checkDisplay(display, channel, `channels.${channel}`);
    if (overrides !== undefined) for (const [profile, options] of Object.entries(object(overrides, `channels.${channel}.profiles`))) {
      if (!Object.hasOwn(profiles, profile)) throw new Error(`channels.${channel}.profiles.${profile}: profile not found`);
      checkDisplay(options, channel, `channels.${channel}.profiles.${profile}`);
    }
  }
  if (doc.monitoring !== undefined) {
    keys(doc.monitoring, ['lark', 'gitlab_ci', 'storage', 'concurrency'], 'monitoring');
    if (doc.monitoring.concurrency !== undefined) parseWorkItemConcurrency(doc.monitoring.concurrency, 'monitoring.concurrency');
  }
  if (doc.secrets !== undefined) checkSecrets(doc.secrets, 'secrets');
  if (doc.bridge?.active_profile && !Object.hasOwn(profiles, doc.bridge.active_profile)) throw new Error('bridge.active_profile: profile not found');
  for (const profile of doc.bridge?.autostart_profiles ?? []) {
    if (!Object.hasOwn(profiles, profile)) throw new Error(`bridge.autostart_profiles: profile not found: ${profile}`);
  }
  if (doc.bridge?.monitors_file && doc.monitoring) throw new Error('use bridge.monitors_file or inline monitoring, not both');
  return { ...doc, profiles } as ConfigDocument;
}

export function parseDocument(text: string): ConfigDocument {
  try { return validateDocument(parse(text)); }
  catch (e) {
    if (e instanceof TomlError) throw new Error(`TOML syntax error at line ${e.line}, column ${e.column}`);
    throw e;
  }
}

export function resolveRun(doc: ConfigDocument, agent: AgentKind, profile?: string): { preferences: RunPreferences; sources: Record<string, string> } {
  const run: Table = {}; const sources: Record<string, string> = {};
  for (const [path, layer] of [
    ['defaults.run', doc.defaults?.run], [`agents.${agent}.run`, doc.agents?.[agent]?.run],
    [`profiles.${profile}.run`, profile ? doc.profiles[profile]?.run : undefined],
  ] as const) for (const [key, value] of Object.entries(layer ?? {})) { run[key] = value; sources[key] = `${path}.${key}`; }
  checkRun(run, profile ? `profiles.${profile}.run (resolved)` : `agents.${agent}.run (resolved)`, agent);
  const preferences: Table = {};
  for (const [key, internal] of Object.entries(RUN_KEYS)) if (run[key] !== undefined) {
    preferences[internal] = typeof run[key] === 'object' ? undefined : run[key];
  }
  return { preferences, sources };
}

export interface ResolveExecutionProfileOptions {
  profile?: string;
  fallbackPermissions?: PermissionConfig;
}

/**
 * Select the engine and engine launch metadata without requiring a Lark
 * account. Used by channel hosts that need the shared execution runtime but
 * do not own a Feishu bot binding.
 */
export function resolveExecutionProfile(
  doc: ConfigDocument,
  agentKind: AgentKind,
  options: ResolveExecutionProfileOptions = {},
): AgentExecutionProfile {
  const profile = options.profile ? doc.profiles[options.profile] : undefined;
  if (options.profile && !profile) throw new Error(`profile not found: ${options.profile}`);
  const configuredPermissions = profile?.permissions !== undefined || profile?.sandbox !== undefined;
  const permissions = configuredPermissions
    ? normalizePermissions({ permissions: profile?.permissions, sandbox: profile?.sandbox }).permissions
    : options.fallbackPermissions ?? { defaultAccess: 'full', maxAccess: 'full' };
  const launchFor = (kind: AgentKind) => {
    const inherited = doc.agents?.[kind]?.launch ?? {};
    const override = profile?.agent === kind ? profile.launch ?? {} : {};
    const env = { ...(inherited.env ?? {}), ...(override.env ?? {}) };
    return {
      ...inherited,
      ...override,
      ...(Object.keys(env).length > 0 ? { env } : {}),
    };
  };

  const claudeLaunch = launchFor('claude');
  const codexLaunch = launchFor('codex');
  const piLaunch = launchFor('pi');
  return {
    agentKind,
    permissions,
    sandbox: permissionsToLegacySandbox(permissions),
    ...(claudeLaunch.binaryPath || claudeLaunch.configDir || claudeLaunch.env
      ? {
          claude: {
            ...(typeof claudeLaunch.binaryPath === 'string' ? { binaryPath: claudeLaunch.binaryPath } : {}),
            ...(typeof claudeLaunch.configDir === 'string' ? { configDir: claudeLaunch.configDir } : {}),
            ...(claudeLaunch.env ? { env: claudeLaunch.env } : {}),
          },
        }
      : {}),
    ...(codexLaunch.binaryPath || agentKind === 'codex'
      ? {
          codex: {
            binaryPath: codexLaunch.binaryPath ?? 'codex',
            transport: 'app-server' as const,
            appServerMode: codexLaunch.appServerMode === 'per-run' ? 'per-run' as const : 'daemon' as const,
            ...(typeof codexLaunch.codexHome === 'string' ? { codexHome: codexLaunch.codexHome } : {}),
            ...(typeof codexLaunch.inheritCodexHome === 'boolean'
              ? { inheritCodexHome: codexLaunch.inheritCodexHome }
              : {}),
            ignoreUserConfig: false,
            ignoreRules: false,
            ...(typeof codexLaunch.realpath === 'string' ? { realpath: codexLaunch.realpath } : {}),
            ...(typeof codexLaunch.version === 'string' ? { version: codexLaunch.version } : {}),
            ...(typeof codexLaunch.sha256 === 'string' ? { sha256: codexLaunch.sha256 } : {}),
            ...(typeof codexLaunch.owner === 'number' ? { owner: codexLaunch.owner } : {}),
            ...(typeof codexLaunch.mode === 'number' ? { mode: codexLaunch.mode } : {}),
            ...(codexLaunch.env ? { env: codexLaunch.env } : {}),
          },
        }
      : {}),
    ...(piLaunch.binaryPath || agentKind === 'pi'
      ? {
          pi: {
            binaryPath: piLaunch.binaryPath ?? 'pi',
            ...(typeof piLaunch.agentDir === 'string' ? { agentDir: piLaunch.agentDir } : {}),
            ...(typeof piLaunch.realpath === 'string' ? { realpath: piLaunch.realpath } : {}),
            ...(typeof piLaunch.version === 'string' ? { version: piLaunch.version } : {}),
            ...(typeof piLaunch.sha256 === 'string' ? { sha256: piLaunch.sha256 } : {}),
            ...(typeof piLaunch.owner === 'number' ? { owner: piLaunch.owner } : {}),
            ...(typeof piLaunch.mode === 'number' ? { mode: piLaunch.mode } : {}),
            ...(piLaunch.env ? { env: piLaunch.env } : {}),
          },
        }
      : {}),
  };
}

export function resolveChannels(doc: ConfigDocument, profile?: string) {
  const resolve = (channel: string, defaults: Table) => {
    const { profiles, ...common } = doc.channels?.[channel] ?? {};
    const result = { ...defaults, ...common, ...(profile ? profiles?.[profile] : {}) };
    if (result.file_links !== undefined) result.file_links = normalizeFileLinks(result.file_links);
    return result;
  };
  return { lark: resolve('lark', larkDisplay({})) as ReturnType<typeof larkDisplay>,
    web: resolve('web', WEB_DISPLAY_DEFAULTS) as typeof WEB_DISPLAY_DEFAULTS };
}

export function documentToRoot(doc: ConfigDocument): RootConfig {
  const profiles: RootConfig['profiles'] = {};
  for (const [name, p] of Object.entries(doc.profiles)) {
    const { agent, run: _, launch: __, ...rest } = p;
    const execution = resolveExecutionProfile(doc, agent as AgentKind, { profile: name });
    profiles[name] = normalizeProfileConfig({ ...rest, schemaVersion: 2, ...execution,
      preferences: resolveRun(doc, agent, name).preferences, channels: resolveChannels(doc, name),
    });
  }
  const autostartProfiles = doc.bridge?.autostart_profiles as string[] | undefined;
  const agentLaunches = doc.agents
    ? Object.fromEntries(Object.entries(doc.agents).flatMap(([kind, layer]) =>
        layer?.launch ? [[kind, { launch: structuredClone(layer.launch) }]] : []))
    : undefined;
  return { schemaVersion: 2, activeProfile: doc.bridge?.active_profile ?? Object.keys(profiles)[0] ?? '', preferences: {}, profiles,
    ...(autostartProfiles !== undefined ? { autostartProfiles: [...autostartProfiles] } : {}),
    ...(agentLaunches && Object.keys(agentLaunches).length > 0 ? { agentLaunches } : {}),
    ...(doc.bridge?.monitors_file ? { monitorConfigFile: doc.bridge.monitors_file } : {}),
    ...(doc.secrets ? { secrets: doc.secrets } : {}), ...(doc.migrations ? { migrations: doc.migrations } : {}),
    ...(doc.model_services ? { modelServices: doc.model_services } : {}),
    ...(doc.monitoring?.lark ? { inbox: doc.monitoring.lark } : {}),
    ...(doc.monitoring?.gitlab_ci ? { gitlabCi: doc.monitoring.gitlab_ci } : {}),
    ...(doc.monitoring?.storage ? { storageMonitor: doc.monitoring.storage } : {}),
    ...(doc.monitoring?.concurrency !== undefined ? { workItemConcurrency: parseWorkItemConcurrency(doc.monitoring.concurrency) } : {}),
  };
}

function profileDocument(p: ProfileConfig): Table {
  const out: Table = { agent: p.agentKind, run: {} };
  for (const [key, internal] of Object.entries(RUN_KEYS)) if (p.preferences[internal as keyof RunPreferences] !== undefined) out.run[key] = p.preferences[internal as keyof RunPreferences];
  for (const key of PROFILE_KEYS) if (!['agent', 'run', 'launch'].includes(key) && (p as unknown as Table)[key] !== undefined) out[key] = (p as unknown as Table)[key];
  const launch = p[p.agentKind];
  if (launch) out.launch = launch;
  return out;
}

export function rootToDocument(root: RootConfig): ConfigDocument {
  const doc: ConfigDocument = { version: 3, bridge: { ...(root.activeProfile ? { active_profile: root.activeProfile } : {}),
    ...(root.autostartProfiles !== undefined ? { autostart_profiles: [...root.autostartProfiles] } : {}),
    ...(root.monitorConfigFile ? { monitors_file: root.monitorConfigFile } : {}) }, profiles: {}, channels: { lark: { profiles: {} } } };
  if (root.agentLaunches) doc.agents = structuredClone(root.agentLaunches) as ConfigDocument['agents'];
  for (const [name, profile] of Object.entries(root.profiles)) {
    doc.profiles[name] = profileDocument(profile);
    if (profile.channels?.lark || ['messageReply', 'showToolCalls', 'cotMessages', 'fileLinks'].some(key => (profile.preferences as Table)[key] !== undefined)) {
      doc.channels!.lark.profiles[name] = larkDisplay(profile);
    }
    if (profile.channels?.web) (doc.channels!.web ??= { profiles: {} }).profiles[name] = profile.channels.web;
  }
  if (root.secrets) doc.secrets = root.secrets;
  if (root.migrations) doc.migrations = root.migrations;
  if (root.modelServices) doc.model_services = root.modelServices;
  if (!root.monitorConfigFile && (root.inbox || root.gitlabCi || root.storageMonitor || root.workItemConcurrency !== undefined)) doc.monitoring = {
    ...(root.inbox ? { lark: root.inbox } : {}), ...(root.gitlabCi ? { gitlab_ci: root.gitlabCi } : {}),
    ...(root.storageMonitor ? { storage: root.storageMonitor } : {}),
    ...(root.workItemConcurrency !== undefined ? { concurrency: parseWorkItemConcurrency(root.workItemConcurrency) } : {}),
  };
  return doc;
}

export function formatDocument(doc: ConfigDocument): string {
  return '# Bridge configuration. Execution defaults and channel presentation are independent.\n' +
    stringify(JSON.parse(JSON.stringify(doc))) + '\n';
}
