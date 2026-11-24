import { randomBytes } from 'node:crypto';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname } from 'node:path';
import { gzipSync } from 'node:zlib';
import { DashboardApi, sameToken, type DashboardSource } from './api';
import page from './page.html';

export interface DashboardOptions {
  sources: readonly DashboardSource[];
  /** Defaults to 127.0.0.1. The dashboard shows prompts, results and messages of every workflow in its sources. */
  host?: string;
  /** Defaults to a port the system picks. */
  port?: number;
  /**
   * What every API request must present. Generated when absent. `false` serves without one, for a listener that only
   * an authenticating proxy can reach.
   */
  token?: string | false;
  /**
   * Where to record the address, the token and the process (0600), for a local program that brings the dashboard to
   * a browser: a proxy that adds the token, or a command that opens the page. Removed on close.
   */
  stateFile?: string;
  /** Shown in the page beside its name: which host or deployment this is. */
  label?: string;
}

export interface DashboardHandle {
  /** Opens the dashboard in a browser, the token included. */
  url: string;
  port: number;
  token?: string;
  close(): Promise<void>;
}

const HEADERS = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };

function send(request: IncomingMessage, response: ServerResponse, status: number, type: string, text: string, headers: Record<string, string> = {}): void {
  const zipped = text.length > 1024 && /\bgzip\b/.test(String(request.headers['accept-encoding'] ?? ''));
  response.writeHead(status, { ...HEADERS, 'Content-Type': type, 'Cache-Control': 'no-cache', ...(zipped ? { 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' } : {}), ...headers });
  response.end(zipped ? gzipSync(text) : text);
}

/** Render the standalone read-only workflow dashboard HTML document for direct HTTP or RPC embedding. */
export function renderDashboardPage(label = ''): string {
  return page.replace('__DASHBOARD_LABEL__', JSON.stringify(label).replace(/</g, '\\u003c'));
}

/**
 * Serves the dashboard page and its read-only API over HTTP. The page asks for everything relative to its own
 * address, so it works unchanged behind a proxy that puts it under a path.
 */
export async function startDashboard(options: DashboardOptions): Promise<DashboardHandle> {
  const api = new DashboardApi(options.sources);
  const token = options.token === false ? undefined : options.token || randomBytes(24).toString('hex');
  const host = options.host ?? '127.0.0.1';
  const html = renderDashboardPage(options.label ?? '');

  const server = createServer((request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (request.method !== 'GET' && request.method !== 'HEAD') return send(request, response, 405, 'application/json', '{"error":"The dashboard is read-only"}', { Allow: 'GET, HEAD' });
      if (url.pathname === '/' || url.pathname === '/index.html') return send(request, response, 200, 'text/html; charset=utf-8', html);
      if (!url.pathname.startsWith('/api/')) return send(request, response, 404, 'application/json', '{"error":"Not found"}');
      if (token) {
        const presented = String(request.headers['x-workflow-dashboard-token'] ?? request.headers.authorization?.replace(/^Bearer /, '') ?? url.searchParams.get('token') ?? '');
        if (!sameToken(presented, token)) return send(request, response, 401, 'application/json', '{"error":"Missing or wrong dashboard token"}');
      }
      if (url.pathname === '/api/health') return send(request, response, 200, 'application/json', JSON.stringify({ ok: true, pid: process.pid }));
      url.searchParams.delete('token');
      const answer = api.handle(url.pathname.slice('/api'.length), url.searchParams, request.headers['if-none-match']);
      const headers: Record<string, string> = answer.etag ? { ETag: answer.etag } : {};
      if (answer.status === 304) { response.writeHead(304, { ...HEADERS, 'Cache-Control': 'no-cache', ...headers }); response.end(); return; }
      send(request, response, answer.status, 'application/json; charset=utf-8', JSON.stringify(answer.body), headers);
    } catch (error) {
      if (response.headersSent) response.end();
      else send(request, response, 500, 'application/json', JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
  });
  server.requestTimeout = 30_000;

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(options.port ?? 0, host, () => { server.off('error', reject); resolve(); });
    });
  } catch (error) { api.close(); throw error; }
  const port = (server.address() as AddressInfo).port;
  const shown = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host.includes(':') ? `[${host}]` : host;
  const origin = `http://${shown}:${port}`;
  const url = token ? `${origin}/#token=${token}` : `${origin}/`;
  const stateFile = options.stateFile;
  if (stateFile) {
    mkdirSync(dirname(stateFile), { recursive: true });
    const temporary = `${stateFile}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify({ url: origin, port, ...(token ? { token } : {}), pid: process.pid, startedAt: new Date().toISOString(),
      sources: options.sources }, null, 2) + '\n', { mode: 0o600 });
    renameSync(temporary, stateFile);
  }
  return {
    url, port, ...(token ? { token } : {}),
    close: async () => {
      if (stateFile) rmSync(stateFile, { force: true });
      server.closeIdleConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      api.close();
    },
  };
}
