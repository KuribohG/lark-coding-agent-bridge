import { resolveAppSecret } from '../../config/secret-resolver';
import { beginUserDeviceAuthorization, completeUserDeviceAuthorization, UserTokenProvider } from '../../lark-auth/user-token';
import { keystoreUserTokenStore } from '../../lark-auth/user-token-store';
import { resolveProfileRuntime } from '../../runtime/profile-runtime';

/**
 * `lark-channel-bridge auth user-*` — manage the user-identity OAuth grant the
 * read paths fall back to when the app is missing IM read scopes.
 *
 * The grant is stored in the profile's encrypted keystore (same store as the
 * app secret) as a refresh token, so it survives restarts; the running bridge
 * only refreshes it, it never needs the device flow again until the refresh
 * token expires.
 */

export interface UserAuthOptions {
  config?: string;
  profile?: string;
  /** Space-separated scopes for the grant; defaults to the app's configured set. */
  scope?: string;
}

const DEFAULT_SCOPES = 'offline_access im:message:readonly im:chat:readonly im:resource';

export async function runUserAuthLogin(opts: UserAuthOptions = {}): Promise<void> {
  const runtime = await resolveProfileRuntime({ config: opts.config, profile: opts.profile });
  const { cfg, appPaths } = runtime;
  const appId = cfg.accounts.app.id;
  const tenant = cfg.accounts.app.tenant;
  const appSecret = await resolveAppSecret(cfg, appPaths);

  console.log(`为 ${runtime.profile} (${appId}, ${tenant}) 申请用户身份授权…`);
  const device = await beginUserDeviceAuthorization({
    tenant,
    appId,
    appSecret,
    scope: opts.scope ?? DEFAULT_SCOPES,
  });

  console.log('\n请在浏览器打开下面的链接并确认授权（10 分钟内有效）：\n');
  console.log(device.verificationUrl);
  console.log('');

  let lastNotice = 0;
  const grant = await completeUserDeviceAuthorization({
    tenant,
    appId,
    appSecret,
    deviceCode: device.deviceCode,
    expiresInMs: device.expiresInMs,
    intervalMs: device.intervalMs,
    onPending: () => {
      const now = Date.now();
      if (now - lastNotice < 15_000) return;
      lastNotice = now;
      console.log('等待授权中…');
    },
  });

  await keystoreUserTokenStore(appId, appPaths).save({
    refreshToken: grant.refreshToken,
    ...(grant.refreshExpiresAt !== undefined ? { refreshExpiresAt: grant.refreshExpiresAt } : {}),
    ...(grant.openId ? { openId: grant.openId } : {}),
  });

  console.log(`\n✓ 已保存用户授权${grant.openId ? `（${grant.openId}）` : ''}`);
  console.log(`  refresh token 过期时间：${formatWhen(grant.refreshExpiresAt)}`);
  console.log('  重启 bridge 后，读路径会在应用身份失败时自动使用该用户身份。');
}

export async function runUserAuthStatus(opts: UserAuthOptions = {}): Promise<void> {
  const runtime = await resolveProfileRuntime({ config: opts.config, profile: opts.profile });
  const { cfg, appPaths } = runtime;
  const appId = cfg.accounts.app.id;
  const store = keystoreUserTokenStore(appId, appPaths);
  const stored = await store.load();
  console.log(`profile: ${runtime.profile}`);
  console.log(`app: ${appId} (${cfg.accounts.app.tenant})`);
  if (!stored) {
    console.log('用户身份授权：未配置（读路径只用应用身份）');
    return;
  }
  console.log('用户身份授权：已配置');
  if (stored.openId) console.log(`  open_id: ${stored.openId}`);
  console.log(`  refresh token 过期时间：${formatWhen(stored.refreshExpiresAt)}`);
  const provider = new UserTokenProvider({
    tenant: cfg.accounts.app.tenant,
    appId,
    appSecret: await resolveAppSecret(cfg, appPaths),
    store,
  });
  const access = await provider.getAccessToken();
  console.log(access
    ? `  当前 access token 可用，到期：${formatWhen(access.expiresAt)}`
    : '  ⚠ 现在无法刷新 access token（刷新失败，bridge 会退回应用身份）');
}

export async function runUserAuthLogout(opts: UserAuthOptions = {}): Promise<void> {
  const runtime = await resolveProfileRuntime({ config: opts.config, profile: opts.profile });
  const store = keystoreUserTokenStore(runtime.cfg.accounts.app.id, runtime.appPaths);
  await store.clear();
  console.log(`✓ 已删除 ${runtime.profile} 的用户身份授权`);
}

function formatWhen(epochMs: number | undefined): string {
  if (epochMs === undefined) return '未知';
  return new Date(epochMs).toLocaleString('zh-CN', { hour12: false });
}
