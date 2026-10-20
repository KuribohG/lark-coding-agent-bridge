import { describe, expect, it } from 'vitest';
import { batchArgument, batchLiteral } from '../../../src/platform/windows-cmd';
import { buildLauncherCmd } from '../../../src/daemon/schtasks';
import { resolveAppPaths } from '../../../src/config/app-paths';

describe('Windows launcher values', () => {
  it('quotes arguments and preserves percent, bang, Unicode and trailing backslashes', () => {
    expect(batchArgument('C:\\用户 & tools\\%PATH%!\\')).toBe('"C:\\用户 & tools\\%%PATH%%!\\\\"');
    expect(batchLiteral('C:\\用户\\%PATH%!\\')).toBe('C:\\用户\\%%PATH%%!\\');
    const content = buildLauncherCmd({ nodePath: 'C:\\Program Files\\node.exe',
      bridgeEntryPath: 'C:\\bridge\\cli.mjs', envPath: '"C:\\Program Files\\node";C:\\tools', channelHome: 'C:\\用户\\%APPDATA%!',
      profile: 'a&b', runArgs: ['run', '--profile', 'a&b'] });
    expect(content).toContain('setlocal EnableExtensions DisableDelayedExpansion');
    expect(content).toContain('chcp 65001 >nul');
    expect(content).toContain('"--profile" "a&b"');
    expect(content).toContain('set "LARK_CHANNEL_HOME=C:\\用户\\%%APPDATA%%!"');
    expect(content).toContain('set "PATH=C:\\Program Files\\node;C:\\tools"');
  });

  it.each(['"', '\r', '\n', '\0'])('rejects unrepresentable static character %j', char => {
    expect(() => batchLiteral(`a${char}b`)).toThrow('unsupported character');
  });

  it.each(['CON', 'con.txt', 'NUL', 'AUX', 'PRN', 'COM1', 'LPT9.json', 'COM¹', 'profile.'])(
    'rejects a nonportable profile name %s', profile => {
      expect(() => resolveAppPaths({ profile })).toThrow('invalid profile name');
    },
  );
});
