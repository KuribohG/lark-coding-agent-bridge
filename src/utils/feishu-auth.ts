import type { TenantBrand } from '../config/schema';
import {
  TenantTokenError,
  TenantTokenProvider,
  larkOpenApiOrigin,
} from '../lark-auth/tenant-token';

export interface ValidationResult {
  ok: boolean;
  reason?: string;
  botName?: string;
  botOpenId?: string;
}

interface BotInfoResp {
  code?: number;
  bot?: {
    activate_status?: number;
    app_name?: string;
    open_id?: string;
  };
}

/**
 * Validate app credentials by exchanging them for a tenant_access_token. If
 * that succeeds, also try to fetch the bot's display name (best-effort).
 */
export async function validateAppCredentials(
  appId: string,
  appSecret: string,
  tenant: TenantBrand,
): Promise<ValidationResult> {
  const base = larkOpenApiOrigin(tenant);
  let token: string;
  try {
    token = await new TenantTokenProvider({ tenant, appId, appSecret }).getToken();
  } catch (err) {
    return { ok: false, reason: validationFailureReason(err) };
  }

  const info = await fetchBotInfo(base, token).catch(() => undefined);
  return { ok: true, botName: info?.bot?.app_name, botOpenId: info?.bot?.open_id };
}

function validationFailureReason(err: unknown): string {
  if (err instanceof TenantTokenError) {
    switch (err.kind) {
      case 'network':
        return `网络错误：${err.message}`;
      case 'http':
        return `HTTP ${err.details.status ?? '?'}`;
      case 'invalid-json':
        return '响应不是合法 JSON';
      case 'api':
        return `code=${err.details.code ?? '?'} msg=${err.details.apiMessage ?? '<no msg>'}`;
    }
  }
  return err instanceof Error ? err.message : String(err);
}

async function fetchBotInfo(base: string, token: string): Promise<BotInfoResp | undefined> {
  const resp = await fetch(`${base}/open-apis/bot/v3/info`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) return undefined;
  return (await resp.json()) as BotInfoResp;
}
