import { WEB_DISPLAY_DEFAULTS, type WebDisplayConfig } from '../../config/channel-display';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  assertConversationCommandsSupported,
  handleConversationCommand,
} from '../../commands/conversation';
import { commandDefinitionsFor, commandHelpLines } from '../../commands/catalog';
import { createWebCommandChannel } from './command-channel';
import { dirname, join } from 'node:path';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import type { ChannelPlugin } from '../plugin';
import { checkToken, HttpError, isLocalRequest, readJsonBody, sendHtml, sendJson } from '../../ui/http';
import { createWebChatRuntime, type WebChatRuntimeOptions, type WebChatRuntime } from './runtime';
import { createWebRunOutput } from './output';
import { filterWebState } from './config';
import html from './generated/index.html';
import { acquireHostLock } from '../../runtime/host-lock';
import { AGENT_OPTIONS, isAgentKind } from '../../agent/backends';
import { DashboardApi } from '@kuribohg/agent-workflows';
import { getBuildInfo } from '../../build-info';
import { recordable, WebTranscripts, type TranscriptEvent, type WebConversation } from './transcript';

export interface WebChannelOptions extends Omit<WebChatRuntimeOptions, 'authorize'> {
  port?: number;
  display?: Partial<WebDisplayConfig>;
  /**
   * Where to record the address, the token and the process (0600), for a local program that brings the page to a
   * browser: a proxy that adds the token, or a command that opens the page. Removed on close.
   */
  stateFile?: string;
}
export interface WebConnection {
  url: string;
  port: number;
  close(): Promise<void>;
}

/** Local operator channel. External authentication belongs in a separately configured host. */
export function createWebPlugin(options: WebChannelOptions): ChannelPlugin<WebConnection> {
  return { id: `web:${options.namespace}`, connect: () => startWebChannel(options) };
}

async function startWebChannel(options: WebChannelOptions): Promise<WebConnection> {
  assertConversationCommandsSupported('web');
  const lock = await acquireHostLock(join(options.stateDir, 'web-host.lock'));
  if (!lock) throw new Error('Web state directory is already in use or cannot be locked');
  let runtime: WebChatRuntime;
  const shown = { ...WEB_DISPLAY_DEFAULTS, ...options.display };
  const transcripts = new WebTranscripts(join(options.stateDir, 'web-chat'));
  try {
    await transcripts.load();
    runtime = await createWebChatRuntime({ ...options, authorize: async identity => identity.actorId === 'local',
      filterState: state => filterWebState(state, shown),
      observe: (identity, event) => { if (identity.actorId === 'local') transcripts.observe(identity.conversationId, event); } });
  }
  catch (error) { await lock.release(); throw error; }
  const token = randomBytes(32).toString('hex');
  let closing = false;
  // The page's workflow panel reads this host's own store through the dashboard's read-only views.
  const workflows = options.workflows ? new DashboardApi([{ name: WORKFLOW_SOURCE, path: join(options.stateDir, 'workflows.sqlite') }]) : undefined;
  const site: Site = { runtime, transcripts, workflows, token, display: shown, options };
  const server = createServer((req, res) => {
    handle(req, res, site, closing).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { error: 'request failed' });
      else res.end();
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(options.port ?? 0, '127.0.0.1', resolve);
    });
  } catch (error) { await runtime.close(); await transcripts.close(); workflows?.close(); await lock.release(); throw error; }
  const port = (server.address() as AddressInfo).port;
  const origin = `http://127.0.0.1:${port}`;
  const stateFile = options.stateFile;
  const release = async () => {
    server.close(); server.closeAllConnections();
    await runtime.close(); await transcripts.close(); workflows?.close(); await lock.release();
  };
  if (stateFile) {
    try { await recordAddress(stateFile, { url: origin, port, token, pid: process.pid, startedAt: new Date().toISOString() }); }
    catch (error) { await release(); throw error; }
  }
  return {
    port, url: `${origin}/#token=${token}`,
    async close() {
      closing = true;
      if (stateFile) await forgetAddress(stateFile);
      const closed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      try {
        // Runs stopped by the runtime still report how they ended; the record closes after it has that.
        await runtime.close();
        await transcripts.close();
        workflows?.close();
        server.closeAllConnections();
        await closed;
      } finally { await lock.release(); }
    },
  };
}

/** Written whole or not at all, and readable by its owner only: it holds the token. */
async function recordAddress(file: string, record: { url: string; port: number; token: string; pid: number; startedAt: string }): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, file);
}

/** Removes the record unless another process has since written its own there. */
async function forgetAddress(file: string): Promise<void> {
  try {
    if ((JSON.parse(await readFile(file, 'utf8')) as { pid?: unknown }).pid === process.pid) await rm(file, { force: true });
  } catch { /* already gone, or not ours to read */ }
}

/** The name the page's workflow panel knows this host's store by. */
const WORKFLOW_SOURCE = 'chat';

interface Site {
  runtime: WebChatRuntime;
  transcripts: WebTranscripts;
  workflows?: DashboardApi;
  token: string;
  display: WebDisplayConfig;
  options: WebChannelOptions;
}

async function handle(req: IncomingMessage, res: ServerResponse, site: Site, closing: boolean) {
  const { runtime, transcripts, token, display } = site;
  if (!isLocalRequest(req)) { sendJson(res, 403, { error: 'forbidden' }); return; }
  const url = new URL(req.url ?? '/', 'http://localhost');
  if ((url.pathname === '/' || url.pathname === '/index.html') && req.method === 'GET') { sendHtml(res, html); return; }
  if (!checkToken(req, url, token)) { sendJson(res, 401, { error: 'unauthorized' }); return; }
  if (closing) { sendJson(res, 503, { error: 'channel is closing' }); return; }
  if (req.method === 'GET' && await read(req, res, url, site)) return;
  if (req.method === 'GET' && url.pathname === '/api/engine') {
    try {
      const conversationId = boundedValue(url.searchParams.get('conversationId'), 'conversationId');
      const identity = { actorId: 'local', conversationId };
      sendJson(res, 200, {
        agent: await runtime.agentKind(identity),
        defaultAgent: runtime.defaultAgentKind,
        options: AGENT_OPTIONS,
      });
    } catch (error) {
      sendJson(res, error instanceof HttpError ? error.status : 400,
        { error: error instanceof Error ? error.message : 'invalid request' });
    }
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/events') { await streamEvents(req, res, url, runtime); return; }
  if (req.method !== 'POST' || !['/api/chat', '/api/send', '/api/command', '/api/stop', '/api/input', '/api/answer', '/api/engine',
    '/api/conversation', '/api/conversation/delete'].includes(url.pathname)) {
    sendJson(res, 404, { error: 'not found' }); return;
  }
  try {
    const body = await readJsonBody(req);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'expected an object');
    const data = body as Record<string, unknown>;
    const required = (key: string) => {
      const value = data[key];
      return boundedValue(value, key);
    };
    const identity = { actorId: 'local', conversationId: required('conversationId') };
    const id = identity.conversationId;
    if (url.pathname === '/api/conversation') {
      let conversation = transcripts.get(id);
      if (!conversation) throw new HttpError(404, 'no such conversation');
      if (typeof data.title === 'string') conversation = await transcripts.rename(id, boundedValue(data.title, 'title'));
      if (typeof data.pinned === 'boolean') conversation = await transcripts.pin(id, data.pinned);
      sendJson(res, 200, { conversation });
      return;
    }
    if (url.pathname === '/api/conversation/delete') {
      if (!transcripts.get(id)) throw new HttpError(404, 'no such conversation');
      if ((await runtime.status(identity)).activeRunId || !await transcripts.remove(id)) throw new HttpError(409, '任务还在运行，先停止它再删除对话。');
      // The agent's own session goes with the conversation; a new conversation never continues it.
      await runtime.reset(identity);
      sendJson(res, 200, { deleted: true });
      return;
    }
    if (url.pathname === '/api/engine') {
      const agent = required('agent');
      if (!isAgentKind(agent)) throw new HttpError(400, 'invalid agent');
      try {
        await runtime.setAgentKind(identity, agent);
      } catch (error) {
        if (error instanceof Error && /run is active/.test(error.message)) {
          throw new HttpError(409, error.message);
        }
        throw error;
      }
      sendJson(res, 200, { agent: await runtime.agentKind(identity), defaultAgent: runtime.defaultAgentKind });
      return;
    }
    if (url.pathname === '/api/stop') {
      sendJson(res, 200, { stopped: await runtime.stop(identity, required('runId')) }); return;
    }
    if (url.pathname === '/api/input') {
      const text = required('text');
      const receipt = await runtime.sendInput(identity, required('runId'), { text, messageId: required('messageId') });
      if (receipt.status === 'accepted') await transcripts.addUser(id, text, 'input', messageId(data));
      sendJson(res, 200, receipt); return;
    }
    if (url.pathname === '/api/answer') {
      const answers = answerLists(data.answers);
      const requestId = required('requestId');
      const result = await runtime.answerQuestion(identity, requestId, answers);
      if (result.settled) await transcripts.recordAnswers(id, requestId, answers);
      sendJson(res, 200, result); return;
    }
    const prompt = required('text');
    if (url.pathname === '/api/command') {
      // The commands are shared with every ConversationRuntime-backed front
      // end; this channel collects the handler's replies for this response.
      const web = createWebCommandChannel();
      await transcripts.addUser(id, prompt, 'command', messageId(data));
      const handled = await handleConversationCommand(prompt, {
        runtime,
        identity,
        channel: web.channel,
        message: {
          messageId: randomUUID(),
          chatId: identity.conversationId,
          chatType: 'p2p',
          senderId: identity.actorId,
          content: prompt,
        },
        surface: 'web',
        // `/workflow` is not in the catalogue; the runtime owns it.
        command: (name, args, host) => name === 'workflow'
          ? host.runtime.workflowCommand(host.identity, args).then(reply => reply ?? null)
          : Promise.resolve(undefined),
      });
      if (!handled) throw new HttpError(400, 'unknown command');
      const reply = web.reply();
      const shown = web.markdown();
      if (shown !== undefined) await transcripts.addNotice(id, shown, 'command');
      sendJson(res, 200, reply === undefined ? {} : { reply });
      return;
    }
    if (url.pathname === '/api/send') {
      await transcripts.addUser(id, prompt, 'message', messageId(data));
      const run = await runtime.submit({ ...identity, prompt });
      if (run.ok) sendJson(res, 200, { runId: run.runId });
      else {
        // The message is in the record; so is why nothing came of it.
        await transcripts.addNotice(id, run.rejectReason.userVisible, 'bridge');
        sendJson(res, 409, { error: run.rejectReason.userVisible });
      }
      return;
    }
    const controller = new AbortController();
    const disconnected = () => { if (!res.writableFinished) controller.abort(); };
    res.on('close', disconnected);
    const write = async (event: unknown) => {
      controller.signal.throwIfAborted();
      if (!res.headersSent) res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Accel-Buffering': 'no' });
      if (!res.write(`${JSON.stringify(event)}\n`)) await once(res, 'drain', { signal: controller.signal });
    };
    try {
      // A question outlives a client that went away; the answer endpoint then reports it unanswered.
      const questions = {
        ask: (question: object) => write({ type: 'run.question', ...question }),
        settled: (question: object) => write({ type: 'run.question.settled', ...question }).catch(() => {}),
      };
      const run = await runtime.start({ ...identity, prompt, signal: controller.signal, questions },
        createWebRunOutput(write, display));
      if (!run.ok) { sendJson(res, 409, { error: run.rejectReason.userVisible }); return; }
      await run.done;
      await write({ type: 'run.finished', runId: run.execution.runId, result: await run.execution.result });
      res.end();
    } catch (error) {
      if (controller.signal.aborted) return;
      if (res.headersSent) { await write({ type: 'run.failed', error: 'conversation failed' }); res.end(); }
      else throw error;
    } finally { res.off('close', disconnected); }
  } catch (error) {
    if (!res.headersSent) sendJson(res, error instanceof HttpError ? error.status : 400,
      { error: error instanceof Error ? error.message : 'invalid request' });
    else throw error;
  }
}

/** Answers a GET of the page's own API; false when the path is not one of them. */
async function read(req: IncomingMessage, res: ServerResponse, url: URL, site: Site): Promise<boolean> {
  const { runtime, transcripts, display, options } = site;
  const path = url.pathname;
  try {
    if (path === '/api/meta') {
      const build = getBuildInfo();
      sendJson(res, 200, {
        version: build.version, commit: build.commit,
        workspace: options.config.workspaces.default,
        agent: runtime.defaultAgentKind, agents: AGENT_OPTIONS,
        display, workflows: Boolean(site.workflows),
        commands: commandDefinitionsFor('web').map(definition => ({ name: definition.name, aliases: definition.aliases ?? [],
          help: commandHelpLines('', [definition], 'web').map(line => line.replace(/^- /, '')) })),
      });
      return true;
    }
    if (path === '/api/conversations') { sendJson(res, 200, { conversations: transcripts.list() }); return true; }
    if (path === '/api/stream') { await streamPage(req, res, url, site); return true; }
    if (path === '/api/items') {
      const id = boundedValue(url.searchParams.get('conversationId'), 'conversationId');
      const before = Number(url.searchParams.get('before'));
      if (!recordable(id) || !Number.isSafeInteger(before) || before < 0) throw new HttpError(400, 'invalid request');
      sendJson(res, 200, await transcripts.page(id, before, Number(url.searchParams.get('limit')) || 60));
      return true;
    }
    if (path === '/api/state') {
      const identity = { actorId: 'local', conversationId: boundedValue(url.searchParams.get('conversationId'), 'conversationId') };
      const status = await runtime.status(identity);
      const preferences = (options.configForAgent?.(status.agentKind, identity) ?? options.config).preferences;
      sendJson(res, 200, {
        agent: status.agentKind, ...(status.activeRunId ? { activeRunId: status.activeRunId } : {}),
        cwd: await runtime.workingDirectory(identity) ?? options.config.workspaces.default,
        ...(preferences.model ? { model: preferences.model } : {}),
        ...(preferences.reasoningEffort ? { effort: preferences.reasoningEffort } : {}),
      });
      return true;
    }
    if (path === '/api/workflows' || path.startsWith('/api/workflows/')) {
      if (!site.workflows) throw new HttpError(404, 'workflows are off');
      const rest = path.slice('/api/workflows'.length);
      if (!rest) {
        // The workflows of one conversation: the store holds every conversation's.
        const identity = { actorId: 'local', conversationId: boundedValue(url.searchParams.get('conversationId'), 'conversationId') };
        const scope = runtime.scopeKey(identity);
        const listed = site.workflows.handle(`s/${WORKFLOW_SOURCE}/workflows`, new URLSearchParams({ finished: '100' }));
        const all = listed.status === 200 ? (listed.body as { workflows: Array<{ scope: string }> }).workflows : [];
        sendJson(res, 200, { source: WORKFLOW_SOURCE, workflows: all.filter(workflow => workflow.scope === scope) });
        return true;
      }
      const etag = req.headers['if-none-match'];
      const answer = site.workflows.handle(rest, url.searchParams, typeof etag === 'string' ? etag : undefined);
      res.writeHead(answer.status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff', ...(answer.etag ? { ETag: answer.etag } : {}) });
      res.end(answer.status === 304 ? undefined : JSON.stringify(answer.body));
      return true;
    }
  } catch (error) {
    sendJson(res, error instanceof HttpError ? error.status : 400, { error: error instanceof Error ? error.message : 'invalid request' });
    return true;
  }
  return false;
}

/** A slow reader is disconnected rather than buffered without bound; it reconnects with its cursor. */
const MAX_UNSENT_EVENTS = 1_000;
/** A quiet connection is told it is alive this often, so the page can tell a dead one. */
const PING_MS = 20_000;

type PageEvent = TranscriptEvent | { type: 'conversations'; conversations: WebConversation[] } | { type: 'ping' };

/**
 * Everything one open page follows, on one connection: the list of conversations, and the conversation it shows.
 * A browser allows few connections to a host, and every tab of the chat holds this one.
 */
async function streamPage(req: IncomingMessage, res: ServerResponse, url: URL, site: Site): Promise<void> {
  const { transcripts } = site;
  const id = url.searchParams.get('conversationId');
  const since = url.searchParams.get('since');
  const tail = url.searchParams.get('tail');
  if (id !== null && !recordable(id)) { sendJson(res, 400, { error: 'invalid conversationId' }); return; }
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Accel-Buffering': 'no' });
  let unsent = 0;
  let writes: Promise<void> = Promise.resolve();
  const send = (event: PageEvent) => {
    if (res.destroyed) return;
    if (++unsent > MAX_UNSENT_EVENTS) { res.destroy(); return; }
    writes = writes.then(async () => {
      if (!res.destroyed && !res.write(`${JSON.stringify(event)}\n`)) await once(res, 'drain');
    }).catch(() => { res.destroy(); }).finally(() => { unsent--; });
  };
  let listed: NodeJS.Timeout | undefined;
  const list = () => { listed ??= setTimeout(() => { listed = undefined; send({ type: 'conversations', conversations: transcripts.list() }); }, 80); };
  send({ type: 'conversations', conversations: transcripts.list() });
  const stops = [transcripts.watch(list)];
  const ping = setInterval(() => send({ type: 'ping' }), PING_MS);
  const stop = () => {
    clearInterval(ping);
    if (listed) clearTimeout(listed);
    for (const end of stops.splice(0)) end();
  };
  req.on('close', stop);
  res.on('close', stop);
  if (id !== null) {
    const unfollow = await transcripts.follow(id, {
      epoch: url.searchParams.get('epoch') ?? undefined,
      since: since === null ? undefined : Number(since),
      tail: tail === null ? undefined : Number(tail) || undefined,
    }, send);
    if (res.destroyed) unfollow(); else stops.push(unfollow);
  }
  if (res.destroyed) stop();
}

/** The conversation's events as NDJSON until the client goes away; `stream` and `after` resume a previous connection. */
async function streamEvents(req: IncomingMessage, res: ServerResponse, url: URL, runtime: WebChatRuntime): Promise<void> {
  let identity: { actorId: string; conversationId: string };
  let after: number | undefined;
  try {
    identity = { actorId: 'local', conversationId: boundedValue(url.searchParams.get('conversationId'), 'conversationId') };
    const raw = url.searchParams.get('after');
    after = raw === null ? undefined : Number(raw);
    if (after !== undefined && (!Number.isSafeInteger(after) || after < 0)) throw new HttpError(400, 'invalid after');
  } catch (error) {
    sendJson(res, error instanceof HttpError ? error.status : 400, { error: error instanceof Error ? error.message : 'invalid request' });
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Accel-Buffering': 'no' });
  let unsent = 0;
  let writes: Promise<void> = Promise.resolve();
  const unsubscribe = await runtime.subscribe(identity, { stream: url.searchParams.get('stream') ?? undefined, after }, event => {
    if (res.destroyed) return;
    if (++unsent > MAX_UNSENT_EVENTS) { res.destroy(); return; }
    writes = writes.then(async () => {
      if (!res.destroyed && !res.write(`${JSON.stringify(event)}\n`)) await once(res, 'drain');
    }).catch(() => { res.destroy(); }).finally(() => { unsent--; });
  });
  req.on('close', unsubscribe);
  res.on('close', unsubscribe);
  if (res.destroyed) unsubscribe();
}

/** One list of answers per question; the runtime checks that it fits the request. */
function answerLists(value: unknown): string[][] {
  if (!Array.isArray(value) || value.length > 32 ||
      !value.every(item => Array.isArray(item) && item.length <= 64 && item.every(answer => typeof answer === 'string'))) {
    throw new HttpError(400, 'invalid answers');
  }
  return value as string[][];
}

/** The page's own name for a message it sent, when it gave one. */
function messageId(data: Record<string, unknown>): string | undefined {
  return typeof data.messageId === 'string' ? data.messageId : undefined;
}

function boundedValue(value: unknown, key: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 100_000) {
    throw new HttpError(400, `invalid ${key}`);
  }
  return value;
}
