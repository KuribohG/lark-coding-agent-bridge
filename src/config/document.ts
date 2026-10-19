import { parse, stringify, TomlError } from 'smol-toml';
import { normalizeProfileConfig, type RootConfig, type ProfileConfig, type AgentKind } from './profile-schema';
import { larkDisplay } from '../channels/lark/config';
import { WEB_DISPLAY_DEFAULTS } from '../channels/web/config';
import { normalizeFileLinks } from './file-links';
import type { RunPreferences } from './schema';
import { parseEffort } from '../agent/model-settings';

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
const LARK_KEYS = ['reply_mode', 'show_tools', 'progress', 'file_links'];
const WEB_KEYS = ['show_tools', 'show_reasoning'];
const LAUNCH_KEYS = ['binaryPath', 'transport', 'codexHome', 'inheritCodexHome', 'ignoreUserConfig', 'ignoreRules', 'realpath', 'version', 'sha256', 'owner', 'mode'];

export function object(value: unknown, path: string): Table {
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
    if (k === 'file_links') {
      normalizeFileLinks(v);
      for (const rule of v) keys(rule, ['localRoot', 'fileBaseUrl', 'browseBaseUrl', 'markdownPreviewUrl'], `${path}.file_links`);
    }
  }
}
function checkLaunch(value: unknown, agent: string, path: string): void {
  const launch = keys(value, agent === 'codex' ? LAUNCH_KEYS : ['binaryPath'], path);
  for (const [k, v] of Object.entries(launch)) {
    const kind = ['inheritCodexHome', 'ignoreUserConfig', 'ignoreRules'].includes(k) ? 'boolean' : ['mode', 'owner'].includes(k) ? 'number' : 'string';
    if (typeof v !== kind) throw new Error(`${path}.${k}: expected ${kind}`);
    if (k === 'transport' && v !== 'exec' && v !== 'app-server') throw new Error(`${path}.transport: expected exec or app-server`);
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

export function validateDocument(input: unknown): ConfigDocument {
  const doc = keys(input, ['version', 'bridge', 'defaults', 'agents', 'channels', 'profiles', 'secrets', 'migrations', 'model_services', 'monitoring'], 'config');
  if (doc.version !== 3) throw new Error('config.version must be 3');
  if (doc.bridge !== undefined) {
    const bridge = keys(doc.bridge, ['active_profile', 'monitors_file'], 'bridge');
    for (const [k,v] of Object.entries(bridge)) if (typeof v !== 'string' || !v) throw new Error(`bridge.${k}: expected nonempty string`);
  }
  const profiles = object(doc.profiles ?? {}, 'profiles');
  for (const [name, value] of Object.entries(profiles)) {
    if (!name.trim() || /[\u0000-\u001f\s/\\:*?"<>|]/.test(name) || ['.', '..', '__proto__', 'prototype', 'constructor'].includes(name)) throw new Error('invalid profile name');
    const p = keys(value, PROFILE_KEYS, `profiles.${name}`);
    if (!['codex', 'claude'].includes(p.agent)) throw new Error(`profiles.${name}.agent: expected codex or claude`);
    if (p.run !== undefined) checkRun(p.run, `profiles.${name}.run`, p.agent);
    if (p.launch !== undefined) checkLaunch(p.launch, p.agent, `profiles.${name}.launch`);
    checkProfile(p, `profiles.${name}`);
    if (p.mode !== undefined && p.mode !== 'personal' && p.mode !== 'team') throw new Error(`profiles.${name}.mode: invalid mode`);
  }
  if (doc.defaults !== undefined) {
    keys(doc.defaults, ['run'], 'defaults');
    if (doc.defaults.run !== undefined) checkRun(doc.defaults.run, 'defaults.run');
  }
  if (doc.agents !== undefined) for (const [agent, value] of Object.entries(keys(doc.agents, ['codex', 'claude'], 'agents'))) {
    const layer = keys(value, ['run', 'launch'], `agents.${agent}`);
    if (layer.run !== undefined) checkRun(layer.run, `agents.${agent}.run`, agent as AgentKind);
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
  if (doc.monitoring !== undefined) keys(doc.monitoring, ['lark', 'gitlab_ci', 'storage'], 'monitoring');
  if (doc.secrets !== undefined) checkSecrets(doc.secrets, 'secrets');
  if (doc.bridge?.active_profile && !Object.hasOwn(profiles, doc.bridge.active_profile)) throw new Error('bridge.active_profile: profile not found');
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
    const { agent, run: _, launch, ...rest } = p;
    const mergedLaunch = { ...(doc.agents?.[agent as AgentKind]?.launch ?? {}), ...launch };
    profiles[name] = normalizeProfileConfig({ ...rest, schemaVersion: 2, agentKind: agent,
      preferences: resolveRun(doc, agent, name).preferences, channels: resolveChannels(doc, name),
      ...(agent === 'codex' ? { codex: { binaryPath: 'codex', ...mergedLaunch } } : { claude: mergedLaunch }),
    });
  }
  return { schemaVersion: 2, activeProfile: doc.bridge?.active_profile ?? Object.keys(profiles)[0] ?? '', preferences: {}, profiles,
    ...(doc.bridge?.monitors_file ? { monitorConfigFile: doc.bridge.monitors_file } : {}),
    ...(doc.secrets ? { secrets: doc.secrets } : {}), ...(doc.migrations ? { migrations: doc.migrations } : {}),
    ...(doc.model_services ? { modelServices: doc.model_services } : {}),
    ...(doc.monitoring?.lark ? { inbox: doc.monitoring.lark } : {}),
    ...(doc.monitoring?.gitlab_ci ? { gitlabCi: doc.monitoring.gitlab_ci } : {}),
    ...(doc.monitoring?.storage ? { storageMonitor: doc.monitoring.storage } : {}),
  };
}

export function profileDocument(p: ProfileConfig): Table {
  const out: Table = { agent: p.agentKind, run: {} };
  for (const [key, internal] of Object.entries(RUN_KEYS)) if (p.preferences[internal as keyof RunPreferences] !== undefined) out.run[key] = p.preferences[internal as keyof RunPreferences];
  for (const key of PROFILE_KEYS) if (!['agent', 'run', 'launch'].includes(key) && (p as unknown as Table)[key] !== undefined) out[key] = (p as unknown as Table)[key];
  const launch = p.agentKind === 'codex' ? p.codex : p.claude;
  if (launch) out.launch = launch;
  return out;
}

export function rootToDocument(root: RootConfig): ConfigDocument {
  const doc: ConfigDocument = { version: 3, bridge: { ...(root.activeProfile ? { active_profile: root.activeProfile } : {}),
    ...(root.monitorConfigFile ? { monitors_file: root.monitorConfigFile } : {}) }, profiles: {}, channels: { lark: { profiles: {} } } };
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
  if (!root.monitorConfigFile && (root.inbox || root.gitlabCi || root.storageMonitor)) doc.monitoring = {
    ...(root.inbox ? { lark: root.inbox } : {}), ...(root.gitlabCi ? { gitlab_ci: root.gitlabCi } : {}),
    ...(root.storageMonitor ? { storage: root.storageMonitor } : {}),
  };
  return doc;
}

export function formatDocument(doc: ConfigDocument): string {
  return '# Bridge configuration. Execution defaults and channel presentation are independent.\n' +
    stringify(JSON.parse(JSON.stringify(doc))) + '\n';
}
