import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import {
  createRootConfig,
  loadRootConfig,
  saveRootConfig,
} from '../../../src/config/profile-store';
import { Supervisor } from '../../../src/runtime/supervisor';
import { resolveAppPaths } from '../../../src/config/app-paths';
import { acquireAppRuntimeLock } from '../../../src/runtime/locks';
import { readRegistry } from '../../../src/runtime/registry';
import { fakeChannelControls } from '../../helpers/channel-controls';

// CI hosts have no agent CLIs installed; treat every binary as present.
vi.mock('../../../src/agent/preflight', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../src/agent/preflight')>(),
  checkAgentAvailability: vi.fn(async () => ({ ok: true as const })),
}));

const roots: string[] = [];
const started: string[] = [];
const disconnected: string[] = [];
const pendingLifecycle: string[] = [];
const restorePendingArgs: Array<boolean | undefined> = [];
const executions = new Map<string, import('../../../src/runtime/execution-controller').ProfileExecutionController>();
let root: string;
let sup: Supervisor;
const quietActivity = { runs: 0, turns: 0, queuedMessages: 0, sideQuestions: 0, workflowScripts: 0, workflowTasks: 0, newRunsPaused: false };
let activity = { ...quietActivity };

function app(id: string) {
  return { id, secret: '${APP_SECRET}', tenant: 'feishu' as const };
}

// Stub startChannel — no network, records lifecycle, returns a minimal bridge.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const stubStartChannel: any = async (deps: any) => {
  executions.set(deps.appPaths.profile, deps.execution);
  started.push(deps.appPaths.profile);
  restorePendingArgs.push(deps.restorePending);
  deps.controls.channel = fakeChannelControls({
    pausePendingInput: () => { pendingLifecycle.push(`pause:${deps.appPaths.profile}`); },
    flushPendingInput: async () => {
      pendingLifecycle.push(`flush:${deps.appPaths.profile}`);
    },
    detachPendingInput: () => { pendingLifecycle.push(`detach:${deps.appPaths.profile}`); },
    reloadPendingInput: async () => {
      pendingLifecycle.push(`reload:${deps.appPaths.profile}`);
    },
    resumePendingInput: () => { pendingLifecycle.push(`resume:${deps.appPaths.profile}`); },
  });
  return {
    channel: { botIdentity: { name: `bot-${deps.appPaths.profile}` } },
    activity: () => activity,
    disconnect: async () => {
      disconnected.push(deps.appPaths.profile);
    },
  };
};

beforeEach(async () => {
  started.length = 0;
  disconnected.length = 0;
  pendingLifecycle.length = 0;
  restorePendingArgs.length = 0;
  activity = { ...quietActivity };
  executions.clear();
  root = await mkdtemp(join(tmpdir(), 'bridge-sup-'));
  roots.push(root);
  const configPath = join(root, 'config.json');

  // claude (cli_a), work (cli_b), dup (cli_b — same app as work).
  await mkdir(join(root, 'profiles', 'claude'), { recursive: true });
  await saveRootConfig(
    createRootConfig('claude', createDefaultProfileConfig({ agentKind: 'claude', accounts: { app: app('cli_a') } })),
    configPath,
  );
  const rc = (await loadRootConfig(configPath))!;
  for (const [name, id] of [['work', 'cli_b'], ['dup', 'cli_b']] as const) {
    await mkdir(join(root, 'profiles', name), { recursive: true });
    rc.profiles[name] = createDefaultProfileConfig({ agentKind: 'claude', accounts: { app: app(id) } });
  }
  await saveRootConfig(rc, configPath);

  sup = new Supervisor({ configPath, rootDir: root, runPreflight: false, startChannelFn: stubStartChannel });
});

afterEach(async () => {
  await sup.shutdown();
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

describe('Supervisor', () => {
  it('starts a profile in-process and lists it online', async () => {
    await sup.startProfile('claude');
    expect(sup.isOnline('claude')).toBe(true);
    expect(started).toContain('claude');
    const list = sup.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ profile: 'claude', online: true, pid: process.pid, botName: 'bot-claude' });
  });

  it('publishes channel activity to the process registry as it changes', async () => {
    await sup.startProfile('claude');
    const registryFile = resolveAppPaths({ rootDir: root, profile: 'claude' }).userRegistryFile;
    const published = () => readRegistry(registryFile).find(entry => entry.profileName === 'claude');
    expect(published()).toMatchObject({ activity: quietActivity, activityAt: expect.any(String) });

    activity = { ...quietActivity, turns: 1, queuedMessages: 2 };
    await vi.waitFor(() => expect(published()?.activity).toEqual(activity), { timeout: 5_000 });
  });

  it('hosts multiple profiles at once', async () => {
    await sup.startProfile('claude');
    await sup.startProfile('work');
    expect(sup.list().map((s) => s.profile).sort()).toEqual(['claude', 'work']);
  });

  it('stops one profile without affecting others or the process', async () => {
    await sup.startProfile('claude');
    await sup.startProfile('work');
    await sup.stopProfile('claude');
    expect(sup.isOnline('claude')).toBe(false);
    expect(disconnected).toContain('claude');
    expect(sup.isOnline('work')).toBe(true); // supervisor + other profile still up
  });

  it('refuses to bring up two profiles sharing one app id', async () => {
    await sup.startProfile('work'); // cli_b
    await expect(sup.startProfile('dup')).rejects.toThrow(/已被 profile/);
    expect(sup.isOnline('dup')).toBe(false);
  });

  it('startProfile is idempotent', async () => {
    await sup.startProfile('claude');
    await sup.startProfile('claude');
    expect(started.filter((p) => p === 'claude')).toHaveLength(1);
  });

  it('releases a frontend profile lock when its app is already connected elsewhere', async () => {
    const lock = await acquireAppRuntimeLock(resolveAppPaths({ rootDir: root, profile: 'external' }), 'cli_b', 'claude');
    try {
      await expect(sup.startProfile('work')).rejects.toMatchObject({ kind: 'app' });
    } finally {
      await lock.release();
    }
    await sup.startProfile('work');
    expect(sup.isOnline('work')).toBe(true);
  });

  it('switches the bot default for DMs and topics without disconnecting or replacing active adapters', async () => {
    // A retired Lark override file must not influence routing, even if corrupt.
    await writeFile(join(root, 'profiles', 'claude', 'scope-execution.json'), 'invalid legacy state');
    await sup.startProfile('claude');
    await sup.startProfile('work');
    const execution = executions.get('claude')!;
    const previous = execution.defaultAgent();
    expect(execution.kindFor('oc_dm')).toBe('claude');
    const controls = sup.controlsFor('claude')!;
    const binDir = join(root, 'bin');
    await mkdir(binDir, { recursive: true });
    const pi = join(binDir, 'pi');
    await writeFile(pi, '#!/bin/sh\necho "pi 0.test"\n', 'utf8');
    await chmod(pi, 0o755);

    const configPath = join(root, 'config.json');
    const next = (await loadRootConfig(configPath))!;
    next.profiles.claude = {
      ...next.profiles.claude!,
      agentKind: 'pi',
      pi: { binaryPath: pi },
    };
    await saveRootConfig(next, configPath);

    await sup.controlsFor('claude')!.switchAgent!();

    expect(disconnected).toEqual([]);
    expect(started.filter((p) => p === 'claude')).toHaveLength(1);
    expect(sup.controlsFor('claude')).toBe(controls);
    expect(controls.profileConfig.agentKind).toBe('pi');
    expect(execution.kindFor('oc_dm')).toBe('pi');
    expect(execution.kindFor('oc_group:omt_topic')).toBe('pi');

    // /agent pins one scope; the others keep following the bot default.
    await execution.setScopeKind('oc_group:omt_topic', 'claude');
    expect(execution.kindFor('oc_group:omt_topic')).toBe('claude');
    expect(execution.kindFor('oc_dm')).toBe('pi');
    expect(JSON.parse(await readFile(join(root, 'profiles', 'claude', 'scope-agents.json'), 'utf8')).scopes)
      .toEqual({ 'oc_group:omt_topic': 'claude' });
    await execution.setScopeKind('oc_group:omt_topic', 'pi');
    expect(execution.kindFor('oc_group:omt_topic')).toBe('pi');
    expect(execution.get('oc_dm', 'claude')).toBe(previous);
    expect(execution.get('oc_dm').id).toBe('pi');
    expect(executions.get('work')!.defaultAgentKind).toBe('claude');
    expect(sup.list()).toContainEqual(expect.objectContaining({ profile: 'claude', agentKind: 'pi', online: true }));
  });

  it('applies hot settings from a hand edit without reconnecting and reports the rest', async () => {
    await sup.startProfile('claude');
    const controls = sup.controlsFor('claude')!;
    const configPath = join(root, 'config.json');
    const next = (await loadRootConfig(configPath))!;
    next.profiles.claude = {
      ...next.profiles.claude!,
      preferences: { ...next.profiles.claude!.preferences, maxConcurrentRuns: 7 },
      access: { ...next.profiles.claude!.access, allowedUsers: ['ou_new'] },
      accounts: { app: app('cli_z') },
    };
    await saveRootConfig(next, configPath);

    const report = await controls.applyConfig!('command', { force: true });

    expect(disconnected).toEqual([]);
    expect(controls.profileConfig.preferences.maxConcurrentRuns).toBe(7);
    expect(controls.profileConfig.access.allowedUsers).toEqual(['ou_new']);
    expect(controls.cfg.accounts.app.id).toBe('cli_a');
    expect(report.applied).toEqual(expect.arrayContaining(['preferences.maxConcurrentRuns', 'access.allowedUsers']));
    expect(report.pending.map((c) => [c.label, c.apply])).toEqual([['accounts.app.id', 'reconnect']]);
    expect(controls.configStatus).toBe(report);
  });

  it('keeps running on the last good config when the file becomes invalid', async () => {
    await sup.startProfile('claude');
    const controls = sup.controlsFor('claude')!;
    const configPath = join(root, 'config.json');
    await writeFile(configPath, 'version = 3\nnot_a_setting = 1\n');
    const result = await sup.reloadConfig('command');
    expect(result.status).toBe('rejected');
    const report = await controls.applyConfig!('command');
    expect(report.rejected?.message).toContain('not_a_setting');
    expect(controls.cfg.accounts.app.id).toBe('cli_a');
    expect(sup.isOnline('claude')).toBe(true);
  });

  it('reconnects with the running config for recovery and with the file for /reconnect', async () => {
    await sup.startProfile('claude');
    const configPath = join(root, 'config.json');
    const next = (await loadRootConfig(configPath))!;
    next.profiles.claude = { ...next.profiles.claude!, accounts: { app: app('cli_z') } };
    await saveRootConfig(next, configPath);

    await sup.controlsFor('claude')!.restart({ config: 'running' });
    expect(sup.list()[0]).toMatchObject({ profile: 'claude', appId: 'cli_a' });
    expect(sup.controlsFor('claude')!.configStatus?.pending.map((c) => c.label)).toEqual(['accounts.app.id']);

    await sup.controlsFor('claude')!.restart();
    expect(sup.list()[0]).toMatchObject({ profile: 'claude', appId: 'cli_z' });
    expect(sup.controlsFor('claude')!.configStatus?.pending).toEqual([]);
  });

  it('hands pending input from the old channel to the new channel before resuming it', async () => {
    await sup.startProfile('claude');
    await sup.controlsFor('claude')!.restart();

    expect(restorePendingArgs).toEqual([undefined, false]);
    expect(pendingLifecycle).toEqual([
      'pause:claude',
      'flush:claude',
      'detach:claude',
      'reload:claude',
      'resume:claude',
    ]);
  });
});
