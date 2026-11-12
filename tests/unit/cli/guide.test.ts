import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { locateBinaries } from '../../../src/agent/locate';
import { expandLaunchEnvironment } from '../../../src/agent/launch-env';
import {
  accessChoices, audienceRisk, claudeGatewayEnv, cliCommand, detectProxyEnv, goesThroughProxy, guideText, inspectAgents,
  larkPermissionGuide, modelCredentialMode, proxyPlan, saveModelService, scopeApplyUrl,
} from '../../../src/cli/commands/guide';
import { createRootConfig, loadLarkNetworkConfig, loadRootConfig, saveRootConfig } from '../../../src/config/profile-store';
import { effectiveLarkCliIdentity } from '../../../src/config/profile-schema';
import { patchConfig } from '../../../src/config/service';
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

describe('guide audience', () => {
  it('asks for confirmation before opening full machine access to everyone, and warns for invited people', () => {
    expect(audienceRisk('team', 'full')).toBe('confirm');
    expect(audienceRisk('invited', 'full')).toBe('warn');
    expect(audienceRisk('owner', 'full')).toBeUndefined();
    expect(audienceRisk('team', 'workspace')).toBeUndefined();
    expect(audienceRisk('invited', 'read-only')).toBeUndefined();
  });

  it.skipIf(process.platform === 'win32')('creates a team profile that never carries the owner\'s Lark authorization', async () => {
    const root = await makeRoot();
    const claude = await writeVersionExecutable(root, 'claude', '2.1.0 (Claude Code)');
    const base = {
      agentKind: 'claude' as const,
      accounts: { app: { id: 'cli_guide', secret: '${APP_SECRET}', tenant: 'feishu' as const } },
      binaryPath: claude,
    };
    const team = await createBootstrapProfileConfig({ ...base, mode: 'team', permissions: { defaultAccess: 'workspace', maxAccess: 'workspace' } });
    const personal = await createBootstrapProfileConfig(base);

    expect(team.mode).toBe('team');
    expect(effectiveLarkCliIdentity(team)).toBe('bot-only');
    expect(personal.mode).toBe('personal');

    const configFile = join(root, 'config.toml');
    await saveRootConfig(createRootConfig('team', team, undefined), configFile);
    expect((await loadRootConfig(configFile))?.profiles.team?.mode).toBe('team');
  });
});

describe('guide network proxy', () => {
  it('reads proxy variables the way the Lark transport does: nonempty lowercase first', () => {
    expect(detectProxyEnv({ HTTPS_PROXY: 'http://upper:1', https_proxy: 'http://lower:2', http_proxy: '', HTTP_PROXY: 'http://upper:3', NO_PROXY: '.corp' }))
      .toEqual({
        http: { name: 'HTTP_PROXY', value: 'http://upper:3' },
        https: { name: 'https_proxy', value: 'http://lower:2' },
        all: undefined,
        noProxy: { name: 'NO_PROXY', value: '.corp' },
      });
  });

  it('stores the shell proxy for both the agent and the Lark connection, so a service start keeps it', () => {
    const detected = detectProxyEnv({ HTTPS_PROXY: 'http://proxy.corp:3128', HTTP_PROXY: 'http://proxy.corp:3128', NO_PROXY: 'localhost,.corp' });
    const plan = proxyPlan({ mode: 'inherit', detected });

    expect(plan.network).toEqual({ proxy: 'http://proxy.corp:3128', no_proxy: 'localhost,.corp' });
    expect(expandLaunchEnvironment(plan.launchEnv, {})).toEqual({
      HTTP_PROXY: 'http://proxy.corp:3128', HTTPS_PROXY: 'http://proxy.corp:3128', NO_PROXY: 'localhost,.corp',
    });
    expect(plan.envReferences).toEqual([]);
    expect(plan.warnings).toEqual([]);
  });

  it('applies an edited NO_PROXY, and uses the HTTP proxy for Lark when no HTTPS one is set', () => {
    const plan = proxyPlan({ mode: 'inherit', detected: detectProxyEnv({ http_proxy: 'http://proxy.corp:3128' }), noProxy: 'gw.corp' });

    expect(plan.network).toEqual({ proxy: 'http://proxy.corp:3128', no_proxy: 'gw.corp' });
    expect(plan.launchEnv).toEqual({ http_proxy: 'http://proxy.corp:3128', no_proxy: 'gw.corp' });
  });

  it('refers to the environment instead of storing a proxy URL that carries credentials', () => {
    const shell = { https_proxy: 'http://user:pa$$@proxy.corp:3128', no_proxy: '.corp' };
    const plan = proxyPlan({ mode: 'inherit', detected: detectProxyEnv(shell) });

    expect(JSON.stringify(plan)).not.toContain('pa$$');
    expect(plan.network).toEqual({ no_proxy: '.corp' });
    expect(plan.envReferences).toEqual(['https_proxy']);
    expect(plan.warnings).toHaveLength(1);
    expect(expandLaunchEnvironment(plan.launchEnv, shell)).toEqual(shell);
    expect(() => expandLaunchEnvironment(plan.launchEnv, {})).toThrow(/https_proxy/);
  });

  it('keeps a SOCKS proxy for the agent only and warns that Lark cannot use it', () => {
    const plan = proxyPlan({ mode: 'inherit', detected: detectProxyEnv({ ALL_PROXY: 'socks5://127.0.0.1:1080' }) });

    expect(plan.launchEnv).toEqual({ ALL_PROXY: 'socks5://127.0.0.1:1080' });
    expect(plan.network).toBeUndefined();
    expect(plan.warnings[0]).toContain('SOCKS');
  });

  it('writes nothing for a direct connection unless the shell has a proxy to override', () => {
    expect(proxyPlan({ mode: 'direct', detected: detectProxyEnv({}) })).toEqual({ launchEnv: {}, envReferences: [], warnings: [] });

    const plan = proxyPlan({ mode: 'direct', detected: detectProxyEnv({ HTTPS_PROXY: 'http://proxy.corp:3128', NO_PROXY: '.corp' }) });
    expect(plan.network).toEqual({ proxy: 'direct' });
    expect(plan.launchEnv).toEqual({ HTTPS_PROXY: '' });
  });

  it('uses a typed proxy for HTTP and HTTPS alike', () => {
    const plan = proxyPlan({ mode: 'manual', proxy: 'http://proxy.corp:3128', noProxy: '' });

    expect(plan.network).toEqual({ proxy: 'http://proxy.corp:3128' });
    expect(plan.launchEnv).toEqual({ http_proxy: 'http://proxy.corp:3128', https_proxy: 'http://proxy.corp:3128' });
  });

  it('tells whether the model gateway is proxied under the NO_PROXY rules', () => {
    expect(goesThroughProxy('https://gw.corp/v1', 'localhost,.internal')).toBe(true);
    expect(goesThroughProxy('https://gw.corp/v1', 'localhost,gw.corp')).toBe(false);
    expect(goesThroughProxy('https://gw.corp/v1', undefined)).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('saves the Lark network under the new profile only', async () => {
    const root = await makeRoot();
    const claude = await writeVersionExecutable(root, 'claude', '2.1.0 (Claude Code)');
    const plan = proxyPlan({ mode: 'manual', proxy: 'http://proxy.corp:3128', noProxy: 'localhost,.corp' });
    const profile = await createBootstrapProfileConfig({
      agentKind: 'claude',
      accounts: { app: { id: 'cli_guide', secret: '${APP_SECRET}', tenant: 'feishu' } },
      binaryPath: claude,
      launchEnv: { ...claudeGatewayEnv({ baseUrl: 'https://gw.corp' }), ...plan.launchEnv },
    });
    const configFile = join(root, 'config.toml');
    await saveRootConfig(createRootConfig('work', profile, undefined), configFile);
    await patchConfig(configFile, ['channels', 'lark', 'profiles', 'work', 'network'], plan.network);

    expect(await loadLarkNetworkConfig(configFile, 'work')).toEqual({ proxy: 'http://proxy.corp:3128', no_proxy: 'localhost,.corp' });
    expect(await loadLarkNetworkConfig(configFile, 'other')).toBeUndefined();
    const saved = await loadRootConfig(configFile);
    expect(saved?.profiles.work?.claude?.env).toMatchObject({ ANTHROPIC_BASE_URL: 'https://gw.corp', https_proxy: 'http://proxy.corp:3128', no_proxy: 'localhost,.corp' });
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
