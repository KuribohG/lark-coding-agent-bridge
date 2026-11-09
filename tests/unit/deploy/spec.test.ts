import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseDocument } from '../../../src/config/document';
import { withProfileAndAppLocks } from '../../../src/runtime/locks';
import { resolveAppPaths } from '../../../src/config/app-paths';
import { findRunningBridges } from '../../../src/deploy/process';
import { bridgeEnvironment, launchFingerprint, resolveDeploySpec, runArgs } from '../../../src/deploy/spec';

const PROFILES = `
[profiles.alpha]
agent = "claude"

[profiles.beta]
agent = "codex"
`;

const doc = (extra = '') => parseDocument(`version = 3\n${extra}\n${PROFILES}`);

describe('[deploy] table', () => {
  it('defaults to running this installation for the autostart profiles', () => {
    const spec = resolveDeploySpec(doc('[bridge]\nautostart_profiles = ["beta", "alpha"]'), '/cfg/config.toml');
    expect(spec).toMatchObject({
      source: { kind: 'self' }, profiles: ['beta', 'alpha'], node: process.execPath, cwd: homedir(),
      root: '/cfg/deploy', keep: 3, env: {}, readyTimeoutMs: 180_000,
    });
    expect(resolveDeploySpec(doc('[bridge]\nactive_profile = "beta"'), '/cfg/config.toml').profiles).toEqual(['beta']);
    expect(resolveDeploySpec(doc(), '/cfg/config.toml').profiles).toEqual(['alpha']);
  });

  it('resolves git sources and paths relative to the config file', () => {
    const spec = resolveDeploySpec(doc(`
[deploy]
git = "https://example.com/bridge.git"
ref = "dev"
profiles = ["alpha"]
node = "bin/node"
cwd = "~/work"
root = "/srv/bridge"
keep = 5
ready_timeout_seconds = 60
env = { HTTPS_PROXY = "http://proxy" }
`), '/cfg/config.toml');
    expect(spec).toMatchObject({
      source: { kind: 'git', url: 'https://example.com/bridge.git', ref: 'dev' }, profiles: ['alpha'],
      node: '/cfg/bin/node', cwd: join(homedir(), 'work'), root: '/srv/bridge', keep: 5, readyTimeoutMs: 60_000,
      env: { HTTPS_PROXY: 'http://proxy' },
    });
  });

  it('rejects invalid deploy settings', () => {
    expect(() => doc('[deploy]\nref = "dev"')).toThrow(/deploy.ref: requires deploy.git/);
    expect(() => doc('[deploy]\nprofiles = ["gamma"]')).toThrow(/profile not found: gamma/);
    expect(() => doc('[deploy]\nbranch = "dev"')).toThrow(/deploy.branch: unknown setting/);
    expect(() => doc('[deploy]\nenv = { "1X" = "y" }')).toThrow(/invalid environment variable name/);
    expect(() => doc('[deploy]\nready_timeout_seconds = 1')).toThrow(/10..3600/);
  });

  it('builds the bridge environment without run bindings', () => {
    const env = bridgeEnvironment({ configPath: '/cfg/config.toml', env: { EXTRA: '1' } },
      { PATH: '/bin', LARK_CHANNEL: '1', LARK_CHANNEL_PROFILE: 'x', LARKSUITE_CLI_CONFIG_DIR: '/x', LARK_RUN_STOP_AT: '9' });
    expect(env).toEqual({ PATH: '/bin', LARK_CHANNEL_HOME: '/cfg', EXTRA: '1' });
  });

  it('selects profiles the way run expects and fingerprints launch settings', () => {
    expect(runArgs('/c.toml', ['a'])).toEqual(['run', '--profile', 'a', '--config', '/c.toml']);
    expect(runArgs('/c.toml', ['a', 'b'])).toEqual(['run', '--profiles', 'a', 'b', '--config', '/c.toml']);
    const base = { profiles: ['a'], node: '/n', cwd: '/w', env: { A: '1', B: '2' } };
    expect(launchFingerprint(base)).toBe(launchFingerprint({ ...base, env: { B: '2', A: '1' } }));
    expect(launchFingerprint(base)).not.toBe(launchFingerprint({ ...base, profiles: ['a', 'b'] }));
  });
});

describe('running bridge discovery', () => {
  const roots: string[] = [];
  afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

  it('finds the process holding a profile lock', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deploy-locks-'));
    roots.push(root);
    const configPath = join(root, 'config.toml');
    expect(await findRunningBridges(configPath, ['alpha'])).toEqual([]);
    await withProfileAndAppLocks(resolveAppPaths({ rootDir: root, profile: 'alpha' }), 'cli_alpha', 'claude', async () => {
      const [bridge] = await findRunningBridges(configPath, ['alpha', 'beta']);
      expect(bridge).toMatchObject({ pid: process.pid, profiles: ['alpha'] });
    });
  });
});
