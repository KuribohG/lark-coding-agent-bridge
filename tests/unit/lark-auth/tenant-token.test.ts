import { describe, expect, it, vi } from 'vitest';
import {
  TenantTokenError,
  TenantTokenProvider,
} from '../../../src/lark-auth/tenant-token';

describe('TenantTokenProvider', () => {
  it('caches a tenant token until its refresh window', async () => {
    let now = 0;
    let issued = 0;
    const request = vi.fn(async () => tokenResponse(`token-${++issued}`, 120));
    const provider = new TenantTokenProvider({
      tenant: 'feishu',
      appId: 'app',
      appSecret: 'secret',
      request,
      now: () => now,
    });

    await expect(provider.getToken()).resolves.toBe('token-1');
    await expect(provider.getToken()).resolves.toBe('token-1');
    expect(request).toHaveBeenCalledTimes(1);

    now = 60_000;
    await expect(provider.getToken()).resolves.toBe('token-2');
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('single-flights concurrent refreshes', async () => {
    let resolveRequest: ((response: Response) => void) | undefined;
    const request = vi.fn(() => new Promise<Response>((resolve) => {
      resolveRequest = resolve;
    }));
    const provider = new TenantTokenProvider({
      tenant: 'lark',
      appId: 'app',
      appSecret: 'secret',
      request,
    });

    const first = provider.getToken();
    const second = provider.getToken();
    expect(request).toHaveBeenCalledTimes(1);
    resolveRequest?.(tokenResponse('shared', 7_200));

    await expect(Promise.all([first, second])).resolves.toEqual(['shared', 'shared']);
  });

  it('classifies HTTP and Feishu API failures', async () => {
    const http = new TenantTokenProvider({
      tenant: 'feishu',
      appId: 'app',
      appSecret: 'secret',
      request: async () => new Response('', { status: 401 }),
    });
    await expect(http.getToken()).rejects.toMatchObject({
      kind: 'http',
      details: { status: 401 },
    } satisfies Partial<TenantTokenError>);

    const api = new TenantTokenProvider({
      tenant: 'feishu',
      appId: 'app',
      appSecret: 'secret',
      request: async () => jsonResponse({ code: 10003, msg: 'invalid app secret' }),
    });
    await expect(api.getToken()).rejects.toMatchObject({
      kind: 'api',
      details: { code: 10003, apiMessage: 'invalid app secret' },
    } satisfies Partial<TenantTokenError>);
  });
});

function tokenResponse(token: string, expire: number): Response {
  return jsonResponse({ code: 0, tenant_access_token: token, expire });
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
  });
}
