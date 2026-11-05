import { describe, expect, it } from 'vitest';
import { parseRootConfig } from '../../../src/config/profile-store';
import {
  AUTO_APPLY,
  classifyDocumentPath,
  classifySetting,
  findSetting,
  leafChanges,
  PROFILE_SETTINGS,
  ROOT_SETTINGS,
  setPathValue,
} from '../../../src/config/settings';

/** Every documented section populated, so the coverage check sees every resolved leaf. */
const FULL = `version = 3
[bridge]
active_profile = "bot"
autostart_profiles = ["bot"]
[defaults.run]
model = "m"
effort = "high"
max_concurrent_runs = 3
idle_timeout_minutes = 5
stop_grace_ms = 500
workflow_timeout_minutes = 60
[agents.codex.launch]
binaryPath = "codex"
codexHome = "/tmp/codex-home"
env = { A = "1" }
[agents.claude.launch]
binaryPath = "claude"
[state]
[model_services.svc]
protocol = "responses"
baseUrl = "https://example.invalid/v1"
model = "x"
[model_services.svc.apiKey]
source = "env"
id = "SVC_KEY"
[channels.lark]
reply_mode = "markdown"
show_tools = true
progress = "brief"
message_debounce_ms = 100
network = { proxy = "direct" }
[channels.web]
show_tools = true
show_reasoning = false
[channels.slack]
show_tools = true
show_progress = true
[secrets.providers.p]
source = "env"
[profiles.bot]
agent = "codex"
mode = "personal"
[profiles.bot.accounts.app]
id = "cli_a"
secret = { source = "env", id = "S" }
tenant = "feishu"
[profiles.bot.access]
allowedUsers = ["u"]
allowedChats = ["c"]
admins = ["a"]
requireMentionInGroup = true
chatRequireMention = { c = false }
[profiles.bot.workspaces]
default = "/tmp"
[profiles.bot.permissions]
defaultAccess = "full"
maxAccess = "full"
[profiles.bot.attachments]
maxCount = 1
maxBytes = 1
maxFileBytes = 1
imageMaxBytes = 1
cacheTtlMs = 1
cacheMaxBytes = 1
[profiles.bot.meeting]
enabled = true
autoJoinOnInvite = true
respondIn = "im"
trigger = "@bot"
pollIntervalMs = 1000
summaryOnEnd = true
summaryTarget = "owner"
transcript = { keep = 1, stabilizeMs = 1 }
[profiles.bot.larkCli]
identityPreset = "bot-only"
localUserImport = { status = "imported", attemptedAt = "x", importedAt = "y", reason = "z" }
`;

describe('setting registry', () => {
  const root = parseRootConfig(FULL, '/tmp/bridge/config.toml');

  it('declares every resolved profile leaf explicitly', () => {
    const leaves = leafChanges({}, root.profiles.bot).map(change => change.path.join('.'));
    expect(leaves.length).toBeGreaterThan(40);
    const undeclared = leaves.filter(path => !findSetting(PROFILE_SETTINGS, path.split('.')));
    expect(undeclared).toEqual([]);
  });

  it('declares every resolved root leaf explicitly', () => {
    const { profiles: _, ...rest } = root;
    const leaves = leafChanges({}, { ...rest, profiles: { bot: true } }).map(change => change.path);
    expect(leaves.filter(path => !findSetting(ROOT_SETTINGS, path))).toEqual([]);
  });

  it.each([
    ['preferences.maxConcurrentRuns', 'live'],
    ['preferences.model', 'live'],
    ['access.allowedChats', 'live'],
    ['channels.lark.show_tools', 'live'],
    ['channels.lark.network.proxy', 'reconnect'],
    ['channels.web.show_tools', 'restart'],
    ['accounts.app.id', 'reconnect'],
    ['secrets.providers.p.source', 'reconnect'],
    ['agentKind', 'execution'],
    ['codex.env.A', 'execution'],
    ['permissions.defaultAccess', 'execution'],
    ['meeting.enabled', 'meeting'],
    ['meeting.pollIntervalMs', 'live'],
    ['mode', 'lark-cli'],
    ['larkCli.identityPreset', 'lark-cli'],
    ['larkCli.localUserImport.status', 'live'],
    ['attachments.maxBytes', 'live'],
  ])('classifies profile %s as %s', (path, apply) => {
    expect(classifySetting(PROFILE_SETTINGS, path.split('.'))).toBe(apply);
  });

  it.each([
    ['modelServices.svc.model', 'execution'],
    ['autostartProfiles', 'restart'],
    ['activeProfile', 'restart'],
    ['gitlabCi.enabled', 'monitoring'],
    ['monitorConfigFile', 'monitoring'],
    ['profiles.newbot', 'restart'],
  ])('classifies root %s as %s', (path, apply) => {
    expect(classifySetting(ROOT_SETTINGS, path.split('.'))).toBe(apply);
  });

  it('treats undeclared paths as restart-only', () => {
    expect(classifySetting(PROFILE_SETTINGS, ['somethingNew'])).toBe('restart');
    expect(AUTO_APPLY.has('restart')).toBe(false);
  });

  it.each([
    ['profiles.bot.run.max_concurrent_runs', 'live'],
    ['defaults.run.model', 'live'],
    ['agents.codex.run.effort', 'live'],
    ['agents.codex.launch.binaryPath', 'execution'],
    ['profiles.bot.launch.env.X', 'execution'],
    ['profiles.bot.agent', 'execution'],
    ['profiles.bot.accounts.app.secret', 'reconnect'],
    ['profiles.bot.meeting.enabled', 'meeting'],
    ['channels.lark.profiles.bot.network.proxy', 'reconnect'],
    ['channels.lark.profiles.bot.reply_mode', 'live'],
    ['channels.web.show_reasoning', 'restart'],
    ['bridge.autostart_profiles', 'restart'],
    ['bridge.monitors_file', 'monitoring'],
    ['model_services.svc.baseUrl', 'execution'],
    ['secrets.providers.p.source', 'reconnect'],
    ['unknown.key', 'restart'],
  ])('maps TOML path %s to %s', (path, apply) => {
    expect(classifyDocumentPath(path.split('.'))).toBe(apply);
  });
});

describe('leaf diff', () => {
  it('expands added and removed tables to leaves and compares arrays as values', () => {
    expect(leafChanges({ a: { b: 1 }, list: [1, 2] }, { a: { b: 1, c: { d: 2 } }, list: [2, 1] })).toEqual([
      { path: ['a', 'c', 'd'], before: undefined, after: 2 },
      { path: ['list'], before: [1, 2], after: [2, 1] },
    ]);
    expect(leafChanges({ meeting: { enabled: true } }, {})).toEqual([
      { path: ['meeting', 'enabled'], before: true, after: undefined },
    ]);
  });

  it('reports a table replaced by a scalar as one leaf', () => {
    expect(leafChanges({ x: { y: 1 } }, { x: 3 })).toEqual([{ path: ['x'], before: { y: 1 }, after: 3 }]);
  });

  it('sets and deletes leaves without sharing references', () => {
    const value = { arr: [1] };
    const target: Record<string, unknown> = {};
    setPathValue(target, ['a', 'b'], value);
    value.arr.push(2);
    expect(target).toEqual({ a: { b: { arr: [1] } } });
    setPathValue(target, ['a', 'b'], undefined);
    setPathValue(target, ['missing', 'leaf'], undefined);
    expect(target).toEqual({ a: {} });
  });
});
