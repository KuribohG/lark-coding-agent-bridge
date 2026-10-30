import { createServer, request as httpRequest, type Server } from 'node:http';
import { connect, type Socket } from 'node:net';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { LarkNetwork } from '../../../src/lark-auth/network';

const servers: Server[] = [];
const sockets = new Set<Socket>();
const networks: LarkNetwork[] = [];
afterEach(async () => {
  await Promise.all(networks.splice(0).map(network => network.close()));
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});

function network(config: ConstructorParameters<typeof LarkNetwork>[0], env = {}) {
  const value = new LarkNetwork(config, env); networks.push(value); return value;
}

async function listen(server: Server) {
  servers.push(server);
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing TCP address');
  return address.port;
}

async function fixture() {
  const origin = createServer(async (request, response) => {
    if (request.url === '/redirect') {
      response.writeHead(302, { location: `http://127.0.0.1:${port}/result` }); response.end(); return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    response.setHeader('content-type', 'application/json');
    response.setHeader('x-test', 'preserved');
    response.end(JSON.stringify({ method: request.method, path: request.url, body: Buffer.concat(chunks).toString() }));
  });
  const port = await listen(origin);
  const hits: string[] = [];
  const proxy = createServer((request, response) => {
    const target = new URL(request.url!);
    hits.push(target.host);
    const forwarded = httpRequest({ hostname: '127.0.0.1', port: target.port, path: target.pathname + target.search,
      method: request.method, headers: request.headers }, upstream => {
      response.writeHead(upstream.statusCode!, upstream.headers); upstream.pipe(response);
    });
    forwarded.on('error', () => { response.writeHead(502); response.end(); });
    request.pipe(forwarded);
  });
  proxy.on('connect', (request, socket, head) => {
    hits.push(request.url!);
    const target = new URL(`http://${request.url}`);
    const upstream = connect(Number(target.port), '127.0.0.1');
    sockets.add(upstream); upstream.on('close', () => sockets.delete(upstream));
    upstream.on('connect', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      socket.pipe(upstream); upstream.pipe(socket);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  });
  const proxyPort = await listen(proxy);
  return { origin, port, proxy: `http://127.0.0.1:${proxyPort}`, hits, target: `http://bridge.invalid:${port}` };
}

describe('Lark transport through a real local proxy', () => {
  it('routes native fetch and SDK REST through environment proxies without NODE_OPTIONS', async () => {
    const f = await fixture();
    const transport = network({}, { HTTP_PROXY: f.proxy });
    const response = await transport.request(f.target + '/cot', { method: 'POST', body: 'cot-body' });
    expect(await response.json()).toMatchObject({ method: 'POST', path: '/cot', body: 'cot-body' });
    await expect(transport.httpInstance.post(f.target + '/token', { app_id: 'test' }))
      .resolves.toMatchObject({ method: 'POST', path: '/token', body: '{"app_id":"test"}' });
    expect(f.hits).toEqual([`bridge.invalid:${f.port}`, `bridge.invalid:${f.port}`]);
  });

  it('re-evaluates NO_PROXY across redirects for both request implementations', async () => {
    const f = await fixture();
    const transport = network({ proxy: f.proxy, no_proxy: '127.0.0.1' });
    expect(await (await transport.request(f.target + '/redirect')).json()).toMatchObject({ path: '/result' });
    await expect(transport.httpInstance.get(f.target + '/redirect')).resolves.toMatchObject({ path: '/result' });
    expect(f.hits).toEqual([`bridge.invalid:${f.port}`, `bridge.invalid:${f.port}`]);
  });

  it('keeps concurrent direct and proxied profiles isolated', async () => {
    const f = await fixture();
    const proxied = network({ proxy: f.proxy });
    const direct = network({ proxy: 'direct' }, { HTTP_PROXY: 'http://127.0.0.1:1' });
    const [first, second] = await Promise.all([
      proxied.request(f.target + '/proxied').then(result => result.json()),
      direct.httpInstance.get(`http://127.0.0.1:${f.port}/direct`),
    ]);
    expect(first).toMatchObject({ path: '/proxied' });
    expect(second).toMatchObject({ path: '/direct' });
    expect(f.hits).toHaveLength(1);
  });

  it('preserves the SDK headers and stream download contract', async () => {
    const f = await fixture();
    const transport = network({ proxy: f.proxy });
    const response = await transport.httpInstance.get<{ data: NodeJS.ReadableStream; headers: Record<string, string> }>(
      f.target + '/download', { responseType: 'stream', $return_headers: true });
    expect(response.headers['x-test']).toBe('preserved');
    const chunks = [];
    for await (const chunk of response.data) chunks.push(Buffer.from(chunk));
    expect(JSON.parse(Buffer.concat(chunks).toString())).toMatchObject({ path: '/download' });
  });

  it('uses the same proxy policy for WebSocket handshakes', async () => {
    const f = await fixture();
    const wss = new WebSocketServer({ server: f.origin });
    wss.on('connection', socket => socket.send('connected'));
    const transport = network({ proxy: f.proxy });
    const socket = new WebSocket(`ws://bridge.invalid:${f.port}`, { agent: transport.agent });
    const [message] = await once(socket, 'message');
    expect(message.toString()).toBe('connected');
    socket.close(); await once(socket, 'close');
    await new Promise<void>(resolve => wss.close(() => resolve()));
    expect(f.hits).toEqual([`bridge.invalid:${f.port}`]);
  });

  it('preserves request cancellation', async () => {
    const f = await fixture();
    const transport = network({ proxy: f.proxy });
    await expect(transport.request(f.target, { signal: AbortSignal.abort() })).rejects.toThrow(/AbortError/);
    expect(f.hits).toHaveLength(0);
  });
});
