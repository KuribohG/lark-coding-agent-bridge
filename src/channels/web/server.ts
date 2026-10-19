import { WEB_DISPLAY_DEFAULTS, type WebDisplayConfig } from './config';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import type { ChannelPlugin } from '../plugin';
import { checkToken, HttpError, isLocalRequest, readJsonBody, sendHtml, sendJson } from '../../ui/http';
import { createWebChatRuntime, type WebChatRuntimeOptions, type WebChatRuntime } from './runtime';
import { createWebRunOutput } from './output';
import html from './page.html';
import { acquireHostLock } from '../../runtime/host-lock';

export interface WebChannelOptions extends Omit<WebChatRuntimeOptions, 'authorize'> {
  port?: number;
  display?: Partial<WebDisplayConfig>;
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
  const lock = await acquireHostLock(join(options.stateDir, 'web-host.lock'));
  if (!lock) throw new Error('Web state directory is already in use or cannot be locked');
  let runtime: WebChatRuntime;
  try { runtime = await createWebChatRuntime({ ...options, authorize: async identity => identity.actorId === 'local' }); }
  catch (error) { await lock.release(); throw error; }
  const token = randomBytes(32).toString('hex');
  let closing = false;
  const server = createServer((req, res) => {
    handle(req, res, runtime, token, closing, { ...WEB_DISPLAY_DEFAULTS, ...options.display }).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { error: 'request failed' });
      else res.end();
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(options.port ?? 0, '127.0.0.1', resolve);
    });
  } catch (error) { await runtime.close(); await lock.release(); throw error; }
  const port = (server.address() as AddressInfo).port;
  return {
    port, url: `http://127.0.0.1:${port}/#token=${token}`,
    async close() {
      closing = true;
      const closed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      try {
        await runtime.close();
        server.closeAllConnections();
        await closed;
      } finally { await lock.release(); }
    },
  };
}

async function handle(req: IncomingMessage, res: ServerResponse, runtime: WebChatRuntime, token: string, closing: boolean, display: WebDisplayConfig) {
  if (!isLocalRequest(req)) { sendJson(res, 403, { error: 'forbidden' }); return; }
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname === '/' && req.method === 'GET') { sendHtml(res, html); return; }
  if (!checkToken(req, url, token)) { sendJson(res, 401, { error: 'unauthorized' }); return; }
  if (closing) { sendJson(res, 503, { error: 'channel is closing' }); return; }
  if (req.method !== 'POST' || !['/api/chat', '/api/stop', '/api/input'].includes(url.pathname)) {
    sendJson(res, 404, { error: 'not found' }); return;
  }
  try {
    const body = await readJsonBody(req);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'expected an object');
    const data = body as Record<string, unknown>;
    const required = (key: string) => {
      const value = data[key];
      if (typeof value !== 'string' || !value.trim() || value.length > 100_000) throw new HttpError(400, `invalid ${key}`);
      return value;
    };
    const identity = { actorId: 'local', conversationId: required('conversationId') };
    if (url.pathname === '/api/stop') {
      sendJson(res, 200, { stopped: await runtime.stop(identity, required('runId')) }); return;
    }
    if (url.pathname === '/api/input') {
      sendJson(res, 200, await runtime.sendInput(identity, required('runId'), {
        text: required('text'), messageId: required('messageId'),
      })); return;
    }
    const prompt = required('text');
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
      const run = await runtime.start({ ...identity, prompt, signal: controller.signal }, createWebRunOutput(write, display));
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
