import { hkdfSync } from 'node:crypto';

export interface LarkCallbackSigningKey {
  version: number;
  secret: string;
  retired?: boolean;
}

/**
 * Callback signatures must not reuse the raw App Secret. Keep v1 available
 * only for cards issued before this refactor; v2 is the active signing key.
 */
export function larkCallbackSigningKeys(appSecret: string): LarkCallbackSigningKey[] {
  if (!appSecret) throw new Error('app secret is required');
  const derived = Buffer.from(
    hkdfSync(
      'sha256',
      appSecret,
      '',
      'lark-channel-bridge/callback-signing/v2',
      32,
    ),
  ).toString('base64url');
  return [
    { version: 1, secret: appSecret, retired: true },
    { version: 2, secret: derived },
  ];
}
