#!/usr/bin/env node
/**
 * pi-host: a long-lived process that embeds Pi's SDK and hosts many agent
 * sessions behind a newline-delimited JSON protocol.
 *
 * The bridge normally runs Node 20/22.18 and cannot import Pi's SDK in-process
 * (Pi requires Node >= 22.19), so `src/agent/pi-sdk/adapter.ts` spawns this
 * script with Pi's bundled Node and talks to it over stdin/stdout. One host per
 * bridge process: sessions are created, prompted, steered and disposed here;
 * the bridge keeps only the transport and event mapping.
 *
 * Protocol (one JSON object per line):
 *   bridge -> host  { id, cmd, params? }
 *   host -> bridge  { id, ok, data? } | { id, ok: false, error }
 *                   { type: "host.ready", data }
 *                   { type: "host.fatal", error }
 *                   { type: "run.event", sessionId, runId, event }
 *                   { type: "run.end", sessionId, runId, outcome, error? }
 *
 * The host owns Pi session files: a session created here can be reopened by
 * the `pi` CLI with the same agentDir (`pi --session <id>`), and vice versa.
 *
 * stdout is reserved for protocol frames. Pi extensions may write to stdout or
 * console.log; those writes are redirected to stderr before the SDK loads so
 * they cannot corrupt the stream.
 *
 * `--ipc-port <port>` adds a loopback HTTP endpoint inside the workcell that
 * forwards workflow CLI calls to the bridge over the frame channel: the worker
 * runs the CLI as usual, but the bridge executes the operation.
 *
 * `--tcp host:port` serves the same frames over a listening socket instead of
 * stdio. That is how a host runs somewhere the bridge cannot spawn a process:
 * the bridge reaches the socket through a forwarded channel. Every accepted
 * connection gets `host.ready` and can then drive the host; a dropped
 * connection leaves the sessions running, so a reconnecting bridge finds them.
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { boundShellTool, mergeSpawnEnv, resolveProviderValue, runEnvSnapshot } from './pi-host-protocol.mjs';

const realStdoutWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = function redirectedWrite(chunk, encoding, callback) {
  return process.stderr.write(chunk, encoding, callback);
};

/**
 * Where frames go: stdout by default, or the connected client in `--tcp` mode.
 * The mode is chosen once at startup, before any frame is sent.
 */
let writeFrame = (line) => realStdoutWrite(line);

function send(message) {
  let line;
  try {
    line = JSON.stringify(message);
  } catch {
    line = JSON.stringify(sanitize(message));
  }
  writeFrame(`${line}\n`);
}

function reply(id, ok, payload) {
  if (ok) send({ id, ok: true, ...(payload === undefined ? {} : { data: payload }) });
  else send({ id, ok: false, error: errorText(payload) });
}

function errorText(error) {
  if (error instanceof Error) return error.message || error.name;
  return typeof error === 'string' ? error : String(error);
}

function log(message, fields) {
  const suffix = fields ? ` ${JSON.stringify(sanitize(fields))}` : '';
  process.stderr.write(`[pi-host] ${message}${suffix}\n`);
}

/** JSON-safe copy for protocol frames: drop functions, break cycles. */
function sanitize(value, seen = new WeakSet()) {
  if (value === null || typeof value !== 'object') {
    return typeof value === 'function' ? undefined : value;
  }
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => sanitize(item, seen));
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'function') continue;
    out[key] = sanitize(item, seen);
  }
  return out;
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith('--') || value === undefined) {
      throw new Error(`invalid pi-host argument: ${flag ?? '(empty)'}`);
    }
    options[flag.slice(2)] = value;
  }
  return options;
}

const MIN_NODE = [22, 19, 0];

function nodeVersionAtLeast(version, minimum) {
  const parts = String(version).replace(/^v/, '').split('.').map((part) => Number(part) || 0);
  for (let index = 0; index < minimum.length; index += 1) {
    if ((parts[index] ?? 0) > minimum[index]) return true;
    if ((parts[index] ?? 0) < minimum[index]) return false;
  }
  return true;
}

let options;
try {
  options = parseArguments(process.argv.slice(2));
} catch (error) {
  send({ type: 'host.fatal', error: errorText(error) });
  process.exit(2);
}

if (!nodeVersionAtLeast(process.versions.node, MIN_NODE)) {
  send({
    type: 'host.fatal',
    error: `pi-host requires Node >= ${MIN_NODE.join('.')}; started with ${process.versions.node}. ` +
      'Configure pi.nodePath (or fix the pi launcher) to a compatible runtime.',
  });
  process.exit(2);
}

const sdkPath = options.sdk;
if (!sdkPath || !existsSync(sdkPath)) {
  send({ type: 'host.fatal', error: `pi SDK entry not found: ${sdkPath ?? '(missing --sdk)'}` });
  process.exit(2);
}

const agentDir = options['agent-dir'] || process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent');
// Session files, settings.json, auth.json and models.json all resolve through
// this directory; set it before touching the SDK.
process.env.PI_CODING_AGENT_DIR = agentDir;

const idleTtlMs = positiveInteger(options['idle-ttl-ms'], 15 * 60 * 1000);
const maxSessions = positiveInteger(options['max-sessions'], 256);
// A host with no sessions is useless to the bridge after a config reload or a
// crash of the owning adapter; exit so it cannot linger forever.
const emptyExitMs = positiveInteger(options['empty-exit-ms'], 10 * 60 * 1000);
const sessionPersistence = options['session-persistence'] === 'memory' ? 'memory' : 'file';

let pi;
let runtime;
try {
  pi = await import(pathToFileURL(sdkPath).href);
  runtime = await pi.ModelRuntime.create({
    authPath: join(agentDir, 'auth.json'),
    modelsPath: join(agentDir, 'models.json'),
    refreshOnCreate: false,
  });
} catch (error) {
  send({ type: 'host.fatal', error: `failed to load pi SDK: ${errorText(error)}` });
  process.exit(2);
}

/** @type {Map<string, SessionEntry>} */
const sessions = new Map();
const startedAt = Date.now();
let lastActivityAt = startedAt;

class SessionEntry {
  constructor(session, cwd, loader, state) {
    this.session = session;
    this.cwd = cwd;
    this.loader = loader;
    /** `{ appendPrompt, env }` shared with this session's tool definitions. */
    this.state = state;
    this.lastUsed = Date.now();
    this.lastEventAt = undefined;
    this.run = undefined;
    this.unsubscribe = () => {};
  }
}

/**
 * Shell tools spawn one process per call, so a run's trusted bindings
 * (`AGENT_WORKFLOW_TOKEN` and friends) must reach that process without landing
 * in the host's process.env: every other session would inherit them. The tool
 * definition captures this session's mutable state instead, and a spawn reads
 * the bindings of the run that owns the current turn. Sessions run one turn at
 * a time, so the snapshot cannot change under a spawn.
 */
function createSessionTools(cwd, settings, state, shellTimeouts) {
  const spawnHook = (context) => ({
    ...context,
    env: mergeSpawnEnv(context.env ?? process.env, state.env),
  });
  const options = {
    commandPrefix: settings.getShellCommandPrefix(),
    shellPath: settings.getShellPath(),
    spawnHook,
  };
  const tools = [];
  for (const [name, build] of [
    ['bash', pi.createBashToolDefinition],
    ['powershell', pi.createPowerShellToolDefinition],
  ]) {
    try {
      tools.push(boundShellTool(build(cwd, options), shellTimeouts));
    } catch (error) {
      log('shell tool unavailable', { tool: name, error: errorText(error) });
    }
  }
  return tools;
}

function createSessionManager(cwd, params) {
  if (params.forkFrom) {
    const source = pi.SessionManager.findById(cwd, params.forkFrom);
    if (!source) throw new Error(`pi session not found for fork: ${params.forkFrom}`);
    return pi.SessionManager.forkFrom(source, cwd);
  }
  if (params.sessionId) {
    const file = pi.SessionManager.findById(cwd, params.sessionId);
    if (file) return pi.SessionManager.open(file);
  }
  return sessionPersistence === 'memory'
    ? pi.SessionManager.inMemory(cwd)
    : pi.SessionManager.create(cwd);
}

function resolveModel(modelId) {
  if (!modelId || modelId === 'default') return undefined;
  const slash = modelId.indexOf('/');
  if (slash > 0) {
    const model = runtime.getModel(modelId.slice(0, slash), modelId.slice(slash + 1));
    if (model) return model;
  }
  for (const provider of runtime.getProviders()) {
    for (const model of runtime.getModels(provider.id)) {
      if (model.id === modelId) return model;
    }
  }
  throw new Error(`unknown pi model: ${modelId}`);
}

/**
 * Credentials reach the provider as literals taken from the run's bindings: see
 * `pi-host-protocol.mjs` for why they must never be written into process.env.
 */
function registerProvider(registration, providerEnv) {
  runtime.registerProvider(registration.providerId, {
    name: registration.name,
    baseUrl: registration.baseUrl,
    api: registration.api,
    apiKey: resolveProviderValue(`$${registration.apiKeyEnv}`, providerEnv),
    authHeader: true,
    ...(registration.headers
      ? { headers: Object.fromEntries(Object.entries(registration.headers)
        .map(([name, env]) => [name, resolveProviderValue(`$${env}`, providerEnv)])) }
      : {}),
    models: [registration.model],
  });
  const model = runtime.getModel(registration.providerId, registration.model.id);
  if (!model) throw new Error(`registered pi provider ${registration.providerId} has no model ${registration.model.id}`);
  return model;
}

function resolveRunModel(params) {
  if (params.modelProvider?.providerId) {
    return registerProvider(params.modelProvider, params.providerEnv);
  }
  return resolveModel(params.model);
}

/** Replace (never merge) the session's run bindings so a finished run leaves nothing behind. */
function setRunEnv(state, runEnv) {
  state.env = runEnvSnapshot(runEnv);
}

async function openSession(params) {
  if (!params.cwd) throw new Error('session.open requires cwd');
  const existing = params.sessionId ? sessions.get(params.sessionId) : undefined;
  if (existing) {
    existing.lastUsed = Date.now();
    return existing;
  }
  if (sessions.size >= maxSessions) evictIdleSession(true);

  const cwd = params.cwd;
  const manager = createSessionManager(cwd, params);
  const settings = pi.SettingsManager.create(cwd, agentDir);
  const state = {
    appendPrompt: typeof params.systemPrompt === 'string' ? params.systemPrompt : '',
    env: {},
  };
  setRunEnv(state, params.runEnv);
  const loader = new pi.DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager: settings,
    ...(params.noExtensions === true ? { noExtensions: true } : {}),
    appendSystemPromptOverride: (base) => (state.appendPrompt ? [...base, state.appendPrompt] : base),
  });
  await loader.reload();

  const model = resolveRunModel(params);
  const { session, modelFallbackMessage } = await pi.createAgentSession({
    cwd,
    agentDir,
    modelRuntime: runtime,
    ...(model ? { model } : {}),
    ...(params.thinkingLevel ? { thinkingLevel: params.thinkingLevel } : {}),
    sessionManager: manager,
    settingsManager: settings,
    resourceLoader: loader,
    ...(Array.isArray(params.tools) && params.tools.length > 0 ? { tools: params.tools } : {}),
    ...(params.noTools === 'all' || params.noTools === 'builtin' ? { noTools: params.noTools } : {}),
    customTools: createSessionTools(cwd, settings, state, params.shellTimeouts),
  });

  const entry = new SessionEntry(session, cwd, loader, state);
  if (modelFallbackMessage) log('model fallback', { message: modelFallbackMessage });
  entry.unsubscribe = session.subscribe((event) => forwardEvent(entry, event));
  sessions.set(session.sessionId, entry);
  log('session opened', {
    sessionId: session.sessionId,
    cwd,
    persistent: session.sessionFile !== undefined,
    model: session.model ? `${session.model.provider}/${session.model.id}` : undefined,
    provider: params.modelProvider?.providerId,
  });
  return entry;
}

function forwardEvent(entry, event) {
  const run = entry.run;
  if (!run || run.ended) return;
  entry.lastEventAt = Date.now();
  const payload = slimEvent(event);
  if (payload) {
    send({
      type: 'run.event',
      sessionId: entry.session.sessionId,
      runId: run.runId,
      event: payload,
    });
  }
  if (event.type === 'agent_settled') {
    finishRun(entry, run, event.aborted === true ? 'aborted' : 'settled');
  }
}

/**
 * Trim events to what PiRunTranslator consumes. message_update would otherwise
 * carry the full growing assistant message on every delta.
 */
function slimEvent(event) {
  switch (event.type) {
    case 'message_start':
      return { type: 'message_start', message: { role: event.message?.role } };
    case 'message_update':
      return { type: 'message_update', assistantMessageEvent: event.assistantMessageEvent };
    case 'message_end':
      return {
        type: 'message_end',
        message: {
          role: event.message?.role,
          content: event.message?.content,
          usage: event.message?.usage,
          stopReason: event.message?.stopReason,
          errorMessage: event.message?.errorMessage,
        },
      };
    case 'tool_execution_start':
      return {
        type: 'tool_execution_start',
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: event.args,
      };
    case 'tool_execution_end':
      return {
        type: 'tool_execution_end',
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        result: event.result,
        isError: event.isError === true,
      };
    case 'auto_retry_start':
      return {
        type: 'auto_retry_start',
        attempt: event.attempt,
        maxAttempts: event.maxAttempts,
        delayMs: event.delayMs,
        errorMessage: event.errorMessage,
      };
    case 'auto_retry_end':
      return {
        type: 'auto_retry_end',
        success: event.success,
        attempt: event.attempt,
        finalError: event.finalError,
      };
    case 'summarization_retry_scheduled':
      return {
        type: 'summarization_retry_scheduled',
        attempt: event.attempt,
        maxAttempts: event.maxAttempts,
        delayMs: event.delayMs,
      };
    case 'agent_settled':
      return { type: 'agent_settled', aborted: event.aborted === true };
    default:
      return undefined;
  }
}

function finishRun(entry, run, outcome, error) {
  if (run.ended) return;
  run.ended = true;
  if (entry.run === run) entry.run = undefined;
  entry.lastUsed = Date.now();
  send({
    type: 'run.end',
    sessionId: entry.session.sessionId,
    runId: run.runId,
    outcome,
    ...(error ? { error } : {}),
  });
}

function prepareRun(params) {
  const entry = sessions.get(params.sessionId);
  if (!entry) throw new Error(`unknown pi session: ${params.sessionId}`);
  if (entry.run) throw new Error(`pi session is already running (${entry.run.runId})`);
  if (typeof params.text !== 'string' || !params.text) throw new Error('run.prompt requires text');
  return entry;
}

async function applyRunSettings(entry, params) {
  setRunEnv(entry.state, params.runEnv);
  if (typeof params.systemPrompt === 'string' && params.systemPrompt !== entry.state.appendPrompt) {
    entry.state.appendPrompt = params.systemPrompt;
    // The loader caches the append prompt when it reloads, and a rebuild reads
    // that cache; rewrite it so the forced rebuild below sees the new text.
    entry.loader.appendSystemPrompt = params.systemPrompt ? [params.systemPrompt] : [];
    // The system prompt is rebuilt only when the tool set changes; re-applying
    // the current set is the public way to force that rebuild.
    entry.session.setActiveToolsByName(entry.session.getActiveToolNames());
  }
  const model = resolveRunModel(params);
  if (model) {
    const current = entry.session.model;
    if (!current || current.provider !== model.provider || current.id !== model.id) {
      await entry.session.setModel(model);
    }
  }
  if (params.thinkingLevel) entry.session.setThinkingLevel(params.thinkingLevel);
}

const IMAGE_MIME_BY_EXT = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
};

/**
 * Read the bridge's cached image files into Pi's ImageContent. An unreadable
 * or unsupported file is skipped, not fatal: the supplement text still lists
 * the path, so Pi's own read tool can pick it up.
 */
async function readInputImages(paths) {
  if (!Array.isArray(paths)) return [];
  const images = [];
  for (const path of paths) {
    if (typeof path !== 'string') continue;
    const mimeType = IMAGE_MIME_BY_EXT[path.split('.').pop()?.toLowerCase() ?? ''];
    if (!mimeType) {
      log('steer image skipped', { path, reason: 'unsupported-extension' });
      continue;
    }
    try {
      images.push({ type: 'image', data: (await readFile(path)).toString('base64'), mimeType });
    } catch (error) {
      log('steer image skipped', { path, error: errorText(error) });
    }
  }
  return images;
}

async function executePrompt(entry, run, params) {
  try {
    await applyRunSettings(entry, params);
  } catch (error) {
    finishRun(entry, run, 'error', errorText(error));
    return;
  }
  try {
    await entry.session.prompt(params.text);
  } catch (error) {
    if (run.aborted) finishRun(entry, run, 'aborted');
    else finishRun(entry, run, 'error', errorText(error));
    return;
  }
  if (!run.ended) finishRun(entry, run, run.aborted ? 'aborted' : 'settled');
}

function disposeSession(entry) {
  const run = entry.run;
  if (run) {
    run.ended = true;
    entry.run = undefined;
    send({ type: 'run.end', sessionId: entry.session.sessionId, runId: run.runId, outcome: 'aborted' });
  }
  entry.unsubscribe();
  try {
    entry.session.dispose();
  } catch (error) {
    log('dispose failed', { sessionId: entry.session.sessionId, error: errorText(error) });
  }
}

function evictIdleSession(required) {
  let oldest;
  for (const entry of sessions.values()) {
    if (entry.run) continue;
    if (!oldest || entry.lastUsed < oldest.lastUsed) oldest = entry;
  }
  if (!oldest) {
    if (required) throw new Error(`pi host reached max sessions (${maxSessions}) with no idle session to evict`);
    return false;
  }
  log('evicting idle session', { sessionId: oldest.session.sessionId, idleMs: Date.now() - oldest.lastUsed });
  const id = oldest.session.sessionId;
  disposeSession(oldest);
  sessions.delete(id);
  return true;
}

function health() {
  const now = Date.now();
  let activeRuns = 0;
  const details = [];
  for (const entry of sessions.values()) {
    if (entry.run) activeRuns += 1;
    details.push({
      sessionId: entry.session.sessionId,
      cwd: entry.cwd,
      running: Boolean(entry.run),
      ...(entry.run ? { runId: entry.run.runId, runAgeMs: now - entry.run.startedAt } : {}),
      ...(entry.lastEventAt ? { lastEventAgeMs: now - entry.lastEventAt } : {}),
      runEnvKeys: Object.keys(entry.state.env).length,
    });
  }
  return {
    pid: process.pid,
    uptimeMs: now - startedAt,
    sessions: sessions.size,
    activeRuns,
    sessionDetails: details,
    transport: options.tcp ? 'tcp' : 'stdio',
    ...(options['ipc-port'] ? { ipcPort: Number(options['ipc-port']) } : {}),
    rssBytes: process.memoryUsage.rss(),
    nodeVersion: process.versions.node,
    piVersion: pi.VERSION,
  };
}

async function handleRequest(request) {
  const params = request.params ?? {};
  switch (request.cmd) {
    case 'ping':
      reply(request.id, true, health());
      return;
    case 'health':
      reply(request.id, true, health());
      return;
    case 'session.open': {
      const entry = await openSession(params);
      reply(request.id, true, {
        sessionId: entry.session.sessionId,
        sessionFile: entry.session.sessionFile ?? null,
        model: entry.session.model ? `${entry.session.model.provider}/${entry.session.model.id}` : null,
      });
      return;
    }
    case 'session.dispose': {
      const entry = sessions.get(params.sessionId);
      if (entry) {
        disposeSession(entry);
        sessions.delete(params.sessionId);
      }
      reply(request.id, true, { disposed: Boolean(entry) });
      return;
    }
    case 'run.prompt': {
      const entry = prepareRun(params);
      const run = { runId: params.runId, ended: false, aborted: false, startedAt: Date.now() };
      entry.run = run;
      entry.lastUsed = Date.now();
      reply(request.id, true, { sessionId: entry.session.sessionId, runId: run.runId });
      void executePrompt(entry, run, params);
      return;
    }
    case 'run.steer': {
      const entry = sessions.get(params.sessionId);
      if (!entry) throw new Error(`unknown pi session: ${params.sessionId}`);
      if (!entry.run || entry.run.runId !== params.runId) throw new Error('pi run is not active');
      const images = await readInputImages(params.images);
      if (typeof params.text !== 'string' || (!params.text && images.length === 0)) {
        throw new Error('run.steer requires text or images');
      }
      const disposition = await entry.session.steer(params.text, images.length > 0 ? images : undefined);
      reply(request.id, true, { disposition });
      return;
    }
    case 'run.abort': {
      const entry = sessions.get(params.sessionId);
      if (!entry) throw new Error(`unknown pi session: ${params.sessionId}`);
      if (entry.run) entry.run.aborted = true;
      await entry.session.abort();
      reply(request.id, true, {});
      return;
    }
    case 'shutdown':
      reply(request.id, true, {});
      setTimeout(() => void shutdown('shutdown'), 25);
      return;
    default:
      throw new Error(`unknown pi-host command: ${request.cmd}`);
  }
}

async function handleLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return;
  lastActivityAt = Date.now();
  let request;
  try {
    request = JSON.parse(trimmed);
  } catch {
    send({ type: 'host.notice', level: 'warn', message: 'ignored malformed JSON frame' });
    return;
  }
  if (request && typeof request === 'object' && request.type === 'ipc.response') {
    settleIpc(request);
    return;
  }
  if (!request || typeof request !== 'object' || typeof request.cmd !== 'string' || request.id === undefined) {
    send({ type: 'host.notice', level: 'warn', message: 'ignored frame without id/cmd' });
    return;
  }
  try {
    await handleRequest(request);
  } catch (error) {
    reply(request.id, false, error);
  }
}

let shuttingDown = false;
async function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  log('shutting down', { reason });
  clearInterval(reaper);
  for (const [id, entry] of sessions) {
    disposeSession(entry);
    sessions.delete(id);
  }
  process.exit(0);
}

const reaper = setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of sessions) {
    if (entry.run) continue;
    if (now - entry.lastUsed < idleTtlMs) continue;
    log('idle session expired', { sessionId: id, idleMs: now - entry.lastUsed });
    disposeSession(entry);
    sessions.delete(id);
  }
  if (sessions.size === 0 && now - lastActivityAt > emptyExitMs) {
    void shutdown('idle-empty');
  }
}, Math.min(60_000, Math.max(1_000, Math.floor(Math.min(idleTtlMs, emptyExitMs) / 2))));
reaper.unref?.();

/** Workflow calls a worker makes inside the workcell, waiting on the bridge. */
const pendingIpc = new Map();
let ipcSeq = 1;

function requestBridge(payload, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const id = ipcSeq++;
    const timer = setTimeout(() => {
      pendingIpc.delete(id);
      reject(new Error('the bridge did not answer the workflow call in time'));
    }, timeoutMs);
    pendingIpc.set(id, (answer) => {
      clearTimeout(timer);
      resolve(answer);
    });
    send({ type: 'ipc.request', requestId: id, ...payload });
  });
}

function settleIpc(request) {
  const resolve = pendingIpc.get(request.requestId);
  pendingIpc.delete(request.requestId);
  resolve?.(request);
}

/**
 * The worker's `$AGENT_WORKFLOW_ENDPOINT` points here: same POST shape and
 * bearer token as the bridge's own endpoint, forwarded over the frame channel.
 */
function serveIpc(port) {
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/workflow') {
      response.statusCode = 404;
      response.end('{}');
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      response.statusCode = 400;
      response.end(JSON.stringify({ ok: false, error: 'expected a JSON body' }));
      return;
    }
    try {
      const answer = await requestBridge({
        token: (request.headers.authorization ?? '').replace(/^Bearer /, ''),
        method: body.method,
        args: body.args,
      });
      response.statusCode = Number.isInteger(answer.status) ? answer.status : 200;
      response.setHeader('Content-Type', 'application/json');
      response.end(typeof answer.body === 'string' && answer.body ? answer.body : JSON.stringify({ ok: false, error: 'empty answer from the bridge' }));
    } catch (error) {
      response.statusCode = 502;
      response.end(JSON.stringify({ ok: false, error: errorText(error) }));
    }
  });
  server.listen(Number(port), '127.0.0.1', () => log('ipc proxy listening', { port }));
  return server;
}

// Frames dispatch concurrently: a stalled abort or a slow session.open on one
// session must not block prompts for the others. Same-session ordering is the
// bridge's responsibility (it never opens or prompts one session twice).
function dispatchLines(source) {
  let buffer = '';
  return {
    push(chunk) {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf('\n');
        if (newline === -1) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.trim()) void handleLine(line).catch((error) => log('frame failed', { error: errorText(error) }));
      }
    },
    flush() {
      const rest = buffer;
      buffer = '';
      if (rest.trim()) void handleLine(rest).catch(() => {});
    },
  };
}

/** One connected bridge; a reconnect replaces it and keeps the sessions. */
function serveTcp(options) {
  // `:port` (empty host) listens on every interface, dual stack: a forwarded
  // connection arrives on the unit's address, which may only be IPv6.
  const match = /^(.*):(\d+)$/.exec(options.tcp ?? '');
  if (!match) throw new Error('--tcp expects [host]:port');
  const [, host, port] = match;
  const server = createServer((socket) => {
    log('client connected', { remote: `${socket.remoteAddress}:${socket.remotePort}` });
    writeFrame = (line) => {
      if (!socket.destroyed) socket.write(line);
    };
    const lines = dispatchLines();
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => lines.push(chunk));
    socket.on('error', (error) => log('client error', { error: errorText(error) }));
    socket.on('close', () => {
      lines.flush();
      writeFrame = (line) => realStdoutWrite(line);
      log('client disconnected; sessions stay alive', { sessions: sessions.size });
    });
    send({
      type: 'host.ready',
      data: {
        pid: process.pid,
        nodeVersion: process.versions.node,
        piVersion: pi.VERSION,
        agentDir,
        idleTtlMs,
        maxSessions,
        sessionPersistence,
        transport: 'tcp',
      },
    });
  });
  // The listener is what keeps this process alive between connections; the
  // reaper (and an explicit `shutdown`) decides when an idle host goes away.
  const onListening = () => log('listening', { host: host || '*', port });
  if (host) server.listen(Number(port), host, onListening);
  else server.listen(Number(port), onListening);
  return server;
}

if (options['ipc-port']) {
  try {
    serveIpc(options['ipc-port']);
  } catch (error) {
    send({ type: 'host.fatal', error: errorText(error) });
    process.exit(2);
  }
}

const tcp = Boolean(options.tcp);
if (tcp) {
  try {
    serveTcp(options);
  } catch (error) {
    send({ type: 'host.fatal', error: errorText(error) });
    process.exit(2);
  }
} else {
  // stdin closing means the bridge exited; the host must not outlive it.
  const lines = dispatchLines();
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => lines.push(chunk));
  process.stdin.on('end', () => {
    lines.flush();
    // The bridge is gone; finish promptly rather than waiting for stuck runs.
    setTimeout(() => void shutdown('stdin closed'), 100);
  });
  process.stdin.on('error', () => void shutdown('stdin error'));
}

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => void shutdown(signal));
}
process.on('uncaughtException', (error) => {
  log('uncaught exception', { error: errorText(error), stack: error?.stack });
  // A shared host that keeps serving after an uncaught exception can answer
  // every session from a corrupted state. Fail loudly instead: the bridge fails
  // the in-flight runs and starts a fresh host for the next one.
  send({ type: 'host.fatal', error: `pi host crashed: ${errorText(error)}` });
  setTimeout(() => void shutdown('uncaught exception'), 25);
});
process.on('unhandledRejection', (error) => {
  log('unhandled rejection', { error: errorText(error) });
});

if (!tcp) {
  send({
    type: 'host.ready',
    data: {
      pid: process.pid,
      nodeVersion: process.versions.node,
      piVersion: pi.VERSION,
      agentDir,
      idleTtlMs,
      maxSessions,
      sessionPersistence,
      transport: 'stdio',
    },
  });
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}
