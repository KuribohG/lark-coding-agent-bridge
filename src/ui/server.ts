import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { log } from '../core/logger';
import consoleHtml from './generated/index.html';
import {
  checkToken,
  HttpError,
  isLocalRequest,
  sendHtml,
  sendJson,
} from './http';
import { routeApi } from './routes';
import type { UiServerDeps, UiServerHandle } from './types';

const DEFAULT_HOST = '127.0.0.1';

/**
 * Start the supervisor's single management console. Binds 127.0.0.1, mints a
 * random per-process token gating every `/api/*` call, rejects non-localhost /
 * cross-origin. Backed by the supervisor: it can list/start/stop/configure any
 * profile in-process (online → live; offline → written to disk).
 */
export async function startUiServer(deps: UiServerDeps): Promise<UiServerHandle> {
  const host = deps.host ?? DEFAULT_HOST;
  const token = randomBytes(32).toString('hex');

  const server = createServer((req, res) => {
    handle(req, res, deps, token).catch((err) => {
      log.warn('ui', 'request-failed', { err: String(err) });
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
      else res.end();
    });
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(deps.port ?? 0, host, () => resolve((server.address() as AddressInfo).port));
  });

  const url = `http://${host}:${port}/?token=${token}`;
  log.info('ui', 'listening', { url: `http://${host}:${port}` });

  return {
    url,
    token,
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  deps: UiServerDeps,
  token: string,
): Promise<void> {
  if (!isLocalRequest(req)) {
    sendJson(res, 403, { error: 'forbidden' });
    return;
  }
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;

  if (!path.startsWith('/api/')) {
    if (path === '/' || path === '/index.html') sendHtml(res, consoleHtml);
    else sendJson(res, 404, { error: 'not found' });
    return;
  }

  if (!checkToken(req, url, token)) {
    sendJson(res, 401, { error: 'unauthorized' });
    return;
  }

  try {
    await routeApi(req, res, deps, url);
  } catch (err) {
    if (err instanceof HttpError) {
      sendJson(res, err.status, { error: err.message });
      return;
    }
    throw err;
  }
}
