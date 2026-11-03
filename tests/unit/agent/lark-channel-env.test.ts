import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildLarkChannelEnv, LARK_CHANNEL_ENV_KEYS } from '../../../src/agent/lark-channel-env';
import { buildAgentEnvironment } from '../../../src/agent/launch-env';
import { codexExecutionEnvironment } from '../../../src/agent/codex/environment';
import { mergeProcessEnv } from '../../../src/platform/spawn';

describe('Lark frontend environment binding', () => {
  it('clears missing bindings instead of inheriting another frontend', () => {
    const inherited = Object.fromEntries(LARK_CHANNEL_ENV_KEYS.map(key => [key, 'other-frontend']));
    const host = buildLarkChannelEnv();
    const env = buildAgentEnvironment(host, undefined, inherited);
    expect(mergeProcessEnv(inherited, env)).toEqual({ LARK_CHANNEL: '1' });
    const codex = codexExecutionEnvironment({ profile: env, backend: {}, inherited });
    expect(codex.tools.set).toEqual({ LARK_CHANNEL: '1' });
    expect(codex.tools.exclude).toEqual(LARK_CHANNEL_ENV_KEYS.slice(1));
  });

  it('keeps the receiving frontend authoritative over shared launch settings', () => {
    const host = buildLarkChannelEnv({ profile: 'frontend-b', rootDir: '/bridge', larkCliConfigDir: '/bridge/profiles/frontend-b/lark-cli' });
    const launch = Object.fromEntries(LARK_CHANNEL_ENV_KEYS.map(key => [key.toLowerCase(), 'frontend-a']));
    const env = buildAgentEnvironment(host, { ...launch, FRONTEND_COPY: '$LARK_CHANNEL_PROFILE' }, {});
    expect(env).toEqual({ ...host, FRONTEND_COPY: 'frontend-b' });
    expect(host.LARK_CHANNEL_CONFIG)
      .toBe(join('/bridge', 'profiles', 'frontend-b', 'lark-cli-source', 'config.json'));
  });

  it('keeps concurrent Codex thread bindings independent even with the same daemon home', () => {
    const build = (profile: string) => codexExecutionEnvironment({
      profile: { ...buildLarkChannelEnv({ profile, rootDir: '/bridge', larkCliConfigDir: `/bridge/profiles/${profile}/lark-cli` }), CODEX_HOME: '/shared-codex' },
      backend: {}, inherited: { LARK_CHANNEL_PROFILE: 'stale-daemon-profile' },
    });
    const a = build('frontend-a');
    const b = build('frontend-b');
    expect(a.tools.set.LARK_CHANNEL_PROFILE).toBe('frontend-a');
    expect(b.tools.set.LARK_CHANNEL_PROFILE).toBe('frontend-b');
    expect(b.tools.set.LARKSUITE_CLI_CONFIG_DIR).toBe('/bridge/profiles/frontend-b/lark-cli');
    expect(a.tools.set.LARK_CHANNEL_CONFIG).not.toBe(b.tools.set.LARK_CHANNEL_CONFIG);
  });
});
