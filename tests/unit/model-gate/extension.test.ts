import { afterEach, describe, expect, it } from 'vitest';
import modelGateExtension, {
  type GateExtensionOptions,
  type GateRequestOptions,
} from '../../../src/model-gate/pi-gate-extension';

interface FakePi {
  handlers: Map<string, Array<(event?: any, ctx?: any) => any>>;
  on(event: string, handler: (event?: any, ctx?: any) => any): void;
  emit(event: string, ...args: unknown[]): Promise<void>;
}

function fakePi(): FakePi {
  const handlers = new Map<string, Array<(event?: any, ctx?: any) => any>>();
  return {
    handlers,
    on(event, handler) { handlers.set(event, [...(handlers.get(event) ?? []), handler]); },
    async emit(event, ...args) {
      for (const handler of handlers.get(event) ?? []) await handler(...args);
    },
  };
}

interface Recorded {
  path: string;
  body: unknown;
}

function fakeRequest(behaviour: (options: GateRequestOptions) => Promise<Record<string, unknown>> = async () => ({ permit: 'p:1' })): {
  calls: Recorded[];
  request(options: GateRequestOptions): Promise<Record<string, unknown>>;
} {
  const calls: Recorded[] = [];
  return {
    calls,
    request: async options => {
      calls.push({ path: options.path, body: options.body });
      return behaviour(options);
    },
  };
}

const options = (request: GateExtensionOptions['request']): GateExtensionOptions => ({ socketPath: '/tmp/gate.sock', request });

afterEach(() => {
  delete process.env.LARK_MODEL_GATE_SOCKET;
  delete process.env.LARK_MODEL_GATE_PRIORITY;
  delete process.env.LARK_MODEL_GATE_PROVIDER_NAMES;
});

describe('modelGateExtension', () => {
  it('does nothing without a socket', () => {
    delete process.env.LARK_MODEL_GATE_SOCKET;
    const pi = fakePi();
    modelGateExtension(pi);
    expect(pi.handlers.size).toBe(0);
  });

  it('takes a permit before the request and releases it when the answer is finalized', async () => {
    const pi = fakePi();
    const transport = fakeRequest();
    modelGateExtension(pi, options(transport.request));

    await pi.emit('before_provider_request', {}, { model: { provider: 'deepseek', id: 'flash' } });
    expect(transport.calls).toEqual([{ path: '/acquire', body: { provider: 'deepseek', priority: 0 } }]);

    // A tool result or user message must not release the permit.
    await pi.emit('message_end', { message: { role: 'toolResult' } });
    await pi.emit('message_end', { message: { role: 'user' } });
    expect(transport.calls).toHaveLength(1);

    await pi.emit('message_end', { message: { role: 'assistant' } });
    expect(transport.calls).toEqual([
      { path: '/acquire', body: { provider: 'deepseek', priority: 0 } },
      { path: '/release', body: { permit: 'p:1' } },
    ]);
  });

  it('asks under the provider name, so every model of one provider shares a bucket', async () => {
    const pi = fakePi();
    const transport = fakeRequest();
    // The bridge registered two models of one service; Pi reports each under its own generated id.
    modelGateExtension(pi, { ...options(transport.request),
      providerNames: { lark_high_five_ai_01b55021b1f8: 'high-five-ai', lark_high_five_ai_e68c42f9e8c5: 'high-five-ai' } });
    for (const provider of ['lark_high_five_ai_01b55021b1f8', 'lark_high_five_ai_e68c42f9e8c5',
      // A model of Pi's own catalog comes under the catalog's name, and one nobody named stays as it is.
      'high-five-ai', 'elsewhere']) {
      await pi.emit('before_provider_request', {}, { model: { provider } });
      await pi.emit('message_end', { message: { role: 'assistant' } });
    }
    expect(transport.calls.filter(call => call.path === '/acquire').map(call => (call.body as { provider: string }).provider))
      .toEqual(['high-five-ai', 'high-five-ai', 'high-five-ai', 'elsewhere']);
  });

  it('reads the provider names from the environment and ignores a value it cannot read', async () => {
    const asked = async (): Promise<unknown> => {
      const pi = fakePi();
      const transport = fakeRequest();
      modelGateExtension(pi, options(transport.request));
      await pi.emit('before_provider_request', {}, { model: { provider: 'lark_a_0123456789ab' } });
      return (transport.calls[0]?.body as { provider: string }).provider;
    };
    process.env.LARK_MODEL_GATE_PROVIDER_NAMES = JSON.stringify({ lark_a_0123456789ab: 'a' });
    expect(await asked()).toBe('a');
    for (const broken of ['{not json', '["a"]', JSON.stringify({ lark_a_0123456789ab: 7 }), JSON.stringify({ lark_a_0123456789ab: '' })]) {
      process.env.LARK_MODEL_GATE_PROVIDER_NAMES = broken;
      expect(await asked()).toBe('lark_a_0123456789ab');
    }
  });

  it('reads the worker priority from the environment', async () => {
    process.env.LARK_MODEL_GATE_PRIORITY = '1';
    const pi = fakePi();
    const transport = fakeRequest();
    modelGateExtension(pi, options(transport.request));
    await pi.emit('before_provider_request', {}, { model: { provider: 'p' } });
    expect(transport.calls[0]?.body).toEqual({ provider: 'p', priority: 1 });
  });

  it('hands back an unreleased permit before taking the next one', async () => {
    const pi = fakePi();
    let next = 0;
    const transport = fakeRequest(async request => (
      request.path === '/acquire' ? { permit: `p:${next++}` } : { ok: true }
    ));
    modelGateExtension(pi, options(transport.request));

    await pi.emit('before_provider_request', {}, { model: { provider: 'p' } });
    // A transport retry asks again without an assistant message in between.
    await pi.emit('before_provider_request', {}, { model: { provider: 'p' } });
    const releases = transport.calls.filter(call => call.path === '/release');
    expect(releases).toEqual([{ path: '/release', body: { permit: 'p:0' } }]);

    await pi.emit('message_end', { message: { role: 'assistant' } });
    await pi.emit('agent_end', {});
    expect(transport.calls.filter(call => call.path === '/release').map(call => (call.body as { permit: string }).permit))
      .toEqual(['p:0', 'p:1']);
  });

  it('lets the request through when the gate is unreachable', async () => {
    const pi = fakePi();
    const transport = fakeRequest(async () => { throw new Error('ECONNREFUSED'); });
    modelGateExtension(pi, options(transport.request));

    await expect(pi.emit('before_provider_request', {}, { model: { provider: 'p' } })).resolves.toBeUndefined();
    // Nothing was acquired, so a later release has nothing to send.
    await pi.emit('message_end', { message: { role: 'assistant' } });
    expect(transport.calls.filter(call => call.path === '/release')).toHaveLength(0);
  });

  it('does not gate a request with no model context', async () => {
    const pi = fakePi();
    const transport = fakeRequest();
    modelGateExtension(pi, options(transport.request));
    await pi.emit('before_provider_request', {}, {});
    expect(transport.calls).toHaveLength(0);
  });
});
