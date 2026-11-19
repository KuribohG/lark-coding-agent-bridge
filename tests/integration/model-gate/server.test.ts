import { mkdtemp, rm } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { log } from '../../../src/core/logger';
import { MODEL_GATE_DEFAULTS, type ModelGateConfig } from '../../../src/model-gate/config';
import { ModelGateServer } from '../../../src/model-gate/server';

const dirs: string[] = [];
const servers: ModelGateServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.stop()));
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

function config(overrides: Partial<ModelGateConfig> = {}): ModelGateConfig {
  return {
    enabled: true,
    failOpen: true,
    leaseSeconds: 60,
    defaults: MODEL_GATE_DEFAULTS,
    providers: {},
    ...overrides,
  };
}

async function socketDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'gate-'));
  dirs.push(dir);
  return join(dir, 'gate.sock');
}

function post(socketPath: string, path: string, body: unknown): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = httpRequest({ socketPath, path, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } }, res => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, any>));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

function get(socketPath: string, path: string): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ socketPath, path, method: 'GET' }, res => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, any>));
    });
    req.on('error', reject);
    req.end();
  });
}

/** Poll until a condition holds; socket I/O needs more than one turn of the loop. */
async function until(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

async function started(server: ModelGateServer): Promise<ModelGateServer> {
  servers.push(server);
  await server.start();
  return server;
}

describe('ModelGateServer', () => {
  it('grants a permit, reports it, and frees the slot on release', async () => {
    const socketPath = await socketDir();
    await started(new ModelGateServer({ socketPath, config: config(), tickMs: 0 }));

    const granted = await post(socketPath, '/acquire', { provider: 'deepseek' });
    expect(typeof granted.permit).toBe('string');
    expect(granted.provider).toBe('deepseek');

    const status = await get(socketPath, '/status');
    const bucket = status.buckets.find((item: any) => item.provider === 'deepseek');
    expect(bucket).toMatchObject({ inflight: 1, queued: 0, concurrency: 100 });

    expect(await post(socketPath, '/release', { permit: granted.permit })).toMatchObject({ ok: true, released: true });
    const after = (await get(socketPath, '/status')).buckets.find((item: any) => item.provider === 'deepseek');
    expect(after.inflight).toBe(0);
  });

  it('queues the second request while one is in flight and starts it on release', async () => {
    const socketPath = await socketDir();
    const server = await started(new ModelGateServer({
      socketPath,
      config: config({ defaults: { ...MODEL_GATE_DEFAULTS, concurrency: 1 } }),
      tickMs: 0,
    }));

    const first = await post(socketPath, '/acquire', { provider: 'p' });
    let secondGranted = false;
    const second = post(socketPath, '/acquire', { provider: 'p' }).then(answer => {
      secondGranted = true;
      return answer;
    });
    await until(() => (server.stats().find(item => item.provider === 'p')?.queued ?? 0) === 1);
    expect(secondGranted).toBe(false);
    expect(server.stats().find(item => item.provider === 'p')).toMatchObject({ inflight: 1, queued: 1 });

    await post(socketPath, '/release', { permit: first.permit });
    // The server released the slot, which pumps the queue without waiting for the timer.
    const granted = await second;
    expect(granted.permit).toBeTruthy();
  });

  it('keeps providers apart: one provider queueing does not hold up another', async () => {
    const socketPath = await socketDir();
    await started(new ModelGateServer({
      socketPath,
      config: config({
        defaults: MODEL_GATE_DEFAULTS,
        providers: {
          slow: { rpm: 1, burst: 1, concurrency: 1 },
          fast: { rpm: 1000, burst: 100, concurrency: 100 },
        },
      }),
      tickMs: 0,
    }));

    const slow = await post(socketPath, '/acquire', { provider: 'slow' });
    expect(typeof slow.permit).toBe('string');
    // The slow provider has spent its only token; the fast one is untouched.
    const fast = await post(socketPath, '/acquire', { provider: 'fast' });
    expect(typeof fast.permit).toBe('string');
  });

  it('names a provider once when its bucket is made, with whether it has an entry of its own', async () => {
    const info = vi.spyOn(log, 'info');
    try {
      const socketPath = await socketDir();
      await started(new ModelGateServer({
        socketPath,
        config: config({ providers: { listed: { rpm: 500, burst: 50, concurrency: 0 } } }),
        tickMs: 0,
      }));
      for (const provider of ['listed', 'stray', 'stray']) {
        const granted = await post(socketPath, '/acquire', { provider });
        await post(socketPath, '/release', { permit: granted.permit });
      }
      expect(info.mock.calls.filter(call => call[1] === 'bucket-created').map(call => call[2])).toEqual([
        { provider: 'listed', configured: true, rpm: 500, burst: 50, concurrency: 0 },
        // No entry: the defaults, and the one line that says so.
        { provider: 'stray', configured: false, ...MODEL_GATE_DEFAULTS },
      ]);
    } finally {
      info.mockRestore();
    }
  });

  it('gives interactive requests the next slot ahead of queued workers', async () => {
    const socketPath = await socketDir();
    const server = await started(new ModelGateServer({
      socketPath,
      config: config({ defaults: { ...MODEL_GATE_DEFAULTS, concurrency: 1, rpm: 6000, burst: 100 } }),
      tickMs: 0,
    }));

    const holding = await post(socketPath, '/acquire', { provider: 'p' });
    const order: string[] = [];
    const worker = post(socketPath, '/acquire', { provider: 'p', priority: 1 }).then(answer => {
      order.push('worker');
      return answer;
    });
    const interactive = post(socketPath, '/acquire', { provider: 'p', priority: 0 }).then(answer => {
      order.push('interactive');
      return answer;
    });
    await until(() => server.stats().find(item => item.provider === 'p')?.queued === 2);

    await post(socketPath, '/release', { permit: holding.permit });
    const interactiveAnswer = await interactive;
    expect(order).toEqual(['interactive']);
    await post(socketPath, '/release', { permit: interactiveAnswer.permit });
    const workerAnswer = await worker;
    expect(typeof workerAnswer.permit).toBe('string');
    expect(order).toEqual(['interactive', 'worker']);
    await post(socketPath, '/release', { permit: workerAnswer.permit });
  });

  it('drops a waiter whose client disconnected', async () => {
    const socketPath = await socketDir();
    const server = await started(new ModelGateServer({
      socketPath,
      config: config({ defaults: { ...MODEL_GATE_DEFAULTS, concurrency: 1 } }),
      tickMs: 0,
    }));

    const holding = await post(socketPath, '/acquire', { provider: 'p' });
    const req = httpRequest({ socketPath, path: '/acquire', method: 'POST', headers: { 'content-type': 'application/json' } },
      res => res.on('error', () => {}));
    req.on('error', () => {});
    req.end(JSON.stringify({ provider: 'p' }));
    await until(() => (server.stats().find(item => item.provider === 'p')?.queued ?? 0) === 1);

    req.destroy();
    await until(() => (server.stats().find(item => item.provider === 'p')?.queued ?? 0) === 0);
    await post(socketPath, '/release', { permit: holding.permit });
  });

  it('reuses a socket another bridge already serves instead of splitting the quota', async () => {
    const socketPath = await socketDir();
    const owner = await started(new ModelGateServer({ socketPath, config: config(), tickMs: 0 }));
    const borrower = new ModelGateServer({ socketPath, config: config(), tickMs: 0 });
    await borrower.start();
    servers.push(borrower);
    expect(owner.ownsSocket).toBe(true);
    expect(borrower.ownsSocket).toBe(false);
    await borrower.stop();
    // Stopping the borrower must not unlink the owner's socket.
    const granted = await post(socketPath, '/acquire', { provider: 'p' });
    expect(typeof granted.permit).toBe('string');
  });

  it('is idempotent about unknown permits', async () => {
    const socketPath = await socketDir();
    await started(new ModelGateServer({ socketPath, config: config(), tickMs: 0 }));
    expect(await post(socketPath, '/release', { permit: 'nope' })).toMatchObject({ ok: true, released: false });
  });

  it('applies retuned limits without dropping in-flight permits', async () => {
    const socketPath = await socketDir();
    const server = await started(new ModelGateServer({ socketPath, config: config(), tickMs: 0 }));
    const granted = await post(socketPath, '/acquire', { provider: 'p' });

    server.updateConfig(config({ defaults: { rpm: 10, burst: 1, concurrency: 1 } }));
    const bucket = server.stats().find(item => item.provider === 'p');
    expect(bucket).toMatchObject({ inflight: 1, rpm: 10, concurrency: 1 });
    await post(socketPath, '/release', { permit: granted.permit });
  });
});
