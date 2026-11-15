import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_EXEC_SANDBOX,
  buildExecSandboxCommand,
  execSandboxReadOnlyPaths,
  execSandboxWritePaths,
  expandSandboxPath,
  normalizeExecSandbox,
  type ExecSandboxSettings,
} from '../../../src/platform/exec-sandbox';

const settings = (overrides: Partial<ExecSandboxSettings> = {}): ExecSandboxSettings => ({
  ...DEFAULT_EXEC_SANDBOX,
  enabled: true,
  ...overrides,
});

const scratch: string[] = [];
function fakeLauncher(): string {
  const dir = mkdtempSync(join(tmpdir(), 'exec-sandbox-'));
  scratch.push(dir);
  const path = join(dir, 'landlock-exec');
  writeFileSync(path, '');
  return path;
}

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('normalizeExecSandbox', () => {
  it('defaults to disabled when the table is absent', () => {
    expect(normalizeExecSandbox(undefined)).toEqual(DEFAULT_EXEC_SANDBOX);
    expect(normalizeExecSandbox({})).toEqual(DEFAULT_EXEC_SANDBOX);
  });

  it('reads every documented key from the snake_case table', () => {
    expect(normalizeExecSandbox({
      enabled: true,
      require_landlock: true,
      allow_tcp: false,
      read_write: ['/data', '~/out'],
      read_only: ['/srv'],
    })).toEqual({
      enabled: true,
      requireLandlock: true,
      allowTcp: false,
      readWrite: ['/data', '~/out'],
      readOnly: ['/srv'],
    });
  });

  it('rejects malformed tables and relative paths', () => {
    expect(() => normalizeExecSandbox('yes')).toThrow(/expected a table/);
    expect(() => normalizeExecSandbox({ enabled: 'yes' })).toThrow(/enabled: expected boolean/);
    expect(() => normalizeExecSandbox({ read_write: 'out' })).toThrow(/read_write: expected an array/);
    expect(() => normalizeExecSandbox({ read_write: ['relative/path'] })).toThrow(/absolute or ~\//);
  });
});

describe('sandbox path resolution', () => {
  it('expands ~ and $HOME but leaves other paths alone', () => {
    expect(expandSandboxPath('~/x', '/home/u')).toBe('/home/u/x');
    expect(expandSandboxPath('$HOME/x', '/home/u')).toBe('/home/u/x');
    expect(expandSandboxPath('/abs', '/home/u')).toBe('/abs');
  });

  it('writes the run cwd, temp dir, /dev, caches, harness state and config extras', () => {
    const paths = execSandboxWritePaths({
      settings: settings({ readWrite: ['~/artifacts'] }),
      cwd: '/work/chat',
      home: '/home/u',
      tempDir: '/tmp',
      agent: 'claude',
      env: { CLAUDE_CONFIG_DIR: '/state/claude', LARKSUITE_CLI_CONFIG_DIR: '/state/lark-cli' },
    });
    expect(paths).toEqual(expect.arrayContaining([
      '/work/chat', '/tmp', '/dev', '/home/u/.cache', '/state/claude', '/state/lark-cli', '/home/u/artifacts',
    ]));
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('falls back to the harness default state directory', () => {
    expect(execSandboxWritePaths({ settings: settings(), home: '/home/u', tempDir: '/tmp', agent: 'codex', env: {} }))
      .toEqual(expect.arrayContaining(['/home/u/.codex']));
    expect(execSandboxWritePaths({ settings: settings(), home: '/home/u', tempDir: '/tmp', agent: 'claude', env: {} }))
      .toEqual(expect.arrayContaining(['/home/u/.claude']));
  });

  it('always reads / and appends configured read-only roots', () => {
    expect(execSandboxReadOnlyPaths({ settings: settings({ readOnly: ['/srv'] }), home: '/home/u' }))
      .toEqual(['/', '/srv']);
  });
});

describe('buildExecSandboxCommand', () => {
  it('leaves the command untouched when the sandbox is disabled', () => {
    expect(buildExecSandboxCommand('claude', ['-p'], { settings: DEFAULT_EXEC_SANDBOX }))
      .toEqual({ command: 'claude', args: ['-p'], sandboxed: false });
    expect(buildExecSandboxCommand('claude', [], { settings: undefined }))
      .toEqual({ command: 'claude', args: [], sandboxed: false });
  });

  it('wraps the command with the launcher and its rule flags', () => {
    const launcher = fakeLauncher();
    const command = buildExecSandboxCommand('claude', ['-p'], {
      settings: settings({ allowTcp: false, requireLandlock: true, readOnly: ['/srv'] }),
      launcher,
      platform: 'linux',
      cwd: '/work/chat',
      home: '/home/u',
      tempDir: '/tmp',
      agent: 'claude',
      env: { CLAUDE_CONFIG_DIR: '/state/claude' },
    });
    expect(command.sandboxed).toBe(true);
    expect(command.command).toBe(launcher);
    expect(command.args.slice(-3)).toEqual(['--', 'claude', '-p']);
    expect(command.args).toEqual(expect.arrayContaining(['--ro', '/', '--ro', '/srv', '--rw', '/work/chat']));
    expect(command.args).toContain('--no-tcp');
    expect(command.args).toContain('--require');
  });

  it('degrades on non-Linux platforms and when the launcher is missing', () => {
    expect(buildExecSandboxCommand('claude', ['-p'], {
      settings: settings(), launcher: fakeLauncher(), platform: 'darwin',
    })).toEqual({ command: 'claude', args: ['-p'], sandboxed: false });
    expect(buildExecSandboxCommand('claude', ['-p'], {
      settings: settings(), launcher: '/nonexistent/landlock-exec', platform: 'linux',
    })).toEqual({ command: 'claude', args: ['-p'], sandboxed: false });
  });

  it('fails loudly when the sandbox is required but unavailable', () => {
    expect(() => buildExecSandboxCommand('claude', [], {
      settings: settings({ requireLandlock: true }), launcher: '/nonexistent/landlock-exec', platform: 'linux',
    })).toThrow(/required but unavailable/);
  });
});
