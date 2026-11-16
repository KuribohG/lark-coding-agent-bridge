import { describe, expect, it } from 'vitest';
import {
  beginUserDeviceAuthorization,
  completeUserDeviceAuthorization,
  UserTokenProvider,
  type StoredUserToken,
} from '../../../src/lark-auth/user-token';

function memoryStore(initial?: StoredUserToken) {
  let value = initial;
  return {
    load: async () => value,
    save: async (token: StoredUserToken) => { value = token; },
    clear: async () => { value = undefined; },
    get value() { return value; },
  };
}

interface Captured {
  url: string;
  body: Record<string, unknown>;
}

function fakeFetch(responders: ((captured: Captured) => Response)[]): {
  fetch: typeof fetch;
  calls: Captured[];
} {
  const calls: Captured[] = [];
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    const captured = { url, body };
    calls.push(captured);
    const responder = responders.shift();
    if (!responder) throw new Error(`unexpected request to ${url}`);
    return responder(captured);
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('UserTokenProvider', () => {
  it('refreshes with the stored refresh token and caches the access token', async () => {
    const store = memoryStore({ refreshToken: 'rt-old' });
    const { fetch: fetchImpl, calls } = fakeFetch([
      () => json({
        access_token: 'at-1',
        expires_in: 7200,
        refresh_token: 'rt-new',
        refresh_token_expires_in: 2_592_000,
        open_id: 'ou_user',
      }),
    ]);
    const now = 1_700_000_000_000;
    const provider = new UserTokenProvider({
      tenant: 'feishu',
      appId: 'cli_x',
      appSecret: 'secret',
      store,
      request: fetchImpl,
      now: () => now,
    });

    const first = await provider.getAccessToken();
    expect(first?.accessToken).toBe('at-1');
    expect(first?.expiresAt).toBe(now + 7_200_000);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://accounts.feishu.cn/oauth/v3/token');
    expect(calls[0]!.body).toMatchObject({
      grant_type: 'refresh_token',
      client_id: 'cli_x',
      refresh_token: 'rt-old',
    });
    // The rotated refresh token is persisted for the next process.
    expect(store.value).toMatchObject({ refreshToken: 'rt-new', openId: 'ou_user' });

    const second = await provider.getAccessToken();
    expect(second?.accessToken).toBe('at-1');
    expect(calls).toHaveLength(1);
  });

  it('returns undefined and forgets the grant when the refresh token is rejected', async () => {
    const store = memoryStore({ refreshToken: 'rt-dead' });
    const { fetch: fetchImpl } = fakeFetch([
      () => json({ error: 'invalid_grant', error_description: 'refresh token expired' }, 400),
    ]);
    const provider = new UserTokenProvider({
      tenant: 'feishu',
      appId: 'cli_x',
      appSecret: 'secret',
      store,
      request: fetchImpl,
    });

    await expect(provider.getAccessToken()).resolves.toBeUndefined();
    expect(store.value).toBeUndefined();
  });

  it('does not touch the network when the stored refresh token already expired', async () => {
    const store = memoryStore({ refreshToken: 'rt', refreshExpiresAt: 1_000 });
    const { fetch: fetchImpl, calls } = fakeFetch([]);
    const provider = new UserTokenProvider({
      tenant: 'feishu',
      appId: 'cli_x',
      appSecret: 'secret',
      store,
      request: fetchImpl,
      now: () => 2_000,
    });

    await expect(provider.getAccessToken()).resolves.toBeUndefined();
    expect(calls).toHaveLength(0);
    expect(store.value).toBeUndefined();
  });

  it('surfaces the app-identity status without a grant', async () => {
    const store = memoryStore();
    const provider = new UserTokenProvider({
      tenant: 'lark',
      appId: 'cli_x',
      appSecret: 'secret',
      store,
      request: fakeFetch([]).fetch,
    });
    await expect(provider.status()).resolves.toEqual({ configured: false });
  });
});

describe('user device flow', () => {
  it('builds the authorization URL from the device authorization response', async () => {
    const { fetch: fetchImpl, calls } = fakeFetch([
      () => json({
        device_code: 'dc-1',
        user_code: 'ABCD-EFGH',
        verification_uri: 'https://accounts.feishu.cn/oauth/v1/device/verify?flow_id=x',
        verification_uri_complete: 'https://accounts.feishu.cn/oauth/v1/device/verify?flow_id=x&user_code=ABCD-EFGH',
        expires_in: 600,
        interval: 5,
      }),
    ]);

    const device = await beginUserDeviceAuthorization({
      tenant: 'feishu',
      appId: 'cli_x',
      appSecret: 'secret',
      scope: 'offline_access im:message:readonly',
      request: fetchImpl,
    });

    expect(device.deviceCode).toBe('dc-1');
    expect(device.verificationUrl).toContain('user_code=ABCD-EFGH');
    expect(device.expiresInMs).toBe(600_000);
    expect(device.intervalMs).toBe(5_000);
    expect(calls[0]!.url).toBe('https://accounts.feishu.cn/oauth/v1/device_authorization');
    expect(calls[0]!.body).toMatchObject({ client_id: 'cli_x', scope: 'offline_access im:message:readonly' });
  });

  it('polls through authorization_pending and returns the grant', async () => {
    const pending: number[] = [];
    const { fetch: fetchImpl, calls } = fakeFetch([
      () => json({ error: 'authorization_pending' }),
      () => json({
        access_token: 'at',
        expires_in: 7200,
        refresh_token: 'rt',
        refresh_token_expires_in: 2_592_000,
      }),
    ]);
    let clock = 1_000_000;
    const grant = await completeUserDeviceAuthorization({
      tenant: 'feishu',
      appId: 'cli_x',
      appSecret: 'secret',
      deviceCode: 'dc-1',
      expiresInMs: 600_000,
      intervalMs: 5_000,
      request: fetchImpl,
      now: () => clock,
      sleep: async (ms) => { clock += ms; pending.push(ms); },
      onPending: () => pending.push(-1),
    });

    expect(grant).toMatchObject({ accessToken: 'at', refreshToken: 'rt' });
    expect(grant.refreshExpiresAt).toBe(clock + 2_592_000_000);
    expect(pending).toContain(-1);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.body).toMatchObject({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: 'dc-1',
    });
  });

  it('fails when the user denies the grant', async () => {
    const { fetch: fetchImpl } = fakeFetch([
      () => json({ error: 'access_denied', error_description: 'user denied' }, 400),
    ]);
    await expect(completeUserDeviceAuthorization({
      tenant: 'feishu',
      appId: 'cli_x',
      appSecret: 'secret',
      deviceCode: 'dc-1',
      expiresInMs: 600_000,
      intervalMs: 5_000,
      request: fetchImpl,
      sleep: async () => undefined,
    })).rejects.toThrow(/user denied/);
  });
});
