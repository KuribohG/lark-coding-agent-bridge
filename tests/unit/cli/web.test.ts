import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runWeb, type RunWebOptions } from '../../../src/cli/commands/web';

const mocks = vi.hoisted(() => ({
  connect: vi.fn(async () => ({ url: 'http://127.0.0.1:8787/' })),
  close: vi.fn(async () => {}),
  plugin: vi.fn(options => options),
  availability: vi.fn(async () => ({ ok: true })),
}));

vi.mock('../../../src/channels/plugin', () => ({
  ChannelHost: class {
    connect = mocks.connect;
    close = mocks.close;
  },
}));
vi.mock('../../../src/channels/web/server', () => ({ createWebPlugin: mocks.plugin }));
vi.mock('../../../src/runtime/agent-runtime', () => ({ checkRuntimeAgentAvailability: mocks.availability }));
vi.mock('../../../src/core/logger', () => ({ configureLogger: vi.fn(), closeLogger: vi.fn() }));

const directories: string[] = [];
const shutdowns: Array<() => void> = [];

afterEach(async () => {
  for (const shutdown of shutdowns.splice(0)) shutdown();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function createWorkspace() {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), 'web-cli-')));
  directories.push(workspace);
  return workspace;
}

async function startAndClose(options: RunWebOptions) {
  const signals = vi.spyOn(process, 'on');
  vi.spyOn(console, 'log').mockImplementation(() => {});
  let failure: unknown;
  const running = runWeb(options).catch(error => { failure = error; });
  await vi.waitFor(() => {
    expect(failure).toBeUndefined();
    expect(signals.mock.calls.some(([event]) => event === 'SIGTERM')).toBe(true);
  });
  const shutdown = signals.mock.calls.find(([event]) => event === 'SIGTERM')![1] as () => void;
  shutdowns.push(shutdown);
  shutdown();
  await running;
  expect(mocks.close).toHaveBeenCalledOnce();
  return mocks.plugin.mock.calls[0]![0];
}

describe('standalone Web CLI', () => {
  it.each(['codex', 'pi', 'claude'])('starts %s without a config or binary override', async agent => {
    const workspace = await createWorkspace();
    const options = await startAndClose({ agent, workspace, stateDir: join(workspace, 'state') });
    expect(options.execution.defaultAgent().id).toBe(agent);
    expect(options.config.permissions.defaultAccess).toBe(agent === 'pi' ? 'full' : 'workspace');
    expect(options.configForAgent('codex').codex.binaryPath).toBe('codex');
    expect(options.configForAgent('pi').pi.binaryPath).toBe('pi');
  });

  it('preserves explicit Codex launch settings from TOML', async () => {
    const workspace = await createWorkspace();
    const config = join(workspace, 'config.toml');
    await writeFile(config, 'version = 3\n[agents.codex.launch]\nbinaryPath = "custom-codex"\ninheritCodexHome = false\n');
    const options = await startAndClose({ agent: 'codex', workspace, config, stateDir: join(workspace, 'state') });
    expect(options.config.codex).toMatchObject({ binaryPath: 'custom-codex', inheritCodexHome: false });
  });
});
