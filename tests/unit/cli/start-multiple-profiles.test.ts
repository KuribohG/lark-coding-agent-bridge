import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolve: vi.fn(), start: vi.fn(), shutdown: vi.fn(), constructor: vi.fn(),
}));
vi.mock('../../../src/runtime/profile-runtime', () => ({ resolveProfileRuntime: mocks.resolve }));
vi.mock('../../../src/runtime/supervisor', () => ({ Supervisor: class {
  constructor(options: unknown) { mocks.constructor(options); }
  startProfile = mocks.start;
  shutdown = mocks.shutdown;
  watchConfig = () => () => {};
  reloadConfig = vi.fn();
} }));
vi.mock('../../../src/plugins/defaults', () => ({ createBuiltinPlugins: () => undefined }));
vi.mock('../../../src/core/logger', () => ({ configureLogger: vi.fn(), gcOldLogs: vi.fn(), log: { fail: vi.fn(), warn: vi.fn() }, reportError: vi.fn() }));

import { runStart } from '../../../src/cli/commands/start';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolve.mockImplementation(async ({ profile }) => ({
    profile, configPath: '/bridge/config.toml', cfg: { accounts: { app: { id: `cli_${profile}` } } },
    appPaths: { rootDir: '/bridge', hostLogsDir: '/bridge/logs' },
  }));
  mocks.start.mockResolvedValue(undefined);
  mocks.shutdown.mockResolvedValue(undefined);
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('headless multiple Lark profiles', () => {
  it.each([
    { profiles: [] }, { profiles: ['a', 'a'] }, { profiles: ['a'], profile: 'b' },
    { profiles: ['a'], webUi: true }, { profiles: ['a'], appId: 'cli_new' },
    { profiles: ['a'], workspace: '/new-workspace' },
  ])('rejects ambiguous selections before startup: %j', async options => {
    await expect(runStart(options)).rejects.toThrow('--profiles');
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it('validates all selected profiles before connecting either app', async () => {
    mocks.resolve.mockRejectedValueOnce(new Error('unknown profile'));
    await expect(runStart({ profiles: ['missing', 'b'] })).rejects.toThrow('unknown profile');
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it('rejects two profiles pointing at the same app', async () => {
    mocks.resolve.mockResolvedValue({ cfg: { accounts: { app: { id: 'cli_same' } } } });
    await expect(runStart({ profiles: ['a', 'b'] })).rejects.toThrow('distinct Lark app IDs');
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it('rolls back the first frontend if the second cannot start', async () => {
    mocks.start.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('bind failed'));
    await expect(runStart({ config: '/bridge/config.toml', profiles: ['a', 'b'] })).rejects.toThrow('bind failed');
    expect(mocks.start.mock.calls).toEqual([['a'], ['b']]);
    expect(mocks.resolve.mock.calls.map(([options]) => options)).toEqual([
      { config: '/bridge/config.toml', profile: 'a', allowBootstrap: false },
      { config: '/bridge/config.toml', profile: 'b', allowBootstrap: false },
    ]);
    expect(mocks.shutdown).toHaveBeenCalledOnce();
  });

  it('hosts both frontends until one shutdown signal closes the supervisor', async () => {
    const on = vi.spyOn(process, 'on').mockReturnValue(process);
    vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    void runStart({ profiles: ['a', 'b'], skipCheckLarkCli: true });
    await vi.waitFor(() => expect(on.mock.calls.some(([signal]) => signal === 'SIGTERM')).toBe(true));
    expect(mocks.start.mock.calls).toEqual([['a'], ['b']]);
    expect(mocks.constructor).toHaveBeenCalledWith(expect.objectContaining({ skipCheckLarkCli: true }));
    const signalHandler = on.mock.calls.find(([signal]) => signal === 'SIGTERM')![1];
    signalHandler();
    await vi.waitFor(() => expect(mocks.shutdown).toHaveBeenCalledOnce());
  });
});
