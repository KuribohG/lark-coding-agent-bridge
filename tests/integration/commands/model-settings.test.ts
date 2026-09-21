import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { tryHandleCommand, runCommandHandler, type CommandContext, type Controls } from '../../../src/commands';
import { createDefaultProfileConfig, type RootConfig } from '../../../src/config/profile-schema';
import { runtimeProfileConfig } from '../../../src/config/profile-store';
import { resolveRunModelSettings, scopePreferences } from '../../../src/runtime/model-settings';
import { ActiveRuns } from '../../../src/bot/active-runs';
import { ProcessPool } from '../../../src/bot/process-pool';
import { RunExecutor } from '../../../src/runtime/run-executor';
import { modelRunArguments } from '../../../src/agent/model-settings';
import { handleCardAction } from '../../../src/card/dispatcher';
import { ChatModeCache } from '../../../src/bot/chat-mode-cache';
import { PendingQueue } from '../../../src/bot/pending-queue';
import type { CardActionEvent } from '@larksuite/channel';
import { SessionStore } from '../../../src/session/store';
import { WorkspaceStore } from '../../../src/workspace/store';
import { ScopePreferencesStore } from '../../../src/session/scope-preferences';
import { createFakeChannel } from '../../helpers/fake-channel';
import { FakeAgentAdapter } from '../../helpers/fake-agent';
import { createTmpProfile } from '../../helpers/tmp-profile';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map((f) => f())); });

async function harness() {
  const tmp = await createTmpProfile('model-settings-');
  cleanups.push(tmp.cleanup);
  const home = join(tmp.root, 'codex-home');
  await mkdir(home);
  await writeFile(join(home, 'config.toml'), 'model = "provider/base"\nmodel_reasoning_effort = "medium"\n');
  await writeFile(join(home, 'models_cache.json'), JSON.stringify({ models: [
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
  const configPath = join(tmp.root, 'config.json');
  await writeFile(configPath, JSON.stringify(root));
  const controls: Controls = { profile: 'codex', profileConfig: profile, cfg: runtimeProfileConfig(root, 'codex'),
    configPath, processId: 'test', botOwnerId: 'owner', ownerRefreshState: 'ok',
    async refreshOwner() {}, async restart() {}, async exit() {},
  };
  const channel = createFakeChannel();
  const ctx: CommandContext = {
    controls, channel: channel as unknown as CommandContext['channel'], scope: 'group:topic-a', chatMode: 'topic',
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

describe('model and effort scope settings', () => {
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
    await h.command('/model global/model --scope profile');
    await h.command('/effort high --scope profile');
    expect(await resolveRunModelSettings(h.controls, h.ctx.scope)).toMatchObject({ model: 'scoped/model', reasoningEffort: 'high', effortSource: 'profile' });
    expect(await resolveRunModelSettings(h.controls, 'another-chat')).toMatchObject({ model: 'global/model', reasoningEffort: 'high' });
    const root = JSON.parse(await readFile(h.controls.configPath, 'utf8'));
    expect(root.profiles.other.preferences.model).toBeUndefined();
    await h.command('/model default');
    expect((await resolveRunModelSettings(h.controls, h.ctx.scope)).model).toBe('global/model');
  });

  it('checks profile permissions for both text and card-dispatched commands', async () => {
    const h = await harness();
    await h.command('/model unauthorized/model --scope profile', h.ctx.scope, 'reader');
    expect(h.controls.profileConfig.preferences.model).toBeUndefined();
    await runCommandHandler('effort', 'high --scope profile', { ...h.ctx, fromCardAction: true });
    expect(h.controls.profileConfig.preferences.reasoningEffort).toBeUndefined();
    expect(JSON.stringify(h.channel.sent)).toContain('owner/管理员');
  });

  it('validates model/effort combinations and rejects flag-like model input', async () => {
    const h = await harness();
    await h.command('/effort medium --scope profile');
    await h.command('/model provider/restricted');
    expect((await resolveRunModelSettings(h.controls, h.ctx.scope)).reasoningEffort).toBe('high');
    await h.command('/effort xhigh');
    expect((await scopePreferences(h.controls)).get('codex', h.ctx.scope).reasoningEffort).toBeUndefined();
    await h.command('/model --dangerously-bypass-approvals-and-sandbox');
    expect((await resolveRunModelSettings(h.controls, h.ctx.scope)).model).toBe('provider/restricted');
    expect(JSON.stringify(h.channel.sent)).toContain('设置未保存');
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

  it('keeps the active task snapshot while showing the next task settings', async () => {
    const h = await harness();
    await h.command('/model private/old');
    await h.command('/effort high');
    const executor = new RunExecutor({ agent: h.ctx.agent, pool: new ProcessPool(() => 1), activeRuns: h.ctx.activeRuns });
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
      const status = JSON.stringify(h.channel.sent.at(-1));
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
    expect(JSON.stringify(h.channel.sent.at(-1))).toContain('settings_scope');
    h.channel.rawThreadIds.set('card', 'topic-a');
    const pending = new PendingQueue(60_000, () => {});
    const deps = {
      ...h.ctx, pending, chatModeCache: new ChatModeCache(),
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
    expect(JSON.stringify(h.channel.sent.at(-1))).toContain('设置未保存');
    pending.cancelAll();
  });
});
