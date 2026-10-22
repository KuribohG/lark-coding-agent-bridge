import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  describeTask,
  installTask,
  isTaskRunning,
  restartTask,
  waitUntilStopped,
} from '../../../src/daemon/schtasks';
import { paths } from '../../../src/config/paths';
import { createTmpProfile } from '../../helpers/tmp-profile';

vi.mock('node:child_process', () => ({ spawnSync: vi.fn() }));
const spawn = vi.mocked(spawnSync);
const result = (stdout: string, status = 0) => ({ status, stdout, stderr: '', error: undefined }) as ReturnType<typeof spawnSync>;
afterEach(() => { vi.resetAllMocks(); vi.useRealTimers(); });

describe('Windows scheduled task state', () => {
  it.each([['4', true], ['2', true], ['3', false], ['1', false]] as const)(
    'reads language-independent TASK_STATE %s', (state, running) => {
      spawn.mockReturnValue(result(`${state}\r\n`));
      expect(isTaskRunning('中文助手')).toBe(running);
      const [command, args] = spawn.mock.calls[0]!;
      expect(command).toBe('powershell.exe');
      const script = Buffer.from((args as string[]).at(-1)!, 'base64').toString('utf16le');
      expect(script).toContain("New-Object -ComObject 'Schedule.Service'");
      expect(script).toContain("GetFolder('\\')");
      expect(script).toContain("$name = 'LarkChannelBridge.Bot.");
      expect(script).toContain('.State');
    },
  );

  it.each(['', '0', 'Status: Running', '状态: 正在运行'])('does not treat unknown state %j as stopped', async state => {
    spawn.mockReturnValue(result(state));
    expect(() => isTaskRunning('claude')).toThrow('cannot query');
    await expect(waitUntilStopped('claude')).rejects.toThrow('cannot query');
  });

  it('surfaces a failed state query', () => {
    spawn.mockReturnValue({ ...result('', 1), stderr: 'access denied' });
    expect(() => isTaskRunning('claude')).toThrow('access denied');
  });

  it('reads PID and last result through language-independent COM fields', () => {
    spawn.mockReturnValue(result('STATE=4\r\nPID=12345\r\nLAST_RESULT=3221225786\r\nLAST_RUN_TIME=2026-10-22T12:00:00.0000000+08:00\r\n'));

    expect(describeTask('中文助手')).toContain('PID=12345');
    const [command, args] = spawn.mock.calls[0]!;
    expect(command).toBe('powershell.exe');
    const script = Buffer.from((args as string[]).at(-1)!, 'base64').toString('utf16le');
    expect(script).toContain('GetInstances(0)');
    expect(script).toContain('EnginePID');
    expect(script).toContain('LastTaskResult');
    expect(script).not.toContain('schtasks /Query');
  });

  it('allows first installation when the task does not exist yet', () => {
    spawn.mockReturnValue(result('missing\r\n'));
    expect(isTaskRunning('claude')).toBe(false);
  });

  it('does not start a replacement when the old task fails to stop', async () => {
    vi.useFakeTimers();
    spawn.mockImplementation(command => result(command === 'schtasks' ? '' : '4'));
    const restarted = restartTask('claude');
    await vi.advanceTimersByTimeAsync(5100);
    expect(await restarted).toMatchObject({ ok: false, stderr: expect.stringContaining('did not stop') });
    expect(spawn.mock.calls.some(([, args]) => (args as string[]).includes('/Run'))).toBe(false);
  });

  it.each([0, 1])('applies daemon settings before reporting installation success (status=%s)', async status => {
    const tmp = await createTmpProfile('task-install-');
    const previous = { rootDir: paths.rootDir, appDir: paths.appDir };
    Object.assign(paths, { rootDir: tmp.root, appDir: tmp.root });
    try {
      spawn.mockReturnValueOnce(result('created')).mockReturnValueOnce(result('', status));
      expect((await installTask('test')).ok).toBe(status === 0);
      const script = Buffer.from((spawn.mock.calls[1]![1] as string[]).at(-1)!, 'base64').toString('utf16le');
      expect(script).toContain("$name = 'LarkChannelBridge.Bot.test'");
      expect(script).toContain("ExecutionTimeLimit = 'PT0S'");
      expect(script).toContain('DisallowStartIfOnBatteries = $false');
      expect(script).toContain('StopIfGoingOnBatteries = $false');
      expect(script).toContain('RegisterTaskDefinition');
      expect(spawn.mock.calls.some(([, args]) => (args as string[]).includes('/Run'))).toBe(false);
    } finally { Object.assign(paths, previous); await tmp.cleanup(); }
  });
});
