import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { locateBinaries } from '../../../src/agent/locate';
import { expandLaunchEnvironment } from '../../../src/agent/launch-env';
import {
  accessChoices, claudeGatewayEnv, cliCommand, guideText, inspectAgents, larkPermissionGuide,
  modelCredentialMode, saveModelService, scopeApplyUrl,
} from '../../../src/cli/commands/guide';
import { createRootConfig, loadRootConfig, saveRootConfig } from '../../../src/config/profile-store';
import { createBootstrapProfileConfig } from '../../../src/cli/profile-bootstrap';
import { writeVersionExecutable } from '../../helpers/fake-executable';

const roots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'bridge-guide-'));
  roots.push(root);
  return root;
}

async function binDir(root: string, ...segments: string[]): Promise<string> {
  const dir = join(root, ...segments);
  await mkdir(dir, { recursive: true });
  return dir;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe.skipIf(process.platform === 'win32')('agent executable discovery', () => {
  it('lists PATH hits first, then installs outside PATH, folding symlinked duplicates', async () => {
    const root = await makeRoot();
    const home = join(root, 'home');
    const onPath = await writeVersionExecutable(await binDir(root, 'path-bin'), 'codex', 'codex 1.0.0');
    const nvm = await writeVersionExecutable(await binDir(home, '.nvm', 'versions', 'node', 'v22.1.0', 'bin'), 'codex', 'codex 2.0.0');
    // ~/.local/bin/codex is only a link to the PATH install, not a second install.
    await symlink(onPath, join(await binDir(home, '.local', 'bin'), 'codex'));
    // A directory or non-executable file with the right name is not an install.
    await mkdir(join(await binDir(home, '.bun', 'bin'), 'codex'));
    await writeFile(join(await binDir(home, '.volta', 'bin'), 'codex'), 'not executable', { mode: 0o644 });

    const found = await locateBinaries('codex', {
      env: { PATH: join(root, 'path-bin') },
      home,
      nodeDir: join(root, 'node-bin'),
      systemDirs: [],
    });

    expect(found.map(item => [item.path, item.onPath])).toEqual([[onPath, true], [nvm, false]]);
  });

  it('reports each install with its version, and keeps broken ones with the reason', async () => {
    const root = await makeRoot();
    const home = join(root, 'home');
    const claude = await writeVersionExecutable(await binDir(home, '.local', 'bin'), 'claude', '2.1.0 (Claude Code)');
    const broken = join(await binDir(home, '.npm-global', 'bin'), 'claude');
    await writeFile(broken, '#!/bin/sh\nexit 3\n');
    await chmod(broken, 0o755);

    const inspections = await inspectAgents({ env: { PATH: '' }, home, nodeDir: join(root, 'node-bin'), systemDirs: [] });
    const found = inspections.find(item => item.kind === 'claude')!;

    expect(found.candidates).toHaveLength(2);
    expect(found.candidates[0]).toEqual({ path: claude, onPath: false, version: '2.1.0 (Claude Code)' });
    expect(found.candidates[1]).toMatchObject({ path: broken, onPath: false });
    expect(found.candidates[1]!.version).toBeUndefined();
    expect(found.candidates[1]!.error).toBeTruthy();
    expect(inspections.find(item => item.kind === 'codex')!.candidates).toEqual([]);
  });

  it('uses the backend command override as the only candidate when it is an absolute path', async () => {
    const root = await makeRoot();
    const custom = await writeVersionExecutable(await binDir(root, 'custom'), 'my-codex', 'codex 9.9.9');

    const inspections = await inspectAgents({
      env: { PATH: '', LARK_CHANNEL_CODEX_BIN: custom },
      home: join(root, 'home'),
      nodeDir: join(root, 'node-bin'),
      systemDirs: [],
    });

    expect(inspections.find(item => item.kind === 'codex')!.candidates).toEqual([
      { path: custom, onPath: false, version: 'codex 9.9.9' },
    ]);
  });
});

describe('guide profile creation inputs', () => {
  it.skipIf(process.platform === 'win32')('writes the chosen executable and permissions for a backend that defaults to PATH lookup', async () => {
    const root = await makeRoot();
    const claude = await writeVersionExecutable(root, 'claude', '2.1.0 (Claude Code)');
    const accounts = { app: { id: 'cli_guide', secret: '${APP_SECRET}', tenant: 'feishu' as const } };

    const chosen = await createBootstrapProfileConfig({
      agentKind: 'claude',
      accounts,
      binaryPath: claude,
      permissions: { defaultAccess: 'workspace', maxAccess: 'workspace' },
    });
    const untouched = await createBootstrapProfileConfig({ agentKind: 'claude', accounts });

    expect(chosen.claude?.binaryPath).toBe(claude);
    expect(chosen.permissions).toMatchObject({ defaultAccess: 'workspace', maxAccess: 'workspace' });
    expect(untouched.claude?.binaryPath).toBeUndefined();
    expect(untouched.permissions).toMatchObject({ defaultAccess: 'full', maxAccess: 'full' });
  });

  it('offers only the access levels the agent supports, widest first', () => {
    expect(accessChoices('claude')).toEqual(['full', 'workspace', 'read-only']);
    expect(accessChoices('codex')).toEqual(['full', 'workspace', 'read-only']);
    expect(accessChoices('pi')).toEqual(['full', 'read-only']);
    expect(accessChoices('agy')).toEqual(['full']);
  });

  it('prints follow-up commands the way this CLI was invoked', () => {
    expect(cliCommand(['/usr/bin/node', 'bin/lark-channel-bridge.mjs', 'guide'])).toBe('node bin/lark-channel-bridge.mjs');
    expect(cliCommand(['/usr/bin/node', '/usr/local/bin/lark-channel-bridge', 'guide'])).toBe('lark-channel-bridge');

    const text = guideText('node bin/lark-channel-bridge.mjs');
    expect(text).toContain('node bin/lark-channel-bridge.mjs profile create <名称>');
    expect(text).toContain('node bin/lark-channel-bridge.mjs run --profile <名称>');
  });
});

describe('guide model credentials', () => {
  it('routes a third-party token through launch env for Claude and a model service for Responses agents', () => {
    expect(modelCredentialMode('claude')).toBe('env');
    expect(modelCredentialMode('codex')).toBe('service');
    expect(modelCredentialMode('pi')).toBe('service');
    expect(modelCredentialMode('agy')).toBe('none');
  });

  it('keeps a literal token intact through launch env expansion, including `$`', () => {
    const env = claudeGatewayEnv({ baseUrl: 'https://gw.example/api', token: 'sk-a$b${c}$$d', model: 'm-1' });

    expect(expandLaunchEnvironment(env, {})).toEqual({
      ANTHROPIC_BASE_URL: 'https://gw.example/api',
      ANTHROPIC_AUTH_TOKEN: 'sk-a$b${c}$$d',
      ANTHROPIC_MODEL: 'm-1',
    });
  });

  it('refers to the Bridge environment when no token is stored', () => {
    const env = claudeGatewayEnv({ baseUrl: 'https://gw.example' });

    expect(env).toEqual({ ANTHROPIC_BASE_URL: 'https://gw.example', ANTHROPIC_AUTH_TOKEN: '${ANTHROPIC_AUTH_TOKEN}' });
    expect(expandLaunchEnvironment(env, { ANTHROPIC_AUTH_TOKEN: 'from-shell' }).ANTHROPIC_AUTH_TOKEN).toBe('from-shell');
    expect(() => expandLaunchEnvironment(env, {})).toThrow(/ANTHROPIC_AUTH_TOKEN/);
  });

  it.skipIf(process.platform === 'win32')('writes the gateway env into the created profile and registers a file-backed model service', async () => {
    const root = await makeRoot();
    const claude = await writeVersionExecutable(root, 'claude', '2.1.0 (Claude Code)');
    const profile = await createBootstrapProfileConfig({
      agentKind: 'claude',
      accounts: { app: { id: 'cli_guide', secret: '${APP_SECRET}', tenant: 'feishu' } },
      binaryPath: claude,
      launchEnv: claudeGatewayEnv({ baseUrl: 'https://gw.example', token: 'sk-test' }),
    });
    expect(profile.claude).toMatchObject({
      binaryPath: claude,
      env: { ANTHROPIC_BASE_URL: 'https://gw.example', ANTHROPIC_AUTH_TOKEN: 'sk-test' },
    });

    const configFile = join(root, 'config.toml');
    await saveRootConfig(createRootConfig('claude', profile, undefined), configFile);
    const keyFile = await saveModelService(root, configFile, {
      name: 'gateway', baseUrl: 'https://gw.example/v1/', model: 'model-x', token: 'sk-service',
    });

    expect(await readFile(keyFile, 'utf8')).toBe('sk-service\n');
    expect((await stat(keyFile)).mode & 0o777).toBe(0o600);
    const saved = await loadRootConfig(configFile);
    expect(saved?.modelServices?.gateway).toEqual({
      protocol: 'responses', baseUrl: 'https://gw.example/v1', model: 'model-x', apiKey: { source: 'file', id: keyFile },
    });
    expect(saved?.profiles.claude?.claude?.env?.ANTHROPIC_AUTH_TOKEN).toBe('sk-test');
    expect(await readFile(configFile, 'utf8')).not.toContain('sk-service');
  });
});

describe('guide Feishu permissions', () => {
  it('links to the console page that applies for the required scopes on the right tenant', () => {
    expect(scopeApplyUrl('cli_x', 'feishu', ['im:resource', 'im:chat:readonly']))
      .toBe('https://open.feishu.cn/page/scope-apply?clientID=cli_x&scopes=im%3Aresource%2Cim%3Achat%3Areadonly');
    expect(scopeApplyUrl('cli_x', 'lark', ['im:resource'])).toContain('https://open.larksuite.com/page/scope-apply?');
  });

  it('lists scopes, events and publishing, and leaves the optional scope out of the one-shot link', () => {
    const text = larkPermissionGuide('cli_x', 'feishu');

    for (const needle of ['im:message.p2p_msg:readonly', 'im:message.group_at_msg:readonly', 'im:message:send_as_bot',
      'im.message.receive_v1', 'card.action.trigger', '长连接', '发布']) expect(text).toContain(needle);
    const link = text.split('\n').find(line => line.includes('scope-apply'))!;
    expect(decodeURIComponent(link)).toContain('im:message:send_as_bot');
    expect(decodeURIComponent(link)).not.toContain('im:message.group_msg');
    expect(guideText('bridge')).toContain('im:message.p2p_msg:readonly');
  });
});
