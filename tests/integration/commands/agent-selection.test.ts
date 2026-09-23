import { join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SwitchableAgent } from '../../../src/agent/switchable';
import { claudeCapability, codexCapability } from '../../../src/agent/capability';
import { ActiveRuns } from '../../../src/bot/active-runs';
import { PendingQueue } from '../../../src/bot/pending-queue';
import { ProcessPool } from '../../../src/bot/process-pool';
import { recordRunSessionEvent, startRunFlow } from '../../../src/bot/run-flow';
import { runCommandHandler, tryHandleCommand, type CommandContext, type Controls } from '../../../src/commands';
import { saveModelPreferences } from '../../../src/config/config-ops';
import { createDefaultProfileConfig, type AgentKind } from '../../../src/config/profile-schema';
import * as profiles from '../../../src/config/profile-store';
import { pauseAgentSwitch, selectAgent } from '../../../src/runtime/agent-selection';
import { readRunDefaults } from '../../../src/runtime/run-defaults';
import { RunExecutor } from '../../../src/runtime/run-executor';
import { SessionStore } from '../../../src/session/store';
import { SessionCatalog } from '../../../src/session/catalog';
import { WorkspaceStore } from '../../../src/workspace/store';
import { createFakeChannel } from '../../helpers/fake-channel';
import { FakeAgentAdapter } from '../../helpers/fake-agent';
import { createTmpProfile } from '../../helpers/tmp-profile';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(cleanups.splice(0).map(fn => fn()));
});

async function harness() {
  const tmp = await createTmpProfile('agent-selection-');
  cleanups.push(tmp.cleanup);
  const configPath = join(tmp.root, 'config.json');
  const profile = createDefaultProfileConfig({
    agentKind: 'claude', accounts: { app: { id: 'cli_test', secret: '${APP_SECRET}', tenant: 'feishu' } },
    access: { admins: ['ou-admin'] }, preferences: { model: 'private/claude', reasoningEffort: 'high' },
  });
  profile.workspaces.default = tmp.workspace;
  await profiles.saveRootConfig(profiles.createRootConfig('bot', profile), configPath);
  const agents = {
    claude: new FakeAgentAdapter({ id: 'claude', events: Array.from({ length: 5 }, () => [
      { type: 'system' as const, sessionId: 'claude-session' }, { type: 'done' as const, terminationReason: 'normal' as const },
    ]) }),
    codex: new FakeAgentAdapter({ id: 'codex', events: Array.from({ length: 5 }, () => [
      { type: 'system' as const, threadId: 'codex-thread' }, { type: 'done' as const, terminationReason: 'normal' as const },
    ]) }),
  };
  const agent = new SwitchableAgent(agents.claude);
  agent.setBotIdentity({ openId: 'ou-bot', name: 'bot' });
  const activeRuns = new ActiveRuns();
  const pending = new PendingQueue(60_000, () => {});
  cleanups.push(async () => pending.cancelAll());
  const sessions = new SessionStore(join(tmp.root, 'sessions.json'));
  const sessionCatalog = new SessionCatalog(join(tmp.root, 'catalog.json'));
  const workspaces = new WorkspaceStore(join(tmp.root, 'workspaces.json'));
  const channel = createFakeChannel();
  const controls: Controls = {
    cfg: profile, profileConfig: profile, profile: 'bot', configPath, processId: 'test',
    ownerRefreshState: 'ok', refreshOwner: async () => {}, restart: async () => {}, exit: async () => {},
  };
  const prepare = vi.fn(async (p: typeof profile) => agents[p.agentKind]);
  const metadata = vi.fn(async (_kind: AgentKind) => {});
  const select = (next: AgentKind, expected = controls.profileConfig.agentKind) => selectAgent(controls, next, expected, {
    pause: () => pauseAgentSwitch(controls, activeRuns, () => pending.hasAnyWork()),
    prepare, metadata, activate: nextAgent => agent.replace(nextAgent),
  });
  controls.switchAgent = select;
  const executor = new RunExecutor({ agent, activeRuns, pool: new ProcessPool(() => 2) });
  const context = (content: string, senderId = 'ou-admin', scope = 'chat:topic'): CommandContext => ({
    msg: { messageId: 'om-test', chatId: 'chat', threadId: 'topic', chatType: 'group', senderId, content } as CommandContext['msg'],
    channel: channel as unknown as CommandContext['channel'], scope, chatMode: 'topic',
    agent, activeRuns, sessions, sessionCatalog, workspaces, controls,
  });
  async function run(scope = 'chat:topic') {
    const capability = controls.profileConfig.agentKind === 'claude' ? claudeCapability(controls.profileConfig) : codexCapability(controls.profileConfig);
    const flow = await startRunFlow({
      scopeId: scope, scope: { source: 'im', chatId: 'chat', actorId: 'ou-admin' },
      prompt: 'hello', attachments: [], access: { ok: true, reason: 'allowed-user' },
      capability, profileConfig: controls.profileConfig, sessions, sessionCatalog, workspaces, executor, now: Date.now(),
    });
    if (!flow.ok) throw new Error(flow.rejectReason.userVisible);
    for await (const event of flow.execution.subscribe()) recordRunSessionEvent({ scopeId: scope, sessions, sessionCatalog, capability, policy: flow.policy, event });
    await flow.execution.result;
    await Promise.all([sessions.flush(), sessionCatalog.flush()]);
    return agents[controls.profileConfig.agentKind].runOptions.at(-1)!;
  }
  return { tmp, controls, agents, agent, activeRuns, pending, sessions, prepare, metadata, select, context, run, configPath, channel };
}

describe('global agent selection', () => {
  it('switches every scope, restores separate sessions/models, and persists after reload', async () => {
    const h = await harness();
    expect((await h.run()).sessionId).toBeUndefined();
    await tryHandleCommand(h.context('/agent codex'));
    expect(h.agent.id).toBe('codex');
    expect(h.controls.cfg.preferences?.model).toBeUndefined();
    expect(h.agents.codex.botIdentity?.openId).toBe('ou-bot');
    expect(await h.run()).toMatchObject({ agentId: 'codex', sessionId: undefined, threadId: undefined });
    expect((await h.run('other-chat')).agentId).toBe('codex');
    await saveModelPreferences(h.controls, { model: 'private/codex', reasoningEffort: 'ultra' });
    await h.select('claude');
    expect(h.controls.cfg.preferences).toMatchObject({ model: 'private/claude', reasoningEffort: 'high' });
    expect((await h.run()).sessionId).toBe('claude-session');
    await h.select('codex');
    expect((await h.run()).threadId).toBe('codex-thread');
    const persisted = (await profiles.loadRootConfig(h.configPath))!.profiles.bot!;
    expect(persisted.agentKind).toBe('codex');
    expect(persisted.preferences).toMatchObject({ model: 'private/codex', reasoningEffort: 'ultra' });
    expect(persisted.accounts).toEqual(h.controls.profileConfig.accounts);
  });

  it('denies non-admin commands and card callbacks, and rejects stale cards', async () => {
    const h = await harness();
    await tryHandleCommand(h.context('/agent codex', 'ou-other'));
    await runCommandHandler('agent', 'codex claude', h.context('', 'ou-other'));
    expect(h.prepare).not.toHaveBeenCalled();
    await runCommandHandler('agent', 'codex claude', h.context(''));
    expect(h.agent.id).toBe('codex');
    await runCommandHandler('agent', 'claude claude', h.context(''));
    expect(h.agent.id).toBe('codex');
    expect(JSON.stringify(h.channel.sent)).toContain('执行引擎已改变');
    expect(h.channel.sent.at(-1)?.options).toMatchObject({ replyTo: 'om-test', replyInThread: true });
  });

  it('refuses both process reservations and pending messages without cancelling them', async () => {
    const h = await harness();
    const release = h.activeRuns.reserve('other-chat')!;
    await expect(h.select('codex')).rejects.toThrow('排队');
    release();
    h.pending.push('other-chat', h.context('queued').msg);
    await expect(h.select('codex')).rejects.toThrow('排队');
    expect(h.pending.hasWork('other-chat')).toBe(true);
    expect(h.prepare).not.toHaveBeenCalled();
  });

  it('keeps old engine/config and releases intake after unavailable target or failed save', async () => {
    const h = await harness();
    const original = await readFile(h.configPath, 'utf8');
    h.prepare.mockRejectedValueOnce(new Error('CLI unavailable'));
    await expect(h.select('codex')).rejects.toThrow('unavailable');
    expect(h.metadata).not.toHaveBeenCalled();
    const save = vi.spyOn(profiles, 'saveRootConfig').mockRejectedValueOnce(new Error('disk full'));
    await expect(h.select('codex')).rejects.toThrow('disk full');
    save.mockRestore();
    expect(await readFile(h.configPath, 'utf8')).toBe(original);
    expect(h.metadata.mock.calls.map(call => call[0])).toEqual(['codex', 'claude']);
    expect(h.agent.id).toBe('claude');
    expect(h.controls.agentSwitching).toBe(false);
    expect(h.activeRuns.newRunsPaused()).toBe(false);
  });

  it('rejects concurrent switches and preserves concurrent unrelated config writes', async () => {
    const h = await harness();
    const edit = profiles.withConfigFileLock(h.configPath, async () => {
      const root = (await profiles.loadRootConfig(h.configPath))!;
      root.profiles.bot!.preferences.maxConcurrentRuns = 9;
      await profiles.saveRootConfig(root, h.configPath);
    });
    const selecting = h.select('codex');
    await expect(h.select('codex')).rejects.toThrow('切换');
    await Promise.all([edit, selecting]);
    expect(h.controls.profileConfig.preferences.maxConcurrentRuns).toBe(9);
    await expect(saveModelPreferences(h.controls, { model: 'old-form' }, 'claude')).rejects.toThrow('已改变');
  });

  it('keeps legacy timed-run defaults with their original engine', async () => {
    const h = await harness();
    const dir = join(h.tmp.root, 'profiles', 'bot');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'run-defaults.json'), JSON.stringify({ until: '2h', timeZone: 'Asia/Shanghai', marginMinutes: 5, model: 'private/claude', reasoningEffort: 'high' }));
    await h.select('codex');
    expect((await readRunDefaults(h.controls)).model).toBeUndefined();
    await h.select('claude');
    expect((await readRunDefaults(h.controls)).model).toBe('private/claude');
  });

  it('rejects work prepared for the previous engine at the executable boundary', async () => {
    const h = await harness();
    await h.select('codex');
    expect(() => h.agent.run({ agentId: 'claude', runId: 'stale', prompt: 'hello', sessionId: 'claude-session' })).toThrow('已改变');
    expect(h.agents.codex.runs).toHaveLength(0);
  });
});
