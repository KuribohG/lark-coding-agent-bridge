import type { LarkChannel } from '@larksuite/channel';
import { log } from '../../core/logger';
import { GROUP_MSG_SCOPE } from '../../lark-auth/scope-grant';

/**
 * Fetch the set of scopes currently granted to this app via
 * `application.v6.application.get`. The channel's `getAppInfo()` only
 * surfaces owner/name, so we read the `scopes` array off the raw node-sdk
 * client instead.
 *
 * Returns `null` on API failure — the caller treats "unknown" as "don't
 * nag the user" rather than guessing the scope is missing.
 */
async function fetchGrantedScopes(
  channel: LarkChannel,
  appId: string,
): Promise<Set<string> | null> {
  try {
    const res = await channel.rawClient.application.application.get({
      params: { lang: 'zh_cn', user_id_type: 'open_id' },
      path: { app_id: appId },
    });
    const scopes = res.data?.app?.scopes ?? [];
    return new Set(scopes.map((s) => s.scope));
  } catch (err) {
    log.warn('app-scope', 'fetch-failed', {
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Whether the app has the group-message scope.
 * `null` means the lookup failed (treat as "don't know" — see above).
 */
export async function hasGroupMsgScope(
  channel: LarkChannel,
  appId: string,
): Promise<boolean | null> {
  const scopes = await fetchGrantedScopes(channel, appId);
  if (scopes === null) return null;
  return scopes.has(GROUP_MSG_SCOPE);
}
