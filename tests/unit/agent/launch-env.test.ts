import { describe, expect, it } from 'vitest';
import {
  buildAgentEnvironment,
  expandLaunchEnvironment,
  splitLaunchEnvironment,
} from '../../../src/agent/launch-env';
import { normalizeExecutableFields } from '../../../src/agent/launch-options';
import { mergeProcessEnv } from '../../../src/platform/spawn';

describe('agent launch environment', () => {
  it('expands references and keeps literal dollar signs escaped', () => {
    const source = {
      HTTP_PROXY: 'http://proxy.internal:8080',
      HTTPS_PROXY: 'http://secure-proxy.internal:8443',
    };

    expect(expandLaunchEnvironment({
      HTTP_PROXY: '$HTTP_PROXY',
      HTTPS_PROXY: '${HTTPS_PROXY}',
      BANNER: '$$HTTP_PROXY',
    }, source)).toEqual({
      HTTP_PROXY: 'http://proxy.internal:8080',
      HTTPS_PROXY: 'http://secure-proxy.internal:8443',
      BANNER: '$HTTP_PROXY',
    });
  });

  it('builds child overrides with launch values taking precedence', () => {
    const env = buildAgentEnvironment(
      { LARK_CHANNEL: '1', https_proxy: 'http://from-host:8080' },
      { HTTPS_PROXY: '$https_proxy', NO_PROXY: 'localhost,127.0.0.1' },
      { PATH: '/bin', HTTP_PROXY: 'http://from-process:8080' },
    );

    expect(env).toMatchObject({
      LARK_CHANNEL: '1',
      HTTPS_PROXY: 'http://from-host:8080',
      NO_PROXY: 'localhost,127.0.0.1',
    });
    expect(env).not.toHaveProperty('PATH');
    expect(env).not.toHaveProperty('HTTP_PROXY');
    expect(Object.keys(env).filter((key) => key.toLowerCase() === 'https_proxy')).toEqual([
      'HTTPS_PROXY',
    ]);
  });

  it('preserves explicit environment removals for the adapter merge', () => {
    const env = buildAgentEnvironment(
      { CODEX_HOME: undefined },
      { HTTPS_PROXY: '$HTTPS_PROXY' },
      { CODEX_HOME: '/outer/codex-home', HTTPS_PROXY: 'http://proxy.internal:8443' },
    );

    expect(env).toHaveProperty('CODEX_HOME', undefined);
    expect(env.HTTPS_PROXY).toBe('http://proxy.internal:8443');
  });

  it('fails explicitly when a referenced variable is missing', () => {
    expect(() => expandLaunchEnvironment(
      { HTTPS_PROXY: '$MISSING_PROXY_FOR_TEST' },
      {},
    )).toThrow('launch env HTTPS_PROXY references missing environment variable MISSING_PROXY_FOR_TEST');
  });

  it('normalizes undefined launch env entries into unsetEnv and scrubs case-insensitively in mergeProcessEnv', () => {
    const normalized = normalizeExecutableFields({
      env: { FOO: 'bar', OPENAI_API_KEY: undefined },
      unsetEnv: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'],
    });
    expect(normalized.env).toEqual({ FOO: 'bar' });
    expect(normalized.unsetEnv).toEqual(['ANTHROPIC_API_KEY', 'OPENAI_API_KEY']);

    const split = splitLaunchEnvironment({ A: '1', B: undefined }, ['C']);
    expect(split).toEqual({ env: { A: '1' }, unsetKeys: ['C', 'B'] });

    const envOverrides = buildAgentEnvironment(
      { LARK_CHANNEL: '1', OPENAI_API_KEY: 'ambient-host' },
      { OPENAI_API_KEY: undefined, KEEP: 'yes' },
      { ANTHROPIC_API_KEY: 'ambient-proc' },
      ['ANTHROPIC_API_KEY'],
    );
    expect(envOverrides).toHaveProperty('OPENAI_API_KEY', undefined);
    expect(envOverrides).toHaveProperty('ANTHROPIC_API_KEY', undefined);
    expect(envOverrides.KEEP).toBe('yes');

    const merged = mergeProcessEnv(
      { openai_api_key: 'ambient-lower', ANTHROPIC_AUTH_TOKEN: 'ambient-token', KEEP_BASE: '1' },
      envOverrides,
      ['anthropic_auth_token'],
    );
    expect(merged).not.toHaveProperty('openai_api_key');
    expect(merged).not.toHaveProperty('OPENAI_API_KEY');
    expect(merged).not.toHaveProperty('ANTHROPIC_AUTH_TOKEN');
    expect(merged).toMatchObject({ KEEP_BASE: '1', KEEP: 'yes', LARK_CHANNEL: '1' });
  });
});
