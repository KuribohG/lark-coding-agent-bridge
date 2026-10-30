import { describe, expect, it, vi } from 'vitest';
import { resolveAppPaths } from '../../../src/config/app-paths';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import * as secretResolver from '../../../src/config/secret-resolver';
import { LarkProfileAuth } from '../../../src/lark-auth/profile-auth';

describe('LarkProfileAuth', () => {
  it('keeps shared transports alive until background users finish', async () => {
    const auth = new LarkProfileAuth({ accounts: { app: { id: 'app', secret: 'test-secret', tenant: 'feishu' } },
      channels: { lark: { network: { proxy: 'direct' } } } });
    const network = auth.network;
    const close = vi.spyOn(network, 'close');
    const first = auth.retainNetwork();
    const second = auth.retainNetwork();
    await auth.close();
    await first();
    await first();
    expect(close).not.toHaveBeenCalled();
    await second();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('cancels deferred shutdown when an agent-switch rollback reactivates the profile', async () => {
    const auth = new LarkProfileAuth({ accounts: { app: { id: 'app', secret: 'test-secret', tenant: 'feishu' } },
      channels: { lark: { network: { proxy: 'direct' } } } });
    const network = auth.network;
    const close = vi.spyOn(network, 'close');
    const release = auth.retainNetwork();
    await auth.close();
    auth.resumeNetwork();
    await release();
    expect(close).not.toHaveBeenCalled();
    await auth.close();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('resolves credentials once and shares token and callback-key state', async () => {
    const profile = createDefaultProfileConfig({
      agentKind: 'codex',
      accounts: {
        app: { id: 'cli_test', secret: 'app-secret', tenant: 'feishu' },
      },
      codex: { binaryPath: 'codex' },
    });
    const resolve = vi.spyOn(secretResolver, 'resolveAppSecret');
    const paths = resolveAppPaths({ rootDir: '/tmp/profile-auth', profile: 'codex' });
    const auth = new LarkProfileAuth(profile, paths);

    const [first, second] = await Promise.all([
      auth.credentials(),
      auth.credentials(),
    ]);
    expect(first).toEqual({
      appId: 'cli_test',
      appSecret: 'app-secret',
      tenant: 'feishu',
    });
    expect(second).toBe(first);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(await auth.tenantTokens()).toBe(await auth.tenantTokens());
    expect(await auth.callbackKeys()).toBe(await auth.callbackKeys());
  });
});
