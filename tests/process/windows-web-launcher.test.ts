import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { parse, stringify } from 'smol-toml';
import { afterEach, describe, expect, it } from 'vitest';

const execute = promisify(execFile);
const directories: string[] = [];
const launcher = join(process.cwd(), 'bin/windows/run-web.mjs');

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function fixture(auth: 'bearer' | 'environment' | 'missing' | 'oauth') {
  const directory = await mkdtemp(join(tmpdir(), 'web-native-config-'));
  directories.push(directory);
  const configFile = join(directory, 'config.toml');
  const config = stringify({
    model: 'private/test-model',
    model_provider: auth === 'oauth' ? 'openai' : 'test',
    model_reasoning_effort: 'high',
    notify: ['do-not-run'],
    mcp_servers: { private: { command: 'do-not-run' } },
    model_providers: {
      test: {
        name: 'Test provider',
        base_url: 'https://gateway.invalid/v1',
        wire_api: 'responses',
        ...(auth === 'bearer' ? { experimental_bearer_token: 'fixture-provider-secret' } : {}),
        ...(auth === 'environment' ? { env_key: 'FIXTURE_PROVIDER_KEY' } : {}),
        http_headers: { 'X-Private': 'fixture-header-secret' },
        env_http_headers: { 'X-Tenant': 'FIXTURE_TENANT' },
      },
    },
  });
  await writeFile(configFile, config);
  const stateDir = join(directory, 'isolated');
  return {
    config,
    configFile,
    stateDir,
    env: {
      ...process.env,
      CODEX_HOME: directory,
      BRIDGE_WEB_STATE_DIR: stateDir,
      FIXTURE_PROVIDER_KEY: 'fixture-provider-secret',
    },
  };
}

describe('isolated Windows Web launcher configuration', () => {
  it('uses a short stable home for new repositories and preserves legacy state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'web-state-'));
    directories.push(root);
    const repository = join(root, 'deep', 'repository');
    const resolveState = async (path: string) => {
      const result = await execute(process.execPath, [
        join(process.cwd(), 'bin/windows/state-dir.mjs'), path,
      ]);
      return result.stdout;
    };
    const short = await resolveState(repository);
    expect(short).toMatch(/[\\/]\.lark-web[\\/][a-f0-9]{8}$/);
    expect(await resolveState(repository)).toBe(short);
    expect(await resolveState(`${repository}-other`)).not.toBe(short);
    const legacy = join(repository, '.web-local');
    await mkdir(legacy, { recursive: true });
    await writeFile(join(legacy, 'session-marker'), 'preserved');
    expect(await resolveState(repository)).toBe(legacy);
    expect(await readFile(join(legacy, 'session-marker'), 'utf8')).toBe('preserved');
  });

  it.each(['bearer', 'environment'] as const)('reuses %s credentials without persisting them or native plugins', async auth => {
    const source = await fixture(auth);
    const result = await execute(process.execPath, [launcher, '--help'], { env: source.env, timeout: 15_000 });
    const saved = await readFile(join(source.stateDir, 'codex-home/config.toml'), 'utf8');
    expect(result.stdout).toContain('Usage: lark-channel-bridge');
    expect(saved + result.stdout + result.stderr).not.toMatch(/fixture-provider-secret|fixture-header-secret/);
    expect(parse(saved)).toMatchObject({
      model: 'private/test-model',
      model_provider: 'test',
      model_reasoning_effort: 'high',
      model_providers: {
        test: {
          base_url: 'https://gateway.invalid/v1',
          env_key: 'BRIDGE_CODEX_PROVIDER_KEY',
          env_http_headers: { 'X-Private': 'BRIDGE_CODEX_HEADER_0', 'X-Tenant': 'FIXTURE_TENANT' },
        },
      },
    });
    expect(parse(saved)).not.toHaveProperty('mcp_servers');
    expect(parse(saved)).not.toHaveProperty('notify');
    expect(await readFile(source.configFile, 'utf8')).toBe(source.config);
  });

  it.each(['missing', 'oauth'] as const)('refuses %s authentication rather than falling back to another account', async auth => {
    const source = await fixture(auth);
    await expect(execute(process.execPath, [launcher, '--help'], { env: source.env, timeout: 15_000 }))
      .rejects.toMatchObject({ code: 1 });
    expect(await readFile(source.configFile, 'utf8')).toBe(source.config);
  });
});
