import { encodeFixture } from '../../helpers/config-fixture';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { tryHandleCommand, type CommandContext, type Controls } from '../../../src/commands';
import { createDefaultProfileConfig, type AgentKind, type RootConfig } from '../../../src/config/profile-schema';
import { runtimeProfileConfig } from '../../../src/config/profile-store';
import { resolveRunModelSettings } from '../../../src/runtime/model-settings';
import { ActiveRuns } from '../../../src/runtime/active-runs';
import { ScopeExecutionStore } from '../../../src/session/scope-execution';
import { SessionStore } from '../../../src/session/store';
import { WorkspaceStore } from '../../../src/workspace/store';
import { fakeChannelControls } from '../../helpers/channel-controls';
import { createFakeChannel } from '../../helpers/fake-channel';
import { FakeAgentAdapter } from '../../helpers/fake-agent';
import { createTmpProfile } from '../../helpers/tmp-profile';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map((f) => f())); });

async function harness() {
  const tmp = await createTmpProfile('agent-command-');
  cleanups.push(tmp.cleanup);
  const home = join(tmp.root, 'codex-home');
  await mkdir(home);
  await writeFile(join(home, 'config.toml'), 'model = "provider/base"\nmodel_reasoning_effort = "medium"\n');
  const profile = createDefaultProfileConfig({ agentKind: 'codex',
    accounts: { app: { id: 'app-test', secret: '${TEST_SECRET}', tenant: 'feishu' } },
    codex: { binaryPath: 'codex', codexHome: home },
    access: { admins: ['owner'] },
  });
  const root: RootConfig = { schemaVersion: 2, activeProfile: 'codex', preferences: {}, profiles: { codex: profile } };
  const configPath = join(tmp.root, 'config.toml');
  await writeFile(configPath, encodeFixture(root));

  const store = new ScopeExecutionStore(join(tmp.profile, 'scope-execution.json'));
  const unavailable = new Set<AgentKind>();
  const btwResets: string[] = [];
  const controls: Controls = { profile: 'codex', profileConfig: profile, cfg: runtimeProfileConfig(root, 'codex'),
    configPath, processId: 'test', botOwnerId: 'owner', ownerRefreshState: 'ok',
    async refreshOwner() {}, async restart() {}, async exit() {},
    channel: fakeChannelControls({
      btw: { enqueue: async () => {}, excludes: () => false, reset: scope => { btwResets.push(scope); }, cancel: () => {} },
      scopeAgents: {
        defaultKind: () => 'codex',
        adapter: () => new FakeAgentAdapter(),
        select: async (scope, kind) => {
          if (unavailable.has(kind)) throw new Error(`${kind} is not installed`);
          if (kind === 'codex') await store.clear(scope);
          else await store.set(scope, kind);
        },
      },
    }),
  };
  const channel = createFakeChannel();
  const ctx: CommandContext = {
    controls, agentKind: 'codex', channel: channel as unknown as CommandContext['channel'], scope: 'group:topic-a', chatMode: 'topic',
    msg: { chatId: 'group', messageId: 'msg', senderId: 'owner', threadId: 'topic-a', content: '' } as CommandContext['msg'],
    sessions: new SessionStore(join(tmp.profile, 'sessions.json')), workspaces: new WorkspaceStore(join(tmp.profile, 'workspaces.json')),
    activeRuns: new ActiveRuns(), agent: new FakeAgentAdapter(),
  };
  return { ctx, channel, controls, store, unavailable, btwResets,
    lastReply: () => encodeFixture(channel.sent.at(-1)),
    command: async (text: string) => {
      ctx.agentKind = store.get(ctx.scope) ?? 'codex';
      ctx.followUpPrompt = undefined;
      ctx.msg = { ...ctx.msg, content: text };
      expect(await tryHandleCommand(ctx)).toBe(true);
    } };
}

describe('/agent scope engine', () => {
  it('switches one scope and keeps the choice of other scopes', async () => {
    const h = await harness();
    await h.command('/agent claude');
    expect(h.store.get('group:topic-a')).toBe('claude');
    expect(h.store.get('group:topic-b')).toBeUndefined();
    expect(h.lastReply()).toContain('已切换');
    expect(h.btwResets).toEqual(['group:topic-a']);
    expect(h.ctx.followUpPrompt).toBeUndefined();

    await h.command('/agent');
    expect(h.lastReply()).toContain('单独设置');

    await h.command('/agent default');
    expect(h.store.get('group:topic-a')).toBeUndefined();
    await h.command('/agent');
    expect(h.lastReply()).toContain('跟随全局默认');
  });

  it('saves model and effort for the selected engine and runs the trailing prompt', async () => {
    const h = await harness();
    await h.command('/agent claude custom/fast high 检查这个问题\n第二行');
    expect(h.store.get(h.ctx.scope)).toBe('claude');
    expect(await resolveRunModelSettings(h.controls, h.ctx.scope, undefined, 'claude')).toMatchObject({
      model: 'custom/fast', reasoningEffort: 'high',
    });
    expect((await resolveRunModelSettings(h.controls, h.ctx.scope, undefined, 'codex')).model).toBe('provider/base');
    expect(h.ctx.followUpPrompt).toBe('检查这个问题\n第二行');
    expect(h.lastReply()).toContain('开始执行');

    // Same engine: only the model changes.
    await h.command('/agent claude custom/slow');
    expect((await resolveRunModelSettings(h.controls, h.ctx.scope, undefined, 'claude')).model).toBe('custom/slow');
    expect(h.lastReply()).toContain('继续使用');
    expect(h.btwResets).toHaveLength(1);
  });

  it('leaves the scope unchanged when the model arguments are rejected', async () => {
    const h = await harness();
    await h.command('/agent claude custom/fast not-an-effort 任务');
    expect(h.store.get(h.ctx.scope)).toBeUndefined();
    expect((await resolveRunModelSettings(h.controls, h.ctx.scope, undefined, 'claude')).model).not.toBe('custom/fast');
    expect(h.ctx.followUpPrompt).toBeUndefined();
    expect(h.lastReply()).toContain('未切换');
    expect(h.btwResets).toEqual([]);
  });

  it('rejects unknown or unavailable engines and switches during a run', async () => {
    const h = await harness();
    await h.command('/agent nope');
    expect(h.lastReply()).toContain('未知执行引擎');

    h.unavailable.add('pi');
    await h.command('/agent pi some/model');
    expect(h.lastReply()).toContain('pi is not installed');
    expect(h.store.get(h.ctx.scope)).toBeUndefined();

    h.ctx.activeRuns.get = (() => ({})) as unknown as ActiveRuns['get'];
    await h.command('/agent claude');
    expect(h.lastReply()).toContain('有任务在执行');
    expect(h.store.get(h.ctx.scope)).toBeUndefined();
  });
});
