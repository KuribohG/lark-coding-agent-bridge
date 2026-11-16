import { getSecret, removeSecret, setSecret } from '../config/keystore';
import type { KeystorePaths } from '../config/keystore';
import type { StoredUserToken, UserTokenStore } from './user-token';

/** Keystore entry holding a profile's user-identity OAuth grant. */
function userTokenSecretId(appId: string): string {
  return `user-oauth-${appId}`;
}

/**
 * Persist the user grant in the bridge's encrypted keystore — the same store
 * that holds app secrets, so it inherits the same at-rest protection and the
 * same `secrets get` exec-provider plumbing.
 *
 * The value is the whole {@link StoredUserToken} JSON: losing the refresh-token
 * expiry would silently start a doomed refresh loop at the next restart.
 */
export function keystoreUserTokenStore(
  appId: string,
  storePaths?: KeystorePaths,
): UserTokenStore {
  const id = userTokenSecretId(appId);
  return {
    async load() {
      const raw = await getSecret(id, storePaths);
      if (!raw) return undefined;
      try {
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return undefined;
        const record = parsed as Record<string, unknown>;
        if (typeof record.refreshToken !== 'string' || !record.refreshToken) return undefined;
        return {
          refreshToken: record.refreshToken,
          ...(typeof record.refreshExpiresAt === 'number'
            ? { refreshExpiresAt: record.refreshExpiresAt }
            : {}),
          ...(typeof record.openId === 'string' ? { openId: record.openId } : {}),
        } satisfies StoredUserToken;
      } catch {
        return undefined;
      }
    },
    async save(token) {
      await setSecret(id, JSON.stringify(token), storePaths);
    },
    async clear() {
      await removeSecret(id, storePaths);
    },
  };
}
