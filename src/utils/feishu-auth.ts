import type { TenantBrand } from '../config/schema';
import type { LarkNetworkConfig } from '../config/lark-network';
import { LarkNetwork } from '../lark-auth/network';
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
  networkConfig?: LarkNetworkConfig,
): Promise<ValidationResult> {
  const base = larkOpenApiOrigin(tenant);
  let network: LarkNetwork | undefined;
  try {
    network = new LarkNetwork(networkConfig);
    return await validateUsingNetwork(appId, appSecret, tenant, base, network.request);
  } catch (error) {
    return { ok: false, reason: validationFailureReason(error) };
  } finally {
    await network?.close();
  }
}

async function validateUsingNetwork(appId: string, appSecret: string, tenant: TenantBrand, base: string, request: typeof fetch): Promise<ValidationResult> {
  let token: string;
  try {
    token = await new TenantTokenProvider({ tenant, appId, appSecret, request }).getToken();
  } catch (err) {
    return { ok: false, reason: validationFailureReason(err) };
  }

  const info = await fetchBotInfo(base, token, request).catch(() => undefined);
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

async function fetchBotInfo(base: string, token: string, request: typeof fetch): Promise<BotInfoResp | undefined> {
  const resp = await request(`${base}/open-apis/bot/v3/info`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) {
    await resp.body?.cancel();
    return undefined;
  }
  return (await resp.json()) as BotInfoResp;
}
