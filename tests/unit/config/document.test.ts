import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyPreferencesChange, preparePreferencesChange } from '../../../src/config/preferences';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import {
  documentToRoot,
  formatDocument,
  parseDocument,
  resolveExecutionProfile,
  resolveRun,
  rootToDocument,
} from '../../../src/config/document';
import { editToml, parseKeyPath } from '../../../src/config/toml-edit';
import { getAutostartProfiles, loadRootConfig, saveRootConfig } from '../../../src/config/profile-store';
import { inspectConfig, migrateConfig, patchConfig, reloadProfile } from '../../../src/config/service';
import { larkDisplay } from '../../../src/channels/lark/config';
import { filterWebState } from '../../../src/channels/web/config';
import { initialState } from '../../../src/runtime/run-state';

vi.mock('../../../src/runtime/model-settings', () => ({ modelEnvironment: async () => ({ defaults: {}, models: [] }) }));

const source = `# handwritten configuration
version = 3
[defaults.run]
model = "global-model" # keep this
max_concurrent_runs = 3
[agents.codex.run]
effort = "high"
[channels.lark]
show_tools = false
progress = "detailed"
[channels.web]
show_tools = true
show_reasoning = false
[profiles.bot]
agent = "codex"
[profiles.bot.accounts.app]
id = "cli_test"
secret = { source = "env", id = "TEST_SECRET" }
tenant = "feishu"
[profiles.bot.run]
model = "profile-model"
[profiles.other]
agent = "claude"
[profiles.other.accounts.app]
id = "cli_other"
secret = { source = "env", id = "OTHER_SECRET" }
tenant = "feishu"
`;
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function file(text = source) {
  const root = await mkdtemp(join(tmpdir(), 'bridge-config-v3-')); roots.push(root);
  const path = join(root, 'config.toml'); await writeFile(path, text); return path;
}

describe('layered configuration', () => {
  it('preserves inline concurrency and unrelated comments across configuration saves', async () => {
    const path = await file(source + '\n[monitoring.concurrency]\nanalysis = 7\ntriage = 60\n');
    const root = (await loadRootConfig(path))!;
    expect(root.workItemConcurrency).toEqual({ analysis: 7, triage: 60 });
    root.workItemConcurrency!.analysis = 3;
    await saveRootConfig(root, path);
    expect((await loadRootConfig(path))!.workItemConcurrency).toEqual({ analysis: 3, triage: 60 });
    const text = await readFile(path, 'utf8');
    expect(text).toContain('# keep this');
    expect(documentToRoot(parseDocument(formatDocument(rootToDocument(root)))).workItemConcurrency)
      .toEqual({ analysis: 3, triage: 60 });
  });

  it.each(['analysis = 0', 'triage = 101', 'analysis = "5"', 'triage = 1.5', 'maxConcurrent = 10'])(
    'rejects invalid inline concurrency: %s', value => {
      expect(() => parseDocument(source + '\n[monitoring.concurrency]\n' + value)).toThrow();
    });

  it.each([undefined, 'app-server'] as const)('preserves transport=%s across launch inheritance and round trips', transport => {
    const inherited = source + '\n[agents.codex.launch]\ntransport = "app-server"\n';
    const text = transport ? inherited + `\n[profiles.bot.launch]\ntransport = "${transport}"\n` : source;
    const root = documentToRoot(parseDocument(text));
    const expected = { transport: transport ?? 'app-server', ignoreUserConfig: false, ignoreRules: false };
    expect(root.profiles.bot!.codex).toMatchObject(expected);
    expect(documentToRoot(parseDocument(formatDocument(rootToDocument(root)))).profiles.bot!.codex).toMatchObject(expected);
  });

  it('keeps executable and state-directory controls separate for every switchable agent', () => {
    const text = source + `
[agents.claude.launch]
binaryPath = "/opt/claude"
configDir = "/state/claude"
[agents.pi.launch]
binaryPath = "/opt/pi"
agentDir = "/state/pi"
[agents.codex.launch]
binaryPath = "/opt/codex"
codexHome = "/state/codex"
`;
    const root = documentToRoot(parseDocument(text));
    expect(root.profiles.bot).toMatchObject({
      claude: { binaryPath: '/opt/claude', configDir: '/state/claude' },
      pi: { binaryPath: '/opt/pi', agentDir: '/state/pi' },
      codex: { binaryPath: '/opt/codex', codexHome: '/state/codex' },
    });
    expect(documentToRoot(parseDocument(formatDocument(rootToDocument(root)))).profiles.bot).toMatchObject({
      claude: { binaryPath: '/opt/claude', configDir: '/state/claude' },
      pi: { binaryPath: '/opt/pi', agentDir: '/state/pi' },
      codex: { binaryPath: '/opt/codex', codexHome: '/state/codex' },
    });
  });

  it('rejects native state-directory fields on the wrong agent', () => {
    expect(() => parseDocument(source + '\n[agents.codex.launch]\nagentDir = "/state/pi"\n')).toThrow(/unknown setting/);
    expect(() => parseDocument(source + '\n[agents.pi.launch]\ncodexHome = "/state/codex"\n')).toThrow(/unknown setting/);
  });

  it('inherits, merges and round-trips launch environment values', () => {
    const text = source + `
[agents.codex.launch.env]
HTTP_PROXY = "$HTTP_PROXY"
NO_PROXY = "localhost,127.0.0.1"
[profiles.bot.launch.env]
HTTP_PROXY = "http://profile-proxy.internal:8080"
HTTPS_PROXY = "\${HTTPS_PROXY}"
`;
    const root = documentToRoot(parseDocument(text));
    expect(root.profiles.bot!.codex?.env).toEqual({
      HTTP_PROXY: 'http://profile-proxy.internal:8080',
      HTTPS_PROXY: '${HTTPS_PROXY}',
      NO_PROXY: 'localhost,127.0.0.1',
    });
    expect(documentToRoot(parseDocument(formatDocument(rootToDocument(root))))
      .profiles.bot!.codex?.env).toEqual(root.profiles.bot!.codex?.env);
  });

  it.each([
    '[agents.codex.launch.env]\n"BAD-NAME" = "x"\n',
    '[agents.pi.launch.env]\nHTTP_PROXY = 8080\n',
  ])('rejects invalid launch environment tables: %s', fragment => {
    expect(() => parseDocument(source + fragment)).toThrow(/env/);
  });

  it.each([
    '[agents.codex.launch]\ntransport = "exec"',
    '[profiles.bot.launch]\ntransport = "exec"',
    '[agents.codex.launch]\nignoreRules = true',
    '[profiles.bot.launch]\nignoreUserConfig = true',
  ])('rejects removed exec settings before runtime: %s', fragment => {
    expect(() => parseDocument(source + '\n' + fragment)).toThrow(/app-server/);
  });

  it('inherits execution settings independently of each frontend', () => {
    const doc = parseDocument(source); const root = documentToRoot(doc);
    expect(root.profiles.bot!.preferences).toEqual({ model: 'profile-model', reasoningEffort: 'high', maxConcurrentRuns: 3 });
    expect(root.profiles.other!.preferences.model).toBe('global-model');
    expect(root.profiles.bot!.preferences).not.toHaveProperty('showToolCalls');
    expect(root.profiles.bot!.channels?.lark).toMatchObject({ show_tools: false, progress: 'detailed' });
    expect(root.profiles.bot!.channels?.web).toEqual({ show_tools: true, show_reasoning: false });
    expect(resolveRun(doc, 'codex', 'bot').sources.model).toBe('profiles.bot.run.model');
  });

  it('inherits and round-trips the per-profile Lark message debounce', () => {
    const text = source.replace(
      'progress = "detailed"',
      'progress = "detailed"\nmessage_debounce_ms = 600',
    ) + '\n[channels.lark.profiles.bot]\nmessage_debounce_ms = 250\n';
    const root = documentToRoot(parseDocument(text));

    expect(larkDisplay(root.profiles.bot!).message_debounce_ms).toBe(250);
    expect(larkDisplay(root.profiles.other!).message_debounce_ms).toBe(600);
    expect(documentToRoot(parseDocument(formatDocument(rootToDocument(root))))
      .profiles.bot!.channels?.lark?.message_debounce_ms).toBe(250);
  });

  it('keeps the supervisor autostart set independent from the active profile', () => {
    const withBootSet = source + `
[bridge]
active_profile = "bot"
autostart_profiles = ["bot", "other"]
`;
    const root = documentToRoot(parseDocument(withBootSet));
    expect(root.activeProfile).toBe('bot');
    expect(getAutostartProfiles(root)).toEqual(['bot', 'other']);
    expect(documentToRoot(parseDocument(formatDocument(rootToDocument(root)))).autostartProfiles)
      .toEqual(['bot', 'other']);

    const legacy = documentToRoot(parseDocument(source));
    expect(legacy.autostartProfiles).toBeUndefined();
    expect(getAutostartProfiles(legacy)).toEqual(['bot']);

    const empty = documentToRoot(parseDocument(withBootSet.replace('["bot", "other"]', '[]')));
    expect(getAutostartProfiles(empty)).toEqual([]);

    expect(() => parseDocument(withBootSet.replace('"other"]', '"missing"]')))
      .toThrow('autostart_profiles: profile not found');
  });

  it('resolves an account-free execution profile for standalone channels', () => {
    const doc = parseDocument(source + `
[agents.codex.launch]
binaryPath = "/opt/codex"
env = { HTTP_PROXY = "$HTTP_PROXY" }
[agents.pi.launch]
binaryPath = "/opt/pi"
`);
    const execution = resolveExecutionProfile(doc, 'codex', {
      profile: 'bot',
      fallbackPermissions: { defaultAccess: 'workspace', maxAccess: 'workspace' },
    });
    expect(execution.agentKind).toBe('codex');
    expect(execution.permissions).toEqual({ defaultAccess: 'workspace', maxAccess: 'workspace' });
    expect(execution.codex?.binaryPath).toBe('/opt/codex');
    expect(execution.codex?.env).toEqual({ HTTP_PROXY: '$HTTP_PROXY' });
    expect(execution.pi?.binaryPath).toBe('/opt/pi');
  });

  it('distinguishes removing an override, native delegation and disabled values', () => {
    const inherited = parseDocument(editToml(source, ['profiles','bot','run','model'], undefined));
    expect(resolveRun(inherited, 'codex', 'bot').preferences.model).toBe('global-model');
    const native = parseDocument(editToml(source, ['profiles','bot','run','model'], { source: 'native' }));
    expect(resolveRun(native, 'codex', 'bot').preferences.model).toBeUndefined();
    const zero = parseDocument(editToml(source, ['profiles','bot','run','idle_timeout_minutes'], 0));
    expect(resolveRun(zero, 'codex', 'bot').preferences.runIdleTimeoutMinutes).toBe(0);
  });

  it.each([
    'channels = false',
    '[profiles.bot]\nagent = "codex"\n[profiles.bot.access]\nallowedUser = ["oops"]',
    '[profiles.bot]\nagent = "codex"\n[profiles.bot.access]\nrequireMentionInGroup = "false"',
    '[defaults.output]\nprogress = "brief"',
    '[agents.codex.output]\nshow_tools = false',
    '[profiles.bot.run]\nshow_tools = false',
    '[channels.web]\nprogress = "brief"',
    '[channels.lark]\nmessage_debounce_ms = -1',
    '[channels.lark]\nmessage_debounce_ms = 5001',
    '[channels.lark]\nmessage_debounce_ms = 1.5',
    '[channels.lark]\nmessage_debounce_ms = "250"',
    '[defaults.run]\nmax_concurrent_runs = 0',
  ])('rejects misplaced or invalid settings: %s', fragment => {
    expect(() => parseDocument(`version = 3\n${fragment}`)).toThrow();
  });

  it('rejects JSON instead of maintaining a second runtime format', async () => {
    await expect(loadRootConfig(await file('{"schemaVersion":2,"profiles":{}}'))).rejects.toThrow();
  });

  it('writes only changed overrides and preserves unrelated comments', async () => {
    const path = await file(); const root = (await loadRootConfig(path))!;
    root.profiles.bot!.preferences.reasoningEffort = 'medium';
    await saveRootConfig(root, path);
    const text = await readFile(path, 'utf8'); const doc = parseDocument(text);
    expect(text).toContain('# handwritten configuration'); expect(text).toContain('# keep this');
    expect(doc.profiles.bot!.run).toEqual({ model: 'profile-model', effort: 'medium' });
    expect(doc.profiles.bot!.run).not.toHaveProperty('max_concurrent_runs');
    expect(doc.channels?.lark).toEqual({ show_tools: false, progress: 'detailed' });
    expect(doc.channels?.lark).not.toHaveProperty('profiles');
  });

  it('rejects stale saves and invalid patches without changing disk', async () => {
    const path = await file(); const root = (await loadRootConfig(path))!;
    const revision = (await inspectConfig(path, 'bot')).revision;
    await patchConfig(path, ['channels','web','show_tools'], false, revision);
    const current = await readFile(path, 'utf8');
    root.profiles.bot!.preferences.model = 'stale';
    await expect(saveRootConfig(root, path)).rejects.toThrow('改变');
    await expect(patchConfig(path, ['defaults','run','model'], 'stale', revision)).rejects.toThrow('改变');
    await expect(patchConfig(path, ['defaults','run','max_concurrent_runs'], 999)).rejects.toThrow();
    expect(await readFile(path, 'utf8')).toBe(current);
  });

  it('changes channel overrides without changing execution or another frontend', async () => {
    const path = await file();
    await patchConfig(path, ['channels','lark','profiles','bot','show_tools'], true);
    const root = (await loadRootConfig(path))!;
    expect(larkDisplay(root.profiles.bot!).show_tools).toBe(true);
    expect(larkDisplay(root.profiles.other!).show_tools).toBe(false);
    expect(root.profiles.bot!.channels?.web?.show_tools).toBe(true);
    expect(root.profiles.bot!.preferences.model).toBe('profile-model');
  });

  it('reloads safe settings while reporting reconstruction requirements', async () => {
    const path = await file(); const root = (await loadRootConfig(path))!;
    const state = { configPath: path, profile: 'bot', profileConfig: root.profiles.bot!, cfg: root.profiles.bot! };
    await patchConfig(path, ['agents','codex','launch','binaryPath'], '/new/codex');
    await patchConfig(path, ['channels','lark','progress'], 'off');
    const result = await reloadProfile(state);
    expect(result.restart).toContain('codex');
    expect(state.profileConfig.codex?.binaryPath).toBe('codex');
    expect(larkDisplay(state.cfg).progress).toBe('off');
  });

  it('lets a newly added profile inherit global execution and frontend settings', async () => {
    const path = await file(); const root = (await loadRootConfig(path))!;
    root.profiles.newbot = createDefaultProfileConfig({ agentKind: 'claude', accounts: root.profiles.other!.accounts });
    await saveRootConfig(root, path);
    expect(root.profiles.newbot.preferences.model).toBe('global-model');
    expect(root.profiles.newbot.channels?.lark?.show_tools).toBe(false);
    const doc = parseDocument(await readFile(path, 'utf8'));
    expect(doc.profiles.newbot!.run).toEqual({});
    expect(doc.channels?.lark.profiles?.newbot).toBeUndefined();
  });

  it('saves a short frontend form without pinning execution defaults or other channel fields', async () => {
    const path = await file(source.replace('max_concurrent_runs = 3\n', ''));
    const root = (await loadRootConfig(path))!;
    const state = { configPath: path, profile: 'bot', profileConfig: root.profiles.bot!, cfg: root.profiles.bot! };
    const change = await preparePreferencesChange(state, { configRevision: (await inspectConfig(path, 'bot')).revision, showToolCalls: true });
    await applyPreferencesChange(state, change, 'disk');
    const doc = parseDocument(await readFile(path, 'utf8'));
    expect(doc.profiles.bot!.run).toEqual({ model: 'profile-model' });
    expect(doc.channels?.lark.profiles.bot).toEqual({ show_tools: true });
    expect(doc.channels?.web).toEqual({ show_tools: true, show_reasoning: false });
    expect(doc.profiles.bot).not.toHaveProperty('larkCli');
  });

  it('restores parent settings even when a native override resolves to an omitted CLI parameter', async () => {
    const path = await file(editToml(source, ['profiles', 'bot', 'run', 'model'], { source: 'native' }));
    const root = (await loadRootConfig(path))!;
    const state = { configPath: path, profile: 'bot', profileConfig: root.profiles.bot!, cfg: root.profiles.bot! };
    await applyPreferencesChange(state, await preparePreferencesChange(state, { showToolCalls: true }), 'disk');
    expect(parseDocument(await readFile(path, 'utf8')).profiles.bot!.run.model).toEqual({ source: 'native' });
    const change = await preparePreferencesChange(state, { inheritSettings: ['model', 'showToolCalls'] });
    await applyPreferencesChange(state, change, 'disk');
    expect(state.cfg.preferences.model).toBe('global-model');
    expect(state.cfg.channels?.lark?.show_tools).toBe(false);
    expect(parseDocument(await readFile(path, 'utf8')).profiles.bot!.run).not.toHaveProperty('model');
  });

  it('round-trips Pi launch metadata through the generic TOML launch layer', () => {
    const text = `${source}
[profiles.pi]
agent = "pi"
[profiles.pi.accounts.app]
id = "cli_pi"
secret = { source = "env", id = "PI_SECRET" }
tenant = "feishu"
[profiles.pi.launch]
binaryPath = "/opt/bin/pi"
`;
    const root = documentToRoot(parseDocument(text));
    expect(root.profiles.pi?.pi?.binaryPath).toBe('/opt/bin/pi');
    const roundTrip = documentToRoot(parseDocument(formatDocument(rootToDocument(root))));
    expect(roundTrip.profiles.pi?.pi?.binaryPath).toBe('/opt/bin/pi');
  });

  it('rejects stale frontend forms before writing or changing runtime state', async () => {
    const path = await file(); const root = (await loadRootConfig(path))!;
    const state = { configPath: path, profile: 'bot', profileConfig: root.profiles.bot!, cfg: root.profiles.bot! };
    const revision = (await inspectConfig(path, 'bot')).revision;
    const change = await preparePreferencesChange(state, { configRevision: revision, showToolCalls: true });
    await patchConfig(path, ['defaults', 'run', 'idle_timeout_minutes'], 5);
    await expect(preparePreferencesChange(state, { configRevision: revision, showToolCalls: true })).rejects.toThrow('改变');
    await expect(applyPreferencesChange(state, change, 'disk')).rejects.toThrow('改变');
    expect(state.cfg.channels?.lark?.show_tools).toBe(false);
    expect(parseDocument(await readFile(path, 'utf8')).channels?.lark).not.toHaveProperty('profiles');
  });

  it('filters Web presentation without modifying the execution event state', () => {
    const state = { ...initialState, reasoning: { content: 'thinking', active: false },
      blocks: [{ kind: 'tool' as const, tool: { id: 'x', name: 'Read', input: {}, status: 'done' as const } }] };
    const displayed = filterWebState(state, { show_tools: false, show_reasoning: false });
    expect(displayed.blocks).toEqual([]); expect(displayed.reasoning.content).toBe('');
    expect(state.blocks).toHaveLength(1); expect(state.reasoning.content).toBe('thinking');
  });
});

describe('TOML text editing', () => {
  it('edits dotted and quoted keys, multiline values and inline tables', () => {
    let text = '# comment\n[a]\n"b.c" = """hello\nworld""" # trailing\nx = { y = 1, z = 2 }\n';
    text = editToml(text, ['a','b.c'], 'new');
    text = editToml(text, ['a','x','y'], 3);
    expect(parse(text)).toEqual({ a: { 'b.c': 'new', x: { y: 3, z: 2 } } });
    expect(text).toContain('# comment'); expect(text).toContain('# trailing');
  });
  it('parses quoted paths and rejects unsafe paths and parser snippets containing secrets', () => {
    expect(parseKeyPath('profiles."bot.one".run.model')).toEqual(['profiles', 'bot.one', 'run', 'model']);
    expect(() => parseKeyPath('__proto__.key')).toThrow('invalid');
    expect(() => editToml('secret = "sensitive-value"oops', ['secret'], 'replacement')).toThrow('TOML syntax error');
    try { editToml('secret = "sensitive-value"oops', ['secret'], 'replacement'); }
    catch (error) { expect(String(error)).not.toContain('sensitive-value'); }
  });
  it('replaces arrays instead of merging their members', () => {
    expect(parse(editToml('[access]\nusers = ["a", "b"]\n', ['access','users'], []))).toEqual({ access: { users: [] } });
  });
  it('is byte-preserving for no-op saves', () => {
    expect(editToml(source, ['defaults','run','model'], 'global-model')).toBe(source);
  });
});

describe('one-time JSON conversion', () => {
  it('preserves execution, display, credentials and scopes without changing source', async () => {
    const root = documentToRoot(parseDocument(source));
    root.profiles.bot!.preferences.messageReply = 'text';
    delete root.profiles.bot!.channels;
    const json = JSON.stringify(root);
    const input = (await file()).replace('config.toml','old.json'); await writeFile(input, json);
    const output = input.replace('old.json', 'converted.toml');
    await migrateConfig(input, output, false);
    expect(await readFile(input,'utf8')).toBe(json);
    const migrated = (await loadRootConfig(output))!;
    expect(migrated.profiles.bot!.channels?.lark?.reply_mode).toBe('markdown');
    expect(migrated.profiles.bot!.accounts).toEqual(root.profiles.bot!.accounts);
    expect(migrated.profiles.bot!.preferences.model).toBe('profile-model');
    expect(parseDocument(await readFile(output,'utf8')).profiles.bot).not.toHaveProperty('preferences');
    await expect(migrateConfig(input, output, false)).rejects.toThrow();
  });
});
