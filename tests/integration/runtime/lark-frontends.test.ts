import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { createRootConfig, saveRootConfig } from '../../../src/config/profile-store';
import { resolveAppPaths } from '../../../src/config/app-paths';
import { writeLarkCliSourceProjection } from '../../../src/lark-cli/profile-projection';
import { Supervisor } from '../../../src/runtime/supervisor';
import type { StartChannelDeps } from '../../../src/channels/lark/channel';

let root: string;
let supervisor: Supervisor | undefined;
afterEach(async () => {
  await supervisor?.shutdown();
  vi.unstubAllEnvs();
  if (root) await rm(root, { recursive: true, force: true });
});

it('routes concurrent frontends to independent CLI identities and sessions in one workspace', async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'bridge-lark-frontends-')));
  const workspace = join(root, 'shared-workspace');
  await mkdir(workspace);
  const binary = join(root, process.platform === 'win32' ? 'fake-claude.cmd' : 'fake-claude');
  const script = process.platform === 'win32' ? join(root, 'fake-claude.cjs') : binary;
  // The child reads the projection and mock OAuth store just as a CLI tool
  // would; no real Lark credentials, agent service or network is involved.
  await writeFile(script, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
if (process.argv.includes('--version')) { console.log('claude 99.0.0'); process.exit(0); }
const input = readline.createInterface({ input: process.stdin });
input.once('line', line => {
  const message = JSON.parse(line);
  const profile = process.env.LARK_CHANNEL_PROFILE;
  const app = JSON.parse(fs.readFileSync(process.env.LARK_CHANNEL_CONFIG, 'utf8')).accounts.app;
  const oauth = fs.readFileSync(path.join(process.env.LARKSUITE_CLI_CONFIG_DIR, 'mock-user-token'), 'utf8');
  const systemIndex = process.argv.indexOf('--append-system-prompt-file');
  const context = fs.readFileSync(process.argv[systemIndex + 1], 'utf8');
  fs.writeFileSync(path.join(process.env.LARKSUITE_CLI_CONFIG_DIR, 'observed.json'), JSON.stringify({ profile, appId: app.id, oauth, context, cwd: process.cwd() }));
  setTimeout(() => {
    console.log(JSON.stringify({ type: 'result', subtype: 'success', result: profile, session_id: 'session-' + profile, user_message_uuids: [message.uuid] }));
    process.exit(0);
  }, 30);
});
`);
  if (process.platform === 'win32') await writeFile(binary, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
  await chmod(binary, 0o700);
  const profile = (name: string) => {
    const config = createDefaultProfileConfig({ agentKind: 'claude',
      accounts: { app: { id: `cli_${name}`, secret: `fake-${name}`, tenant: 'feishu' } },
      // A shared launch configuration must not pin both apps to frontend a.
      claude: { binaryPath: binary, env: { LARK_CHANNEL_PROFILE: 'stale-launch', LARKSUITE_CLI_CONFIG_DIR: '/stale-launch' } },
    });
    config.workspaces.default = workspace;
    return config;
  };
  const config = createRootConfig('a', profile('a'));
  config.profiles.b = profile('b');
  const configPath = join(root, 'config.toml');
  await saveRootConfig(config, configPath);
  vi.stubEnv('LARK_CHANNEL_PROFILE', 'parent-frontend');
  vi.stubEnv('LARKSUITE_CLI_CONFIG_DIR', '/parent-frontend');
  const channels = new Map<string, StartChannelDeps>();
  supervisor = new Supervisor({ configPath, rootDir: root, runPreflight: false,
    startChannelFn: async deps => {
      if (!('execution' in deps)) throw new Error('expected a profile execution controller');
      const name = deps.controls.profile!;
      const paths = resolveAppPaths({ rootDir: root, profile: name });
      await writeLarkCliSourceProjection(deps.cfg, paths);
      await mkdir(paths.larkCliConfigDir, { recursive: true });
      await writeFile(join(paths.larkCliConfigDir, 'mock-user-token'), `oauth-${name}`);
      channels.set(name, deps);
      return { channel: { botIdentity: { openId: `ou_${name}`, name } } as never, disconnect: async () => {} };
    },
  });
  await supervisor.startProfile('a');
  await supervisor.startProfile('b');
  const run = async (name: string) => {
    const deps = channels.get(name)!;
    deps.sessions.set('same-chat:thread', `session-${name}`, workspace);
    const prepared = await deps.execution.get('same-chat:thread').prepareRun({
      runId: name, prompt: 'read frontend identity', cwd: workspace,
    });
    const running = prepared.start();
    const events = [];
    for await (const event of running.events) events.push(event);
    expect(await running.waitForExit(2000)).toBe(true);
    expect(events).toContainEqual(expect.objectContaining({ type: 'done', terminationReason: 'normal' }));
    const observed = JSON.parse(await readFile(join(root, 'profiles', name, 'lark-cli', 'observed.json'), 'utf8'));
    expect(observed).toMatchObject({ profile: name, appId: `cli_${name}`, oauth: `oauth-${name}`, cwd: workspace });
    expect(observed.context).toContain(`profile ${JSON.stringify(name)}`);
  };
  await Promise.all([run('a'), run('b')]);
  expect(channels.get('a')!.sessions.resumeFor('same-chat:thread', workspace)).toBe('session-a');
  expect(channels.get('b')!.sessions.resumeFor('same-chat:thread', workspace)).toBe('session-b');
  expect(process.env.LARK_CHANNEL_PROFILE).toBe('parent-frontend');
  await supervisor.stopProfile('a');
  expect(supervisor.isOnline('b')).toBe(true);
  await run('b');
});
