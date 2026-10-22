import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readStatus } from '../../../src/daemon/systemd.js';

vi.mock('node:child_process', () => ({ spawnSync: vi.fn() }));
const spawn = vi.mocked(spawnSync);

afterEach(() => vi.resetAllMocks());

describe('systemd structured status', () => {
  it('reads stable machine properties instead of localized status text', () => {
    spawn.mockReturnValue({
      status: 0,
      stdout: 'ActiveState=active\nMainPID=12345\nExecMainStatus=0\n',
      stderr: '',
      error: undefined,
    } as ReturnType<typeof spawnSync>);

    expect(readStatus('work')).toEqual({
      activeState: 'active',
      mainPid: 12345,
      lastExit: 0,
    });
    expect(spawn).toHaveBeenCalledWith(
      'systemctl',
      ['--user', 'show', 'lark-channel-bridge.bot.work.service', '--no-pager',
        '--property=ActiveState,MainPID,ExecMainStatus'],
      { encoding: 'utf8' },
    );
  });
});
