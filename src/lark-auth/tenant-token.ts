import type { TenantBrand } from '../config/schema';
import { larkFetch } from './network';

const OPEN_API_ORIGINS: Record<TenantBrand, string> = {
  feishu: 'https://open.feishu.cn',
  lark: 'https://open.larksuite.com',
};

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_EXPIRE_SECONDS = 7_200;
const MAX_REFRESH_SKEW_MS = 60_000;

export interface TenantTokenProviderOptions {
  tenant: TenantBrand;
  appId: string;
  appSecret: string;
  request?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}

export interface TenantAccessToken {
  accessToken: string;
  expiresAt: number;
}

type TenantTokenErrorKind = 'network' | 'http' | 'invalid-json' | 'api';

export class TenantTokenError extends Error {
  constructor(
    readonly kind: TenantTokenErrorKind,
    message: string,
    readonly details: {
      status?: number;
      code?: number;
      apiMessage?: string;
    } = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'TenantTokenError';
  }
}

interface TokenResponse {
  code?: number;
  msg?: string;
  tenant_access_token?: string;
  expire?: number;
}

/**
 * Owns Lark's app-credential exchange and the short-lived tenant token cache.
 * Consumers ask for a token; they never exchange app credentials themselves.
 */
export class TenantTokenProvider {
  private readonly origin: string;
  private readonly request: typeof fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private cached?: { token: TenantAccessToken; usableUntil: number };
  private pending?: Promise<TenantAccessToken>;

  constructor(private readonly options: TenantTokenProviderOptions) {
    this.origin = larkOpenApiOrigin(options.tenant);
    this.request = options.request ?? larkFetch;
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async getToken(): Promise<string> {
    return (await this.get()).accessToken;
  }

  async get(): Promise<TenantAccessToken> {
    if (this.cached && this.now() < this.cached.usableUntil) return this.cached.token;
    this.pending ??= this.exchange().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  invalidate(): void {
    this.cached = undefined;
  }

  private async exchange(): Promise<TenantAccessToken> {
    let response: Response;
    try {
      response = await this.request(
        `${this.origin}/open-apis/auth/v3/tenant_access_token/internal`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            app_id: this.options.appId,
            app_secret: this.options.appSecret,
          }),
          signal: AbortSignal.timeout(this.timeoutMs),
        },
      );
    } catch (err) {
      throw new TenantTokenError(
        'network',
        `tenant token request failed: ${err instanceof Error ? err.message : String(err)}`,
        {},
        { cause: err },
      );
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new TenantTokenError(
        'http',
        `tenant token HTTP ${response.status}`,
        { status: response.status },
      );
    }

    let data: TokenResponse;
    try {
      data = await response.json() as TokenResponse;
    } catch (err) {
      throw new TenantTokenError(
        'invalid-json',
        'tenant token response is not valid JSON',
        {},
        { cause: err },
      );
    }
    if (data.code !== 0 || !data.tenant_access_token) {
      throw new TenantTokenError(
        'api',
        `tenant token failed: code=${data.code ?? '?'} msg=${data.msg ?? '<no msg>'}`,
        { code: data.code, apiMessage: data.msg },
      );
    }

    const now = this.now();
    const expireSeconds =
      typeof data.expire === 'number' && data.expire > 0
        ? data.expire
        : DEFAULT_EXPIRE_SECONDS;
    const lifetimeMs = expireSeconds * 1_000;
    const refreshSkewMs = Math.min(MAX_REFRESH_SKEW_MS, Math.floor(lifetimeMs / 2));
    const token = {
      accessToken: data.tenant_access_token,
      expiresAt: now + lifetimeMs,
    };
    this.cached = {
      token,
      usableUntil: token.expiresAt - refreshSkewMs,
    };
    return token;
  }
}

export function larkOpenApiOrigin(tenant: TenantBrand): string {
  return OPEN_API_ORIGINS[tenant];
}
