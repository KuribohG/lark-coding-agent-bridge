import { mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { piHostSpawnCommand, piSdkSandbox } from '../../../src/agent/pi-sdk/sandbox';
import { DEFAULT_EXEC_SANDBOX } from '../../../src/platform/exec-sandbox';

// The shared SDK host gets one Landlock domain for the whole profile, applied
// when the host process starts: the only place a domain can be applied, since
// a running process cannot widen or lift it.

const args = ['/pkg/bin/pi-host.mjs', '--sdk', '/pkg/pi/dist/index.js', '--agent-dir', '/state/pi'];
const env = { HOME: '/home/u', TMPDIR: '/tmp', PI_CODING_AGENT_DIR: '/state/pi' };
// The launcher check is "does this file exist"; a stand-in keeps the test off
// the compiled binary.
const launcher = join(mkdtempSync(join(tmpdir(), 'pi-sdk-sandbox-')), 'landlock-exec');
writeFileSync(launcher, '#!/bin/sh\n');

describe('pi SDK host sandbox roots', () => {
  it('covers the bridge workspaces, agent homes and the profile default workspace', () => {
    const sandbox = piSdkSandbox({
      agentKind: 'pi',
      state: { bridgeRoot: '/opt/bridge' },
      execSandbox: { ...DEFAULT_EXEC_SANDBOX, enabled: true, readWrite: ['/data/artifacts'] },
    }, { profileDir: '/opt/bridge/profiles/p', env: {} });
    expect(sandbox.settings.enabled).toBe(true);
    expect(sandbox.roots).toEqual([
      '/opt/bridge-workspaces',
      '/opt/bridge/agents',
      '/opt/bridge-workspaces/pi/default',
    ]);
  });

  it('honours an explicit workspace root and agent home root from [state]', () => {
    const sandbox = piSdkSandbox({
      agentKind: 'pi',
      state: { workspaceRoot: '~/ws', agentHomeRoot: '/srv/agents' },
      execSandbox: { ...DEFAULT_EXEC_SANDBOX, enabled: true },
    }, { profileDir: '/state/p', env: {} });
    expect(sandbox.roots).toEqual([join(homedir(), 'ws'), '/srv/agents', join(homedir(), 'ws', 'pi', 'default')]);
  });

  it('has no roots when the profile was built without [state]', () => {
    const sandbox = piSdkSandbox({
      agentKind: 'pi',
      execSandbox: { ...DEFAULT_EXEC_SANDBOX, enabled: true },
    }, { profileDir: '/state/p', env: {} });
    expect(sandbox.roots).toEqual([]);
  });
});

describe.skipIf(process.platform !== 'linux')('pi host sandbox', () => {
  it('leaves the host command untouched when the profile has no sandbox', () => {
    expect(piHostSpawnCommand('/node/bin/node', args, undefined, env))
      .toEqual({ command: '/node/bin/node', args, sandboxed: false });
    expect(piHostSpawnCommand('/node/bin/node', args, { settings: { ...DEFAULT_EXEC_SANDBOX, enabled: false }, roots: [] }, env))
      .toEqual({ command: '/node/bin/node', args, sandboxed: false });
  });

  it('wraps the host in the launcher with the profile roots before the command', () => {
    const command = piHostSpawnCommand('/node/bin/node', args, {
      settings: { ...DEFAULT_EXEC_SANDBOX, enabled: true },
      roots: ['/weka/workspaces', '/weka/agents'],
      launcher,
    }, env);

    expect(command.sandboxed).toBe(true);
    expect(command.command).toBe(launcher);
    const separator = command.args.indexOf('--');
    expect(separator).toBeGreaterThan(0);
    expect(command.args.slice(separator + 1)).toEqual(['/node/bin/node', ...args]);
    expect(command.args.slice(0, separator)).toEqual(expect.arrayContaining([
      '--ro', '/', '--rw', '/weka/workspaces', '--rw', '/weka/agents', '--rw', '/state/pi', '--rw', '/tmp',
    ]));
  });

  it('carries the tcp rule and the strict requirement through to the launcher', () => {
    const command = piHostSpawnCommand('/node/bin/node', args, {
      settings: { ...DEFAULT_EXEC_SANDBOX, enabled: true, allowTcp: false, requireLandlock: true },
      roots: [],
      launcher,
    }, env);

    expect(command.args).toContain('--no-tcp');
    expect(command.args).toContain('--require');
  });

  it('refuses to start unsandboxed when the profile requires Landlock', () => {
    expect(() => piHostSpawnCommand('/node/bin/node', args, {
      settings: { ...DEFAULT_EXEC_SANDBOX, enabled: true, requireLandlock: true },
      roots: [],
      launcher: '/definitely/missing/landlock-exec',
    }, env)).toThrow(/required but unavailable/);
  });

  it('falls back to an unwrapped host when the launcher is missing and it is not required', () => {
    expect(piHostSpawnCommand('/node/bin/node', args, {
      settings: { ...DEFAULT_EXEC_SANDBOX, enabled: true },
      roots: [],
      launcher: '/definitely/missing/landlock-exec',
    }, env)).toEqual({ command: '/node/bin/node', args, sandboxed: false });
  });
});
