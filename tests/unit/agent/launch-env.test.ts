import { describe, expect, it } from 'vitest';
import {
  buildAgentEnvironment,
  expandLaunchEnvironment,
} from '../../../src/agent/launch-env';

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
});
