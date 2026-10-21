import { describe, expect, it } from 'vitest';
import { larkCallbackSigningKeys } from '../../../src/lark-auth/callback-key';

describe('larkCallbackSigningKeys', () => {
  it('keeps v1 verification and makes a distinct deterministic v2 key', () => {
    const appSecret = 'app-secret';
    const first = larkCallbackSigningKeys(appSecret);
    const second = larkCallbackSigningKeys(appSecret);

    expect(first).toEqual(second);
    expect(first[0]).toEqual({ version: 1, secret: appSecret, retired: true });
    expect(first[1]?.version).toBe(2);
    expect(first[1]?.secret).not.toBe(appSecret);
    expect(first[1]?.secret).toHaveLength(43);
    expect(larkCallbackSigningKeys('other-secret')[1]?.secret).not.toBe(first[1]?.secret);
  });

  it('rejects an empty app secret', () => {
    expect(() => larkCallbackSigningKeys('')).toThrow('app secret is required');
  });
});
