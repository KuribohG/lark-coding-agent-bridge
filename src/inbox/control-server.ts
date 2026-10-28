import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFile, unlink } from 'node:fs/promises';
import { log } from '../core/logger';
import { writeFileAtomic } from '../platform/atomic-write';
import { HttpError, isLocalRequest, readJsonBody, sendJson } from '../ui/http';

export interface InboxControlMetadata {
  profile: string;
  ownerOpenId: string;
}

export interface InboxControlSidecar extends InboxControlMetadata {
  version: 1;
  url: string;
  token: string;
  pid: number;
  startedAt: string;
}

export interface InboxControlHandle {
  readonly url: string;
  readonly port: number;
  close(): Promise<void>;
}

type CommandHandler = (input: unknown) => Promise<unknown>;

/**
 * Owner-only control surface for the Jupyter workbench. The listener is
 * loopback-only and every request needs a random per-process token. The token
 * is stored outside the Jupyter-visible inbox directory.
 */
export async function startInboxControl(
  sidecarPath: string,
  metadata: InboxControlMetadata,
  command: CommandHandler,
): Promise<InboxControlHandle> {
  const token = randomBytes(32).toString('base64url');
  const server = createServer((req, res) => {
    void handle(req, res, sidecarPath, token, metadata, command).catch(error => {
      log.warn('inbox-control', 'request-failed', { err: String(error) });
      if (!res.headersSent) {
        sendJson(res, error instanceof HttpError ? error.status : 500, {
          error: error instanceof Error ? error.message : '控制请求失败',
        });
      } else {
        res.end();
      }
    });
  });
  server.requestTimeout = 120_000;
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });
  const info: InboxControlSidecar = {
    version: 1,
    url: `http://127.0.0.1:${port}`,
    token,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    ...metadata,
  };
  try {
    await writeFileAtomic(sidecarPath, `${JSON.stringify(info, null, 2)}\n`, { mode: 0o600 });
  } catch (error) {
    await closeServer(server);
    throw error;
  }
  log.info('inbox-control', 'listening', { url: info.url, pid: info.pid });
  return {
    url: info.url,
    port,
    close: async () => {
      await closeServer(server);
      await removeOwnedSidecar(sidecarPath, token);
    },
  };
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  sidecarPath: string,
  token: string,
  metadata: InboxControlMetadata,
  command: CommandHandler,
): Promise<void> {
  if (!isLocalRequest(req)) throw new HttpError(403, 'forbidden');
  if (!authorized(req, token)) throw new HttpError(401, 'unauthorized');
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  if (req.method === 'GET' && url.pathname === '/health') {
    sendJson(res, 200, {
      ok: true,
      pid: process.pid,
      profile: metadata.profile,
      ownerOpenId: metadata.ownerOpenId,
      sidecarPath,
    });
    return;
  }
  if (req.method !== 'POST' || url.pathname !== '/command') throw new HttpError(404, 'not found');
  sendJson(res, 200, { ok: true, result: await command(await readJsonBody(req)) });
}

function authorized(req: IncomingMessage, token: string): boolean {
  const value = String(req.headers.authorization || '');
  const provided = value.startsWith('Bearer ') ? value.slice(7) : '';
  if (provided.length !== token.length) return false;
  return timingSafeEqual(Buffer.from(provided), Buffer.from(token));
}

async function removeOwnedSidecar(path: string, token: string): Promise<void> {
  try {
    const current = JSON.parse(await readFile(path, 'utf8')) as Partial<InboxControlSidecar>;
    if (current.token === token) await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn('inbox-control', 'sidecar-remove-failed', { err: String(error) });
    }
  }
}

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeIdleConnections();
    server.closeAllConnections();
  });
}
