import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readJsonBody, sendHtml, sendJson } from '../ui/http';
import type { InboxService } from './service';
import { InboxH5Auth } from './h5-auth';
import { obj } from './values';
import html from './page.html';

/** Only this small owner-authenticated surface is eligible for HTTPS reverse proxying. */
export async function startInboxH5(service: InboxService, auth: InboxH5Auth) {
  const origin = new URL(auth.publicUrl).origin;
  const server = createServer((req, res) => {
    void (async () => {
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('X-Frame-Options', 'DENY');
      const path = new URL(req.url || '/', 'http://localhost').pathname;
      if (path === '/' && req.method === 'GET') { sendHtml(res, html); return; }
      if (req.method !== 'POST' || req.headers.origin !== origin || !String(req.headers['content-type']).startsWith('application/json')) {
        sendJson(res, 403, { error: 'forbidden' }); return;
      }
      const body = obj(await readJsonBody(req));
      if (path === '/api/sdk') { sendJson(res, 200, await auth.bootstrap(String(body.url || ''))); return; }
      if (path === '/api/login') { sendJson(res, 200, { token: await auth.login(String(body.code || ''), String(body.state || '')) }); return; }
      if (!auth.authorized(String(req.headers.authorization || '').replace(/^Bearer /, ''))) { sendJson(res, 401, { error: '请重新打开助理' }); return; }
      if (path === '/api/jobs') {
        sendJson(res, 200, { jobs: service.list().map(({ messages: _, ...job }) => job), error: service.lastError }); return;
      }
      if (path === '/api/process') { sendJson(res, 200, { jobId: (await service.manual(String(body.chatId || ''))).id }); return; }
      if (path === '/api/decide') {
        await service.decide(String(body.id || ''), String(body.action || ''), service.config.ownerOpenId);
        sendJson(res, 200, { ok: true }); return;
      }
      sendJson(res, 404, { error: 'not found' });
    })().catch(e => { if (!res.headersSent) sendJson(res, 400, { error: e instanceof Error ? e.message : '请求失败' }); else res.end(); });
  });
  server.requestTimeout = 120_000;
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(service.config.h5.port, '127.0.0.1', resolve); });
  return { port: (server.address() as AddressInfo).port, close: () => new Promise<void>((resolve, reject) => { server.close(e => e ? reject(e) : resolve()); server.closeIdleConnections(); }) };
}
