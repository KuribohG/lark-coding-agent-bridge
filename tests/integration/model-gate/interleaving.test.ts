import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MODEL_GATE_DEFAULTS } from '../../../src/model-gate/config';
import { modelGateSocketPath } from '../../../src/model-gate/location';
import { ModelGateServer } from '../../../src/model-gate/server';
import modelGateExtension, { gateRequest } from '../../../src/model-gate/pi-gate-extension';

/**
 * The property this whole feature exists for: a worker that is executing tools
 * holds no model slot, so another worker gets the next request. Each fake agent
 * below is one Pi CLI process with the extension loaded; the permits come from
 * the real server over the real socket.
 */

const dirs: string[] = [];
const servers: ModelGateServer[] = [];

afterEach(async () => {
  delete process.env.LARK_MODEL_GATE_SOCKET;
  await Promise.all(servers.splice(0).map(server => server.stop()));
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

interface FakeAgent {
  run(event: 'before_provider_request' | 'message_end' | 'agent_end', payload?: unknown): Promise<void>;
}

function agent(): FakeAgent {
  const handlers = new Map<string, Array<(event?: any, ctx?: any) => any>>();
  const pi = { on(name: string, handler: (event?: any, ctx?: any) => any) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); } };
  // Real socket, real gate; only the transport channel is shared with a test process.
  modelGateExtension(pi as never, { request: gateRequest });
  return {
    async run(event, payload) {
      for (const handler of handlers.get(event) ?? []) await handler(payload ?? {}, { model: { provider: 'deepseek' } });
    },
  };
}

async function until(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

describe('model gate interleaving', () => {
  it('lets a second agent start while the first is executing tools', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gate-'));
    dirs.push(dir);
    const socketPath = modelGateSocketPath(dir);
    const server = new ModelGateServer({
      socketPath,
      config: {
        enabled: true,
        failOpen: true,
        leaseSeconds: 60,
        // One model request at a time: a slot released during tools is the only
        // way the second agent can run at all.
        defaults: { ...MODEL_GATE_DEFAULTS, concurrency: 1, rpm: 6000, burst: 100 },
        providers: {},
      },
      tickMs: 5,
    });
    servers.push(server);
    await server.start();

    // The extension takes its endpoint from the environment, exactly as the
    // adapter hands it to a Pi CLI process.
    process.env.LARK_MODEL_GATE_SOCKET = socketPath;
    const a = agent();
    const b = agent();

    await a.run('before_provider_request');
    await until(() => server.stats().find(item => item.provider === 'deepseek')?.inflight === 1);

    // Agent A's answer is in; it now executes a tool. B must get the slot.
    await a.run('message_end', { message: { role: 'assistant' } });
    const bStarted = b.run('before_provider_request');
    await bStarted;
    await until(() => server.stats().find(item => item.provider === 'deepseek')?.inflight === 1);

    // A comes back after its tool and queues behind B rather than jumping in.
    let aBack = false;
    const aNext = a.run('before_provider_request').then(() => { aBack = true; });
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(aBack).toBe(false);

    await b.run('message_end', { message: { role: 'assistant' } });
    await aNext;
    expect(aBack).toBe(true);

    await a.run('agent_end');
    await b.run('agent_end');
    await until(() => (server.stats().find(item => item.provider === 'deepseek')?.inflight ?? 0) === 0);
  });
});
