import type { TenantBrand } from '../config/schema';
import { larkFetch } from './network';

/**
 * User-identity OAuth (a.k.a. `user_access_token`) support.
 *
 * Why this exists: a Feishu app's *tenant* (app-identity) scopes and a *user*
 * identity's scopes are separate grants. When the app is missing a read scope
 * (`im:message:readonly`, `im:chat:readonly`, ...) every tenant-token read
 * fails with 99991672 while the same calls succeed with a user token the
 * operator already authorized. This provider keeps such a grant alive so the
 * bridge can fall back to it for read-only calls (see
 * `channels/lark/user-read.ts`).
 *
 * Everything here is best-effort: a missing, expired or unrecoverable grant
 * resolves to `undefined` and callers stay on the tenant identity.
 */

/** OAuth lives on the accounts host, not the open-api host. */
const ACCOUNTS_ORIGIN: Record<TenantBrand, string> = {
  feishu: 'https://accounts.feishu.cn',
  lark: 'https://accounts.larksuite.com',
};

const DEFAULT_TIMEOUT_MS = 15_000;
/** Refresh this long before the access token actually expires. */
const ACCESS_REFRESH_SKEW_MS = 60_000;
const DEVICE_CODE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';
const REFRESH_TOKEN_GRANT_TYPE = 'refresh_token';

export interface StoredUserToken {
  refreshToken: string;
  /** Epoch ms; the refresh token is unusable after this. */
  refreshExpiresAt?: number;
  /** open_id the grant belongs to — informational only (status, logs). */
  openId?: string;
}

/** Persistence for the refresh token. Implementations must never log values. */
export interface UserTokenStore {
  load(): Promise<StoredUserToken | undefined>;
  save(token: StoredUserToken): Promise<void>;
  clear(): Promise<void>;
}

export interface UserAccessToken {
  accessToken: string;
  expiresAt: number;
}

export interface UserTokenProviderOptions {
  tenant: TenantBrand;
  appId: string;
  appSecret: string;
  store: UserTokenStore;
  request?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}

export type UserTokenErrorKind = 'network' | 'http' | 'api' | 'invalid-json';

export class UserTokenError extends Error {
  constructor(
    readonly kind: UserTokenErrorKind,
    message: string,
    readonly details: { status?: number; code?: number | string; apiMessage?: string } = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'UserTokenError';
  }
}

export interface UserTokenStatus {
  /** A refresh token is on file. */
  configured: boolean;
  openId?: string;
  /** Epoch ms; the stored refresh token dies here. */
  refreshExpiresAt?: number;
  /** Epoch ms; only set while an access token is cached in this process. */
  accessExpiresAt?: number;
}

interface TokenResponse {
  accessToken: string;
  expiresAt: number;
  refreshToken?: string;
  refreshExpiresAt?: number;
  openId?: string;
}

export class UserTokenProvider {
  private readonly tenant: TenantBrand;
  private readonly appId: string;
  private readonly appSecret: string;
  private readonly store: UserTokenStore;
  private readonly request: typeof fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private cached?: UserAccessToken;
  private pending?: Promise<UserAccessToken | undefined>;

  constructor(options: UserTokenProviderOptions) {
    this.tenant = options.tenant;
    this.appId = options.appId;
    this.appSecret = options.appSecret;
    this.store = options.store;
    this.request = options.request ?? larkFetch;
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * Current access token, refreshing when needed. Returns `undefined` when no
   * grant is stored or it can no longer be refreshed — callers fall back to
   * the tenant identity instead of failing the request.
   */
  async getAccessToken(): Promise<UserAccessToken | undefined> {
    const cached = this.cached;
    if (cached && cached.expiresAt - ACCESS_REFRESH_SKEW_MS > this.now()) return cached;
    // Collapse concurrent refreshes: one train of token requests per bridge.
    this.pending ??= this.refresh().catch(() => undefined).finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  /**
   * Force a refresh. Throws {@link UserTokenError} when the grant is gone; the
   * stored token is dropped in that case so the next start doesn't retry a dead
   * refresh token forever.
   */
  async refresh(): Promise<UserAccessToken> {
    const stored = await this.store.load();
    if (!stored) throw new UserTokenError('api', 'no user grant stored');
    if (stored.refreshExpiresAt !== undefined && stored.refreshExpiresAt <= this.now()) {
      await this.store.clear();
      throw new UserTokenError('api', 'stored user grant has expired');
    }
    const response = await this.postToken({
      grant_type: REFRESH_TOKEN_GRANT_TYPE,
      client_id: this.appId,
      client_secret: this.appSecret,
      refresh_token: stored.refreshToken,
    });
    const access: UserAccessToken = { accessToken: response.accessToken, expiresAt: response.expiresAt };
    this.cached = access;
    if (response.refreshToken && response.refreshToken !== stored.refreshToken) {
      await this.store.save({
        refreshToken: response.refreshToken,
        ...(response.refreshExpiresAt !== undefined ? { refreshExpiresAt: response.refreshExpiresAt } : {}),
        ...(response.openId ?? stored.openId ? { openId: response.openId ?? stored.openId } : {}),
      });
    }
    return access;
  }

  async status(): Promise<UserTokenStatus> {
    const stored = await this.store.load();
    return {
      configured: Boolean(stored),
      ...(stored?.openId ? { openId: stored.openId } : {}),
      ...(stored?.refreshExpiresAt !== undefined ? { refreshExpiresAt: stored.refreshExpiresAt } : {}),
      ...(this.cached ? { accessExpiresAt: this.cached.expiresAt } : {}),
    };
  }

  /** Drop the stored grant (logout). */
  async forget(): Promise<void> {
    this.cached = undefined;
    await this.store.clear();
  }

  private async postToken(body: Record<string, string>): Promise<TokenResponse> {
    const url = `${ACCOUNTS_ORIGIN[this.tenant]}${OAUTH_TOKEN_PATH}`;
    let response: Response;
    try {
      response = await this.request(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new UserTokenError('network', `user token request failed: ${describe(err)}`, {}, { cause: err });
    }
    const text = await response.text().catch(() => '');
    const data = parseJsonObject(text);
    if (!response.ok || isOauthError(data)) {
      const error = typeof data?.error === 'string' ? data.error : undefined;
      const description = typeof data?.error_description === 'string'
        ? data.error_description
        : typeof data?.msg === 'string' ? data.msg : undefined;
      // `invalid_grant` means the refresh token is dead — stop retrying it.
      if (error === 'invalid_grant' || error === 'expired_token') await this.store.clear().catch(() => undefined);
      throw new UserTokenError(
        'api',
        `user token request rejected: ${description ?? error ?? `HTTP ${response.status}`}`,
        { status: response.status, ...(error ? { code: error } : {}) },
      );
    }
    if (!data) throw new UserTokenError('invalid-json', 'user token response was not JSON');
    const accessToken = typeof data.access_token === 'string' ? data.access_token : undefined;
    if (!accessToken) throw new UserTokenError('api', 'user token response carried no access_token');
    const expiresIn = numberOr(data.expires_in, 7_200);
    return {
      accessToken,
      expiresAt: this.now() + Math.max(60, expiresIn) * 1000,
      ...(typeof data.refresh_token === 'string' ? { refreshToken: data.refresh_token } : {}),
      ...(numberOr(data.refresh_token_expires_in, 0) > 0
        ? { refreshExpiresAt: this.now() + numberOr(data.refresh_token_expires_in, 0) * 1000 }
        : {}),
      ...(typeof data.open_id === 'string' ? { openId: data.open_id } : {}),
    };
  }
}

const OAUTH_TOKEN_PATH = '/oauth/v3/token';
const DEVICE_AUTHORIZATION_PATH = '/oauth/v1/device_authorization';

export interface DeviceAuthorizationRequest {
  tenant: TenantBrand;
  appId: string;
  appSecret: string;
  /** Space-separated scopes; omit to use whatever the app is configured for. */
  scope?: string;
  request?: typeof fetch;
  timeoutMs?: number;
}

export interface DeviceAuthorization {
  deviceCode: string;
  userCode?: string;
  /** Show this to the user verbatim; never re-encode it. */
  verificationUrl: string;
  expiresInMs: number;
  intervalMs: number;
}

/** Start the user-identity device flow (`lark-cli auth login` equivalent). */
export async function beginUserDeviceAuthorization(
  request: DeviceAuthorizationRequest,
): Promise<DeviceAuthorization> {
  const send = request.request ?? larkFetch;
  const url = `${ACCOUNTS_ORIGIN[request.tenant]}${DEVICE_AUTHORIZATION_PATH}`;
  let response: Response;
  try {
    response = await send(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_id: request.appId,
        client_secret: request.appSecret,
        ...(request.scope ? { scope: request.scope } : {}),
      }),
      signal: AbortSignal.timeout(request.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (err) {
    throw new UserTokenError('network', `device authorization failed: ${describe(err)}`, {}, { cause: err });
  }
  const data = parseJsonObject(await response.text().catch(() => ''));
  if (!response.ok || !data || typeof data.device_code !== 'string') {
    const description = typeof data?.error_description === 'string'
      ? data.error_description
      : typeof data?.msg === 'string' ? data.msg : `HTTP ${response.status}`;
    throw new UserTokenError('api', `device authorization rejected: ${description}`, { status: response.status });
  }
  const verificationUrl = typeof data.verification_uri_complete === 'string'
    ? data.verification_uri_complete
    : typeof data.verification_uri === 'string' ? data.verification_uri : undefined;
  if (!verificationUrl) throw new UserTokenError('api', 'device authorization returned no verification URL');
  return {
    deviceCode: data.device_code,
    ...(typeof data.user_code === 'string' ? { userCode: data.user_code } : {}),
    verificationUrl,
    expiresInMs: Math.max(0, numberOr(data.expires_in, 600)) * 1000,
    intervalMs: Math.max(1, numberOr(data.interval, 5)) * 1000,
  };
}

export interface DevicePollRequest {
  tenant: TenantBrand;
  appId: string;
  appSecret: string;
  deviceCode: string;
  expiresInMs: number;
  intervalMs: number;
  request?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  onPending?: () => void;
}

export interface DeviceGrant {
  accessToken: string;
  expiresAt: number;
  refreshToken: string;
  refreshExpiresAt?: number;
  openId?: string;
}

/**
 * Poll until the user authorizes (or the device code expires). Returns the
 * grant; the caller decides how to persist the refresh token.
 */
export async function completeUserDeviceAuthorization(
  request: DevicePollRequest,
): Promise<DeviceGrant> {
  const send = request.request ?? larkFetch;
  const now = request.now ?? Date.now;
  const sleep = request.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const deadline = now() + request.expiresInMs;
  let interval = request.intervalMs;
  const url = `${ACCOUNTS_ORIGIN[request.tenant]}${OAUTH_TOKEN_PATH}`;
  for (;;) {
    const response = await send(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grant_type: DEVICE_CODE_GRANT_TYPE,
        client_id: request.appId,
        client_secret: request.appSecret,
        device_code: request.deviceCode,
      }),
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
    const data = parseJsonObject(await response.text().catch(() => ''));
    if (response.ok && data && typeof data.access_token === 'string') {
      if (typeof data.refresh_token !== 'string') {
        throw new UserTokenError('api', 'device grant returned no refresh_token (missing offline_access scope?)');
      }
      const refreshExpiresIn = numberOr(data.refresh_token_expires_in, 0);
      return {
        accessToken: data.access_token,
        expiresAt: now() + Math.max(60, numberOr(data.expires_in, 7_200)) * 1000,
        refreshToken: data.refresh_token,
        ...(refreshExpiresIn > 0 ? { refreshExpiresAt: now() + refreshExpiresIn * 1000 } : {}),
        ...(typeof data.open_id === 'string' ? { openId: data.open_id } : {}),
      };
    }
    const error = typeof data?.error === 'string' ? data.error : undefined;
    if (error === 'authorization_pending') {
      request.onPending?.();
    } else if (error === 'slow_down') {
      interval += 5_000;
    } else {
      const description = typeof data?.error_description === 'string' ? data.error_description : undefined;
      throw new UserTokenError(
        'api',
        `device authorization failed: ${description ?? error ?? `HTTP ${response.status}`}`,
        { status: response.status, ...(error ? { code: error } : {}) },
      );
    }
    if (now() + interval > deadline) throw new UserTokenError('api', 'device authorization expired');
    await sleep(interval);
  }
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function isOauthError(data: Record<string, unknown> | undefined): boolean {
  if (!data) return true;
  if (typeof data.error === 'string') return true;
  if (typeof data.code === 'number' && data.code !== 0) return true;
  return false;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
