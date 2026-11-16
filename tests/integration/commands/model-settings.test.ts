import { encodeFixture, decodeFixture } from '../../helpers/config-fixture';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { tryHandleCommand, runCommandHandler, type CommandContext, type Controls } from '../../../src/commands';
import { intakeMessage } from '../../../src/channels/lark/intake';
import { createDefaultProfileConfig, type RootConfig } from '../../../src/config/profile-schema';
import { runtimeProfileConfig } from '../../../src/config/profile-store';
import { resolveRunModelSettings, scopePreferences } from '../../../src/runtime/model-settings';
import { ActiveRuns } from '../../../src/runtime/active-runs';
import { ProcessPool } from '../../../src/runtime/process-pool';
import { RunExecutor } from '../../../src/runtime/run-executor';
import { modelRunArguments } from '../../../src/agent/model-settings';
import { handleCardAction } from '../../../src/channels/lark/card-actions';
import { ChatModeCache } from '../../../src/channels/lark/chat-mode-cache';
import { PendingQueue } from '../../../src/channels/lark/pending-queue';
import type { CardActionEvent, NormalizedMessage } from '@larksuite/channel';
import { SessionStore } from '../../../src/session/store';
import { WorkspaceStore } from '../../../src/workspace/store';
import { ScopePreferencesStore } from '../../../src/session/scope-preferences';
import { createFakeChannel } from '../../helpers/fake-channel';
import { FakeAgentAdapter } from '../../helpers/fake-agent';
import { createTmpProfile } from '../../helpers/tmp-profile';
import { fakeCommandChannel } from '../../helpers/fake-command-channel';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map((f) => f())); });

async function harness() {
  const tmp = await createTmpProfile('model-settings-');
  cleanups.push(tmp.cleanup);
  const home = join(tmp.root, 'codex-home');
  await mkdir(home);
  await writeFile(join(home, 'config.toml'), 'model = "provider/base"\nmodel_reasoning_effort = "medium"\n');
  await writeFile(join(home, 'models_cache.json'), encodeFixture({ models: [
    { slug: 'provider/base', supported_reasoning_levels: [{ effort: 'medium' }, { effort: 'high' }], default_reasoning_level: 'medium' },
    { slug: 'provider/restricted', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }], default_reasoning_level: 'high' },
  ] }));
  const profile = createDefaultProfileConfig({ agentKind: 'codex',
    accounts: { app: { id: 'app-test', secret: '${TEST_SECRET}', tenant: 'feishu' } },
    codex: { binaryPath: 'codex', codexHome: home },
    access: { admins: ['owner'] },
  });
  const root: RootConfig = { schemaVersion: 2, activeProfile: 'codex', preferences: {},
    profiles: { codex: profile, other: structuredClone(profile) } };
  const configPath = join(tmp.root, 'config.toml');
  await writeFile(configPath, encodeFixture(root));
  const controls: Controls = { profile: 'codex', profileConfig: profile, cfg: runtimeProfileConfig(root, 'codex'),
    configPath, processId: 'test', botOwnerId: 'owner', ownerRefreshState: 'ok',
    async refreshOwner() {}, async restart() {}, async exit() {},
  };
  const channel = createFakeChannel();
  const ctx: CommandContext = {
    controls, agentKind: controls.profileConfig.agentKind, channel: fakeCommandChannel(channel), scope: 'group:topic-a', chatMode: 'topic',
    msg: { chatId: 'group', messageId: 'msg', senderId: 'owner', threadId: 'topic-a', content: '' } as CommandContext['msg'],
    sessions: new SessionStore(join(tmp.profile, 'sessions.json')), workspaces: new WorkspaceStore(join(tmp.profile, 'workspaces.json')),
    activeRuns: new ActiveRuns(), agent: new FakeAgentAdapter(),
  };
  return { tmp, ctx, channel, controls, command: async (text: string, scope = ctx.scope, sender = 'owner') => {
    ctx.scope = scope;
    ctx.msg = { ...ctx.msg, content: text, senderId: sender };
    expect(await tryHandleCommand(ctx)).toBe(true);
  } };
}

async function larkHarness() {
  const h = await harness();
  Object.assign(h.channel, { botIdentity: { openId: 'ou_self', name: 'Test Bot' } });
  h.controls.cfg = { ...h.controls.cfg, channels: { lark: { progress: 'off' } } } as typeof h.controls.cfg;
  const pending = new PendingQueue(60_000, () => {});
  cleanups.push(async () => { pending.cancel(h.ctx.scope); await pending.flushPersistence(); });
  const message = (patch: Partial<NormalizedMessage>): NormalizedMessage => ({
    ...h.ctx.msg, chatType: 'group', senderType: 'user', createTime: Date.now(), rawContentType: 'post',
    resources: [], mentionAll: false, mentionedBot: true,
    mentions: [{ key: '@_user_1', openId: 'ou_self', name: 'Test Bot', isBot: true }],
    ...patch,
  });
  return { ...h, pending, message, intake: async (patch: Partial<NormalizedMessage>) => {
    await intakeMessage({
      followups: {}, channel: h.channel,
      resolveAgent: () => h.ctx.agent, resolveAgentKind: () => 'codex',
      sessions: h.ctx.sessions, workspaces: h.ctx.workspaces, activeRuns: h.ctx.activeRuns,
      pending, msg: message(patch), controls: h.controls,
      chatModeCache: { resolveScope: async () => ({ scope: h.ctx.scope, threadId: 'topic-a', mode: 'topic' }) },
      executor: {}, pool: {}, cotClient: {}, preparedCots: new Map(),
    } as unknown as Parameters<typeof intakeMessage>[0]);
  } };
}

describe('Lark mention-prefixed commands', () => {
  it.each([
    { prefix: '@Test Bot ', rawContentType: 'post' },
    { prefix: '@_user_1 ', rawContentType: 'text' },
    { prefix: '@_user_1', rawContentType: 'text' },
    { prefix: ' \n@Test Bot\t@_user_1 ', rawContentType: 'post' },
  ])('dispatches a command after the receiving bot mention: $prefix', async ({ prefix, rawContentType }) => {
    const h = await larkHarness();
    const prompt = '检查  这个问题\n\t第二行';
    await h.intake({ content: `${prefix}/model custom/fast high ${prompt}`, rawContentType });
    expect(await resolveRunModelSettings(h.controls, h.ctx.scope)).toMatchObject({
      model: 'custom/fast', reasoningEffort: 'high',
    });
    expect(h.pending.cancel(h.ctx.scope).map(message => message.content)).toEqual([prompt]);
  });

  it('submits the task after a model name when effort is omitted', async () => {
    const h = await larkHarness();
    const prompt = '检查  这个问题\n\t第二行';
    await h.intake({ content: `@Test Bot /model custom/fast ${prompt}` });
    expect((await resolveRunModelSettings(h.controls, h.ctx.scope)).model).toBe('custom/fast');
    expect(h.pending.cancel(h.ctx.scope).map(message => message.content)).toEqual([prompt]);
  });

  it.each(['/model custom/fast', '/provider custom/fast', '/effort high'])(
    'preserves queued work for %s after a mention', async command => {
      const h = await larkHarness();
      const queued = h.message({ content: 'already queued', messageId: 'queued' });
      h.pending.push(h.ctx.scope, queued);
      await h.intake({ content: `@Test Bot ${command}` });
      expect(h.pending.cancel(h.ctx.scope)).toEqual([queued]);
      expect(encodeFixture(h.channel.sent)).toContain('已保存');
    },
  );

  it('still clears queued work for a reset command after a mention', async () => {
    const h = await larkHarness();
    h.pending.push(h.ctx.scope, h.message({ content: 'already queued', messageId: 'queued' }));
    await h.intake({ content: '@Test Bot /new' });
    expect(h.pending.cancel(h.ctx.scope)).toEqual([]);
    expect(h.channel.sent.length).toBeGreaterThan(0);
  });

  it.each([
    { content: '@Test Bot /model custom/fast', mentions: [] },
    { content: '@Test Bot /model custom/fast', mentions: [{ key: '@_user_1', openId: 'ou_other', name: 'Test Bot', isBot: true }] },
    { content: '@_user_2 /model custom/fast' },
    { content: '@Test BotExtra /model custom/fast' },
    { content: '@Test Bot 请解释 /model custom/fast' },
    { content: '@Someone @Test Bot /model custom/fast' },
  ])('preserves ordinary text and mentions of others: $content', async patch => {
    const h = await larkHarness();
    await h.intake(patch);
    expect((await resolveRunModelSettings(h.controls, h.ctx.scope)).model).toBe('provider/base');
    expect(h.pending.cancel(h.ctx.scope).map(message => message.content)).toEqual([patch.content]);
  });

  it('keeps the original input when the bot identity is unavailable', async () => {
    const h = await larkHarness();
    Object.assign(h.channel, { botIdentity: undefined });
    const content = '@Test Bot /model custom/fast';
    await h.intake({ content });
    expect((await resolveRunModelSettings(h.controls, h.ctx.scope)).model).toBe('provider/base');
    expect(h.pending.cancel(h.ctx.scope).map(message => message.content)).toEqual([content]);
  });
});

describe('model and effort scope settings', () => {
  it.each(['/model', '/provider'])('preserves a task without an effort argument through %s', async command => {
    const h = await harness();
    const prompt = '检查  这个问题\n\t第二行';
    await h.command(`${command} custom/fast ${prompt}`);
    expect((await resolveRunModelSettings(h.controls, h.ctx.scope)).model).toBe('custom/fast');
    expect(h.ctx.followUpPrompt).toBe(prompt);
  });

  it('switches model and effort in one command and runs the trailing prompt', async () => {
    const h = await harness();
    await h.command('/model provider/base high');
    expect(await resolveRunModelSettings(h.controls, h.ctx.scope)).toMatchObject({
      model: 'provider/base', reasoningEffort: 'high',
    });
    expect(h.ctx.followUpPrompt).toBeUndefined();

    await h.command('/model custom/fast high 检查 这个问题');
    expect(await resolveRunModelSettings(h.controls, h.ctx.scope)).toMatchObject({
      model: 'custom/fast', reasoningEffort: 'high',
    });
    expect(h.ctx.followUpPrompt).toBe('检查 这个问题');
    expect(encodeFixture(h.channel.sent)).toContain('开始执行');

    await h.command('/model provider/restricted ultra 任务');
    expect((await resolveRunModelSettings(h.controls, h.ctx.scope)).model).toBe('custom/fast');
    expect(encodeFixture(h.channel.sent)).toContain('设置未保存');
  });

  it('submits the trailing prompt through intake after the switch', async () => {
    const h = await harness();
    h.controls.cfg = {
      ...h.controls.cfg,
      channels: { lark: { progress: 'off' } },
    } as typeof h.controls.cfg;
    const channel = createFakeChannel();
    const batches: string[][] = [];
    const pending = new PendingQueue(0, (_scope, batch) => {
      batches.push(batch.map(message => message.content));
    });
    const msg = {
      messageId: 'om-model-run',
      chatId: 'chat-1',
      chatType: 'p2p' as const,
      senderId: 'owner',
      senderName: 'Owner',
      content: '/model custom/fast high 检查 这个问题',
      resources: [],
      mentionedBot: false,
    };
    await intakeMessage({
      followups: {},
      channel: fakeCommandChannel(channel),
      resolveAgent: () => h.ctx.agent,
      resolveAgentKind: () => 'codex' as const,
      sessions: h.ctx.sessions,
      workspaces: h.ctx.workspaces,
      activeRuns: h.ctx.activeRuns,
      pending,
      msg,
      controls: h.controls,
      chatModeCache: {
        resolveScope: async () => ({ scope: 'chat-1', threadId: undefined, mode: 'p2p' }),
      },
      executor: {},
      pool: {},
      cotClient: {},
      preparedCots: new Map(),
    } as unknown as Parameters<typeof intakeMessage>[0]);

    await vi.waitFor(() => expect(batches).toEqual([['检查 这个问题']]));
    expect(await resolveRunModelSettings(h.controls, 'chat-1')).toMatchObject({
      model: 'custom/fast', reasoningEffort: 'high',
    });
    expect(encodeFixture(channel.sent)).toContain('开始执行');
  });

  it('shows the active startup provider and refuses a provider setting without poisoning later requests', async () => {
    const h = await harness();
    const root = decodeFixture(await readFile(h.controls.configPath, 'utf8'));
    root.modelServices = Object.fromEntries(['current', 'other'].map(id => [id, { protocol: 'responses', baseUrl: `https://${id}.example/v1`, model: `${id}-model`, apiKey: { source: 'env', id: 'UNSET_TEST_KEY' } }]));
    await writeFile(h.controls.configPath, encodeFixture(root));
    h.ctx.agent.modelProviderState = async () => ({ id: 'current', displayName: 'Current Provider', fixedUntilRestart: true });
    await h.command('/model other/other-model');
    expect((await scopePreferences(h.controls)).get('codex', h.ctx.scope).model).toBeUndefined();
    expect(encodeFixture(h.channel.sent)).toContain('Provider 未切换');
    await h.command('/model current/next-model');
    expect((await scopePreferences(h.controls)).get('codex', h.ctx.scope).model).toBe('current/next-model');
    await h.command('/model');
    expect(encodeFixture(h.channel.sent)).toContain('Current Provider');
  });

  it('accepts a provider model not in the catalog, isolates topics, and resets to CLI defaults', async () => {
    const h = await harness();
    await h.command('/model my-provider/custom-v7');
    await h.command('/effort xhigh');
    expect(await resolveRunModelSettings(h.controls, 'group:topic-a')).toMatchObject({ model: 'my-provider/custom-v7', reasoningEffort: 'xhigh', modelSource: 'scope' });
    expect(await resolveRunModelSettings(h.controls, 'group:topic-b')).toMatchObject({ model: 'provider/base', reasoningEffort: 'medium', modelSource: 'cli' });
    await h.command('/model default');
    await h.command('/effort default');
    expect(await resolveRunModelSettings(h.controls, 'group:topic-a')).toMatchObject({ model: 'provider/base', reasoningEffort: 'medium' });
    expect(await readFile(join(h.tmp.root, 'codex-home/config.toml'), 'utf8')).toBe('model = "provider/base"\nmodel_reasoning_effort = "medium"\n');
  });

  it('persists across /new and store reload without creating a phantom transcript', async () => {
    const h = await harness();
    await h.command('/model custom/persistent');
    expect(h.ctx.sessions.getRaw(h.ctx.scope)).toBeUndefined();
    await h.command('/new');
    expect((await resolveRunModelSettings(h.controls, h.ctx.scope)).model).toBe('custom/persistent');
    const store = new ScopePreferencesStore(join(h.tmp.root, 'profiles/codex/scope-preferences.json'));
    await store.load();
    expect(store.get('codex', h.ctx.scope).model).toBe('custom/persistent');
    expect(store.get('claude', h.ctx.scope)).toEqual({});
  });

  it('updates only the selected profile and respects existing chat overrides', async () => {
    const h = await harness();
    await h.command('/model scoped/model');
    await runCommandHandler('config', 'submit', { ...h.ctx, fromCardAction: true,
      formValue: { model: 'global/model', reasoning_effort: 'high' } });
    await vi.waitFor(() => expect(h.controls.profileConfig.preferences.model).toBe('global/model'));
    await vi.waitFor(() => expect(encodeFixture(h.channel.sent)).toContain('全局默认'));
    expect(await resolveRunModelSettings(h.controls, h.ctx.scope)).toMatchObject({ model: 'scoped/model', reasoningEffort: 'high', effortSource: 'profile' });
    expect(await resolveRunModelSettings(h.controls, 'another-chat')).toMatchObject({ model: 'global/model', reasoningEffort: 'high' });
    const root = decodeFixture(await readFile(h.controls.configPath, 'utf8'));
    expect(root.profiles.other.preferences.model).toBeUndefined();
    await h.command('/model default');
    expect((await resolveRunModelSettings(h.controls, h.ctx.scope)).model).toBe('global/model');
  });

  it('rejects profile scope for both text and card-dispatched local commands', async () => {
    const h = await harness();
    await h.command('/model unauthorized/model --scope profile', h.ctx.scope, 'reader');
    expect(h.controls.profileConfig.preferences.model).toBeUndefined();
    await runCommandHandler('effort', 'high --scope profile', { ...h.ctx, fromCardAction: true });
    expect(h.controls.profileConfig.preferences.reasoningEffort).toBeUndefined();
    expect(encodeFixture(h.channel.sent)).toContain('全局默认请用 /config run');
  });

  it('validates model/effort combinations and rejects flag-like model input', async () => {
    const h = await harness();
    h.controls.profileConfig.preferences.reasoningEffort = 'medium';
    await h.command('/model provider/restricted');
    expect((await resolveRunModelSettings(h.controls, h.ctx.scope)).reasoningEffort).toBe('high');
    await h.command('/effort xhigh');
    expect((await scopePreferences(h.controls)).get('codex', h.ctx.scope).reasoningEffort).toBeUndefined();
    await h.command('/model --dangerously-bypass-approvals-and-sandbox');
    expect((await resolveRunModelSettings(h.controls, h.ctx.scope)).model).toBe('provider/restricted');
    expect(encodeFixture(h.channel.sent)).toContain('设置未保存');
  });

  it('accepts hand-written names in the card and keeps concurrent field updates', async () => {
    const h = await harness();
    await runCommandHandler('model', 'submit', { ...h.ctx, fromCardAction: true,
      formValue: { model: 'private/hand-written', model_pick: '__manual__', reasoning_effort: 'high' } });
    expect(await resolveRunModelSettings(h.controls, h.ctx.scope)).toMatchObject({ model: 'private/hand-written', reasoningEffort: 'high' });
    const store = await scopePreferences(h.controls);
    await Promise.all([store.update('codex', h.ctx.scope, { model: 'private/next' }), store.update('codex', h.ctx.scope, { reasoningEffort: 'max' })]);
    expect(store.get('codex', h.ctx.scope)).toEqual({ model: 'private/next', reasoningEffort: 'max' });
  });

  it('switches Provider and model together from the Feishu card', async () => {
    const h = await harness();
    const root = decodeFixture(await readFile(h.controls.configPath, 'utf8'));
    root.modelServices = {
      deepseek: {
        protocol: 'responses',
        baseUrl: 'https://gateway.example/v1',
        model: 'deepseek-flash',
        apiKey: { source: 'env', id: 'PROVIDER_TEST_KEY' },
      },
    };
    await writeFile(h.controls.configPath, encodeFixture(root));
    await h.command('/provider');
    const card = encodeFixture(h.channel.sent.at(-1));
    expect(card).toContain('provider_pick');
    expect(card).toContain('deepseek');
    expect(card).not.toContain('OpenAI 官方账号');

    await runCommandHandler('model', 'submit', { ...h.ctx, fromCardAction: true,
      formValue: { provider_pick: 'deepseek', model_pick: '__provider_default__', model: 'deepseek-flash', reasoning_effort: 'high' } });

    expect((await scopePreferences(h.controls)).get('codex', h.ctx.scope)).toEqual({
      model: 'deepseek/deepseek-flash',
      reasoningEffort: 'high',
    });
  });

  it('keeps the active task snapshot while showing the next task settings', async () => {
    const h = await harness();
    await h.command('/model private/old');
    await h.command('/effort high');
    const executor = new RunExecutor({ resolveAgent: () => h.ctx.agent, pool: new ProcessPool(() => 1), activeRuns: h.ctx.activeRuns });
    const execution = await executor.submit({
      scopeId: h.ctx.scope,
      ...modelRunArguments(await resolveRunModelSettings(h.controls, h.ctx.scope)),
      policy: {
        ok: true, prompt: 'hello', requestedCwd: h.tmp.workspace, cwdRealpath: h.tmp.workspace,
        accessMode: 'workspace', sandbox: 'workspace-write', permissionMode: 'acceptEdits',
        access: { ok: true, reason: 'allowed-user' }, attachments: [], policyFingerprint: 'fp', expiresAt: Date.now() + 60_000,
      },
    });
    try {
      await h.command('/model private/next');
      await h.command('/effort low');
      expect(h.ctx.activeRuns.get(h.ctx.scope)?.modelSettings).toEqual({ model: 'private/old', reasoningEffort: 'high' });
      expect(await resolveRunModelSettings(h.controls, h.ctx.scope)).toMatchObject({ model: 'private/next', reasoningEffort: 'low' });
      await h.command('/status');
      const status = encodeFixture(h.channel.sent.at(-1));
      expect(status).toContain('private/old');
      expect(status).toContain('private/next');
    } finally {
      for await (const _event of execution.subscribe()) { /* drain */ }
    }
  });

  it('uses the carrier topic for card submits even when chat metadata says group, and never widens on lookup failure', async () => {
    const h = await harness();
    Object.assign(h.channel, { getChatMode: async () => 'group' });
    await h.command('/model');
    expect(encodeFixture(h.channel.sent.at(-1))).toContain('settings_scope');
    h.channel.rawThreadIds.set('card', 'topic-a');
    const pending = new PendingQueue(60_000, () => {});
    const deps = {
      ...h.ctx, channel: h.channel as unknown as Parameters<typeof handleCardAction>[0]['channel'],
      pending, chatModeCache: new ChatModeCache(),
      evt: {
        chatId: 'group', messageId: 'card', operator: { openId: 'owner' },
        action: { value: { cmd: 'model.submit', settings_scope: h.ctx.scope } },
        raw: { action: { form_value: { model: 'private/card-topic', reasoning_effort: 'high' } } },
      } as unknown as CardActionEvent,
    };
    await handleCardAction(deps);
    const store = await scopePreferences(h.controls);
    expect(store.get('codex', 'group:topic-a')).toEqual({ model: 'private/card-topic', reasoningEffort: 'high' });
    expect(store.get('codex', 'group')).toEqual({});
    expect(h.channel.sent.at(-1)?.options).toMatchObject({ replyInThread: true });
    h.channel.rawThreadIds.clear();
    await handleCardAction(deps);
    expect(store.get('codex', 'group')).toEqual({});
    expect(encodeFixture(h.channel.sent.at(-1))).toContain('设置未保存');
    pending.cancelAll();
  });
});
