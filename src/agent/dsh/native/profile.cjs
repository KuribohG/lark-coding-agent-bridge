'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const { createHash, randomUUID } = require('node:crypto');
const { acquireRootLease } = require('./lease.cjs');
const { renameWithRetry } = require('./utilities.cjs');
const lock = require('./runtime-lock.json');
const ADAPTER_PROTOCOL = 1;
const adapterIdentity = createHash('sha256').update(fs.readFileSync(path.join(__dirname, 'plugin.mjs'))).update(fs.readFileSync(path.join(__dirname, 'index.cjs'))).digest('hex');
// An insert over an empty tree: no dsh-base, user patches, skills or context discovery.
const pluginPackages = Object.freeze({
  timer: '@deepseek-ai/cordis-plugin-timer', llm: '@deepseek-ai/dsh-llm', session: '@deepseek-ai/dsh-session',
  'session-log-deepseek': '@deepseek-ai/dsh-session-log-deepseek',
  'deepseek-llm-api-extensions': '@deepseek-ai/dsh-deepseek-llm-api-extensions',
  agent: '@deepseek-ai/dsh-agent', 'llm-retry': '@deepseek-ai/dsh-llm-retry',
  'llm-pi-ai': '@deepseek-ai/dsh-llm-pi-ai', 'session-persistence-jsonl': '@deepseek-ai/dsh-session-persistence-jsonl',
  'session-query': '@deepseek-ai/dsh-session-query', 'session-projection': '@deepseek-ai/dsh-session-projection',
  'token-meter': '@deepseek-ai/dsh-token-meter', 'compaction-basic': '@deepseek-ai/dsh-compaction-basic',
  'tool-result-pruner': '@deepseek-ai/dsh-compaction-tool-result-pruner',
  'session-checkpoint-policy': '@deepseek-ai/dsh-session-checkpoint-policy',
  tools: '@deepseek-ai/dsh-tools', 'system-prompt': '@deepseek-ai/dsh-system-prompt', 'agent-loop': '@deepseek-ai/dsh-agent-loop',
});
function dshLoader(packageRoot) {
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')); }
  catch { throw Object.assign(new Error('The pinned DSH runtime is missing. Install the host runtime package.'), { code: 'harness-runtime-missing' }); }
  if (process.versions.node !== lock.nodeVersion || manifest.name !== '@deepseek-ai/dsh' || manifest.version !== lock.dshVersion)
    throw Object.assign(new Error(`DSH requires Node ${lock.nodeVersion} and @deepseek-ai/dsh ${lock.dshVersion}.`), { code: 'harness-runtime-version' });
  const requireDsh = createRequire(path.join(packageRoot, 'package.json'));
  const load = name => import(pathToFileURL(requireDsh.resolve(name)).href);
  load.resolve = name => pathToFileURL(requireDsh.resolve(name)).href;
  load.manifest = name => JSON.parse(fs.readFileSync(requireDsh.resolve(`${name}/package.json`), 'utf8'));
  return load;
}
function profileIdentity() {
  return `warp-assistant-${createHash('sha256').update(JSON.stringify({ schema: 3, runtime: lock, pluginPackages,
    adapterProtocol: ADAPTER_PROTOCOL })).digest('hex').slice(0, 24)}`;
}
async function atomicJson(filename, value) {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    const descriptor = await fs.promises.open(temporary, 'wx');
    try { await descriptor.writeFile(JSON.stringify(value) + '\n'); await descriptor.sync(); } finally { await descriptor.close(); }
    await renameWithRetry(temporary, filename);
  }
  finally { await fs.promises.rm(temporary, { force: true }); }
}
function canonicalRoot(home) {
  const absolute = path.resolve(home);
  let parent = absolute;
  while (!fs.existsSync(parent)) { const next = path.dirname(parent); if (next === parent) throw new Error('Native root has no existing parent.'); parent = next; }
  return path.join(fs.realpathSync.native(parent), path.relative(parent, absolute));
}
async function bootProfile(options) {
  const { packageRoot, home, endpoint, apiKey, models, defaultEffort } = options;
  if (!home || !endpoint || !Array.isArray(models) || !models.length) throw new TypeError('DSH requires explicit home, endpoint and model declarations.');
  const load = dshLoader(packageRoot), lease = await acquireRootLease(home, load);
  let ctx;
  try {
    const { boot } = await load('@deepseek-ai/dsh-app-boot');
    const { createLaunchEnvironmentSnapshot, DSH_LAUNCH_ENVIRONMENT_KEY } = await load('@deepseek-ai/dsh-launch-environment');
    const plugin = await import(pathToFileURL(path.join(__dirname, 'plugin.mjs')).href);
    const profileId = profileIdentity(options), token = randomUUID(), profileRoot = path.join(lease.root, 'profiles', profileId);
    fs.mkdirSync(profileRoot, { recursive: true });
    const configs = {
      'session-persistence-jsonl': { root: path.join(lease.root, 'sessions'), compression: 'none' },
      'system-prompt': { personaPrefix: '', includeHarnessIdentity: false, includeRuntimeContext: false },
      'agent-loop': { agents: [] },
      'llm-pi-ai': { providers: { 'warp-assistant-gateway': { api: 'openai-completions', baseURL: endpoint,
        apiKeyEnv: 'WARP_ASSISTANT_API_KEY', displayName: 'Application Gateway',
        models: models.map(({ defaultEffort: _default, ...model }) => model),
        reasoning: defaultEffort || models[0].defaultEffort || 'off', retryPolicy: { mode: 'normal', maxRetries: 0 } } } },
    };
    const versions = {};
    const entries = Object.entries(pluginPackages).map(([id, name]) => {
      const manifest = load.manifest(name); versions[name] = manifest.version;
      if (name.startsWith('@deepseek-ai/dsh-') && manifest.version !== lock.dshVersion) throw new Error(`Unpinned profile dependency: ${name}.`);
      return { id, name: load.resolve(name), ...(configs[id] ? { config: configs[id] } : {}) };
    });
    entries.push({ id: 'warp-assistant', name: pathToFileURL(path.join(__dirname, 'plugin.mjs')).href, config: { token } });
    const receiptPath = path.join(profileRoot, 'configuration-receipt.json');
    const normalized = rows => rows.map(row => row.id === 'warp-assistant' ? { ...row, config: { token: '<runtime-token>' } } : row);
    const fingerprint = rows => createHash('sha256').update(JSON.stringify(normalized(rows))).digest('hex');
    if (fs.existsSync(receiptPath)) {
      let previous, receipt;
      try {
        receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
        if (!/^configuration-[0-9a-f-]{36}\.json$/.test(receipt.configurationFile)) throw new Error('Invalid profile configuration pointer.');
        previous = JSON.parse(fs.readFileSync(path.join(profileRoot, receipt.configurationFile), 'utf8'));
      }
      catch { throw Object.assign(new Error('Native profile ownership receipt is unreadable; its bytes were preserved.'), { code: 'harness-profile-mismatch' }); }
      if (!Array.isArray(previous) || receipt.profileId !== profileId || receipt.adapterProtocol !== ADAPTER_PROTOCOL || receipt.configurationSha256 !== fingerprint(previous))
        throw Object.assign(new Error('Native profile was modified outside the pinned composition; its bytes were preserved.'), { code: 'harness-profile-mismatch' });
    }
    // Mutable gateway/model declarations can change after taking the root lease.
    // Their prior exact bytes must first match the last owned configuration receipt.
    // Publish an immutable file before the atomic pointer: a process crash between
    // writes leaves either the prior complete profile or the new complete profile.
    const configurationFile = `configuration-${randomUUID()}.json`, configuration = path.join(profileRoot, configurationFile);
    await atomicJson(configuration, entries);
    await atomicJson(receiptPath, { schemaVersion: 1, profileId, adapterProtocol: ADAPTER_PROTOCOL, configurationFile,
      configurationSha256: fingerprint(entries), adapterBuildIdentity: adapterIdentity });
    ctx = await boot('warp-assistant', configuration, [], hostCtx => {
      hostCtx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, createLaunchEnvironmentSnapshot([{ source: 'process', values: {
        WARP_ASSISTANT_API_KEY: apiKey || '', DSH_HOME: lease.root, DSH_TELEMETRY_DISABLED: '1',
      } }]));
    });
    const actual = [...ctx.loader.entries()];
    const leaves = actual.filter(entry => entry.options.name !== 'cordis:include');
    if (leaves.length !== entries.length || leaves.some(entry => !entries.some(expected => expected.id === entry.options.id && expected.name === entry.options.name)
        || entry.disabled || entry.fiber?.state !== 2))
      throw Object.assign(new Error('Loaded native profile differs from the pinned allowlist.'), { code: 'harness-profile-mismatch' });
    const owned = await plugin.profileReady(token);
    return { ctx: owned, load, profileId, lease, manifest: { profileId, configuration, adapterProtocol: ADAPTER_PROTOCOL, adapterBuildIdentity: adapterIdentity,
      plugins: versions, entries: entries.map(({ id, name }) => ({ id, name })) },
      async close() { try { await ctx.fiber.dispose(); } finally { await lease.close(); } } };
  } catch (error) { try { await ctx?.fiber.dispose(); } finally { await lease.close(); } throw error; }
}
async function modelProfile(packageRoot, model) {
  if (!/^deepseek[-/:]/i.test(model)) return { id: model, reasoningEfforts: false };
  try {
    const load = dshLoader(packageRoot);
    const { DeepSeekAdapter, resolveAdapterOptions } = await load('@deepseek-ai/dsh-llm-deepseek');
    const adapter = new DeepSeekAdapter({ options: () => resolveAdapterOptions({ models: [{ id: model }] }) });
    const info = await adapter.resolveModel('deepseek', model);
    if (!Array.isArray(info?.reasoning?.efforts)) throw new Error('DSH did not advertise model effort capabilities.');
    return { id: model, defaultEffort: info.reasoning.defaultEffort,
      reasoningEfforts: Object.fromEntries(info.reasoning.efforts.map(effort => [effort.id, effort.id === 'off' ? null : effort.id])),
      compat: { thinkingFormat: 'deepseek', supportsReasoningEffort: true, supportsDeveloperRole: false, supportsStore: false,
        maxTokensField: 'max_tokens', requiresReasoningContentOnAssistantMessages: true } };
  } catch (cause) { throw Object.assign(new Error(`Pinned DSH capabilities are unavailable for model ${model}.`), { code: 'harness-model-unavailable', cause }); }
}
async function bootReader({ packageRoot, home }) {
  const load = dshLoader(packageRoot), root = canonicalRoot(home);
  if (!fs.existsSync(path.join(root, 'sessions')) || !fs.statSync(path.join(root, 'sessions')).isDirectory())
    throw Object.assign(new Error('Native history is unavailable. Read-only inspection does not create a missing store.'), { code: 'harness-history-unavailable' });
  const { boot } = await load('@deepseek-ai/dsh-app-boot');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'warp-assistant-reader-'));
  const filename = path.join(directory, 'session-query.json');
  const entries = ['session', 'session-query', 'session-persistence-jsonl'].map(id => ({ id, name: load.resolve(pluginPackages[id]),
    ...(id === 'session-persistence-jsonl' ? { config: { root: path.join(root, 'sessions'), compression: 'none' } } : {}) }));
  let owner;
  try {
    fs.writeFileSync(filename, JSON.stringify(entries), { flag: 'wx' });
    owner = await boot('warp-assistant-reader', filename, []);
    const query = owner.get('sessionQuery'), persistence = owner.get('sessionPersistence');
    const actual = [...owner.loader.entries()].filter(entry => entry.options.name !== 'cordis:include');
    if (!query || !persistence || actual.length !== entries.length || actual.some(entry => !entries.some(row => row.id === entry.options.id && row.name === entry.options.name)
        || entry.disabled || entry.fiber?.state !== 2))
      throw Object.assign(new Error('Read-only native query profile differs from its allowlist.'), { code: 'harness-profile-mismatch' });
    return { ctx: { sessionQuery: query, sessionPersistence: persistence }, load,
      async close() { try { await owner.fiber.dispose(); } finally { fs.rmSync(directory, { recursive: true, force: true }); } } };
  } catch (error) {
    try { await owner?.fiber.dispose(); } finally { fs.rmSync(directory, { recursive: true, force: true }); }
    throw error;
  }
}
module.exports = { bootProfile, bootReader, dshLoader, pluginPackages, profileIdentity, canonicalRoot, lock, modelProfile, ADAPTER_PROTOCOL };
