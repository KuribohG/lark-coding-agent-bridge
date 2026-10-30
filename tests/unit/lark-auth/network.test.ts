import { afterEach, describe, expect, it, vi } from 'vitest';
import { getGlobalDispatcher } from 'undici';
import { LarkNetwork, larkProxyResolver } from '../../../src/lark-auth/network';
import { LarkProfileAuth } from '../../../src/lark-auth/profile-auth';
import { CotClient } from '../../../src/bot/cot';
import { validateAppCredentials } from '../../../src/utils/feishu-auth';

afterEach(() => vi.unstubAllGlobals());

describe('Lark proxy policy', () => {
  it('snapshots environment settings and applies one policy to HTTP(S) and WS(S)', () => {
    const env = { HTTP_PROXY: 'http://upper:3128', http_proxy: 'http://lower:3128', HTTPS_PROXY: 'http://secure:3128' };
    const proxy = larkProxyResolver({}, env);
    env.HTTPS_PROXY = 'http://changed:3128';
    expect(proxy('http://example.com')).toBe('http://lower:3128');
    expect(proxy('ws://example.com')).toBe('http://lower:3128');
    expect(proxy('https://example.com')).toBe('http://secure:3128');
    expect(proxy('wss://example.com')).toBe('http://secure:3128');
    expect(larkProxyResolver({}, { HTTP_PROXY: 'http://fallback:3128' })('https://example.com')).toBe('http://fallback:3128');
    expect(larkProxyResolver({}, { ALL_PROXY: 'http://all:3128' })('https://example.com')).toBe('http://all:3128');
  });

  it('isolates explicit and direct profiles from environment proxies', () => {
    const env = { HTTPS_PROXY: 'http://environment:3128', NO_PROXY: '*' };
    expect(larkProxyResolver({ proxy: 'http://configured:3128', no_proxy: '' }, env)('https://example.com')).toBe('http://configured:3128');
    expect(larkProxyResolver({ proxy: 'direct' }, { HTTPS_PROXY: 'invalid' })('https://example.com')).toBe('');
    expect(larkProxyResolver({}, {})('https://example.com')).toBe('');
  });

  it.each([
    ['localhost', 'http://localhost:1234', true],
    ['localhost:1234', 'http://localhost:1234', true],
    ['localhost:1234', 'http://localhost:1235', false],
    ['.internal', 'https://api.internal', true],
    ['.internal', 'https://notinternal', false],
    ['*.internal', 'wss://api.internal', true],
    ['[::1]', 'http://[::1]:8080', true],
    ['::1', 'http://[::1]:8080', true],
    ['[::1]:8080', 'http://[::1]:8081', false],
    ['10.0.0.0/8', 'http://10.9.1.2', true],
    ['10.0.0.0/8', 'http://11.9.1.2', false],
    ['fd00::/8', 'http://[fd00::1]', true],
    ['*', 'https://anything.example', true],
  ])('NO_PROXY=%s for %s bypasses=%s', (no_proxy, target, bypass) => {
    const proxy = larkProxyResolver({ proxy: 'http://proxy:3128', no_proxy }, {});
    expect(proxy(target)).toBe(bypass ? '' : 'http://proxy:3128');
  });

  it('reports transport causes without including credentials or request bodies', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed: sensitive-token', {
      cause: Object.assign(new Error('http://user:password@proxy'), { code: 'UND_ERR_CONNECT_TIMEOUT' }),
    })));
    const network = new LarkNetwork({ proxy: 'direct' }, {});
    try {
      await expect(network.request('https://example.com')).rejects.toThrow('UND_ERR_CONNECT_TIMEOUT');
      await network.request('https://example.com').catch(error => {
        expect(error.message).not.toMatch(/sensitive-token|password/);
        expect(error.cause).toBeInstanceOf(TypeError);
      });
    } finally { await network.close(); }
  });

  it('shares the profile transport between token exchange and COT without changing global fetch routing', async () => {
    const dispatcher = getGlobalDispatcher();
    const request = vi.fn(async (url: string) => new Response(JSON.stringify(url.includes('tenant_access_token')
      ? { code: 0, tenant_access_token: 'test-token', expire: 7200 }
      : { code: 0, data: { cot_id: 'cot', message_id: 'message' } })));
    vi.stubGlobal('fetch', request);
    const auth = new LarkProfileAuth({ accounts: { app: { id: 'app', secret: 'test-secret', tenant: 'feishu' } },
      channels: { lark: { network: { proxy: 'direct' } } } });
    try {
      const client = new CotClient({ tenant: 'feishu', appId: 'app', appSecret: 'test-secret',
        tenantTokens: await auth.tenantTokens(), request: auth.request });
      await client.create('chat', 'origin');
      expect(request).toHaveBeenCalledTimes(2);
      const calls = request.mock.calls as unknown as Array<[string, RequestInit]>;
      expect(calls[0]![1].dispatcher).toBeDefined();
      expect(calls[0]![1].dispatcher).toBe(calls[1]![1].dispatcher);
      expect(getGlobalDispatcher()).toBe(dispatcher);
    } finally { await auth.close(); }
  });

  it('uses the selected transport for credential validation and bot info', async () => {
    const request = vi.fn(async (url: string) => new Response(JSON.stringify(url.includes('tenant_access_token')
      ? { code: 0, tenant_access_token: 'test-token', expire: 7200 }
      : { code: 0, bot: { app_name: 'bot', open_id: 'bot-id' } })));
    vi.stubGlobal('fetch', request);
    await expect(validateAppCredentials('app', 'test-secret', 'lark', { proxy: 'direct' }))
      .resolves.toMatchObject({ ok: true, botName: 'bot' });
    const calls = request.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(calls.map(call => call[0])).toEqual([
      'https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal',
      'https://open.larksuite.com/open-apis/bot/v3/info',
    ]);
    expect(calls[0]![1].dispatcher).toBe(calls[1]![1].dispatcher);
  });
});
