import type { CardActionEvent, NormalizedMessage } from '@larksuite/channel';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentAdapter, AgentEvent, AgentRunOptions } from '../../../src/agent/types';
import type { Controls } from '../../../src/commands';
import { createDefaultProfileConfig, type RootConfig } from '../../../src/config/profile-schema';
import { runtimeProfileConfig } from '../../../src/config/profile-store';
import { SessionStore } from '../../../src/session/store';
import { WorkspaceStore } from '../../../src/workspace/store';
import { timedRuns } from '../../../src/runtime/timed-runs';
import { readRunDefaults, runDefaultsPath } from '../../../src/runtime/run-defaults';
import { createFakeChannel } from '../../helpers/fake-channel';
import { createTmpProfile } from '../../helpers/tmp-profile';

const sdk = vi.hoisted(() => ({ channel: undefined as unknown }));
vi.mock('@larksuite/channel', async (original) => ({
  ...await original<typeof import('@larksuite/channel')>(), createLarkChannel: () => sdk.channel,
}));
import { startChannel } from '../../../src/bot/channel';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

describe('one-shot tasks through Lark commands and cards', () => {
  it('persists reusable bot defaults and recomputes a fresh deadline for shorthand tasks each day', async () => {
    const h = await harness();
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-21T23:00+08:00'));
    await h.message('/run defaults --until 01:00 --tz Asia/Shanghai --margin 5 --effort ultra');
    const persisted = JSON.parse(await readFile(runDefaultsPath(h.controls), 'utf8'));
    expect(persisted).toEqual({ until: '01:00', timeZone: 'Asia/Shanghai', marginMinutes: 5, reasoningEffort: 'ultra' });
    expect(await readRunDefaults({ ...h.controls })).toMatchObject(persisted);
    await h.message('/run -- First task -- keep this text');
    const store = await timedRuns(h.controls);
    const first = store.latest(h.scope)!;
    expect(first).toMatchObject({ task: 'First task -- keep this text', state: 'draft',
      stopAt: Date.parse('2026-09-22T00:55+08:00'), modelSettings: { model: 'custom/day', reasoningEffort: 'ultra' } });
    now.mockReturnValue(Date.parse('2026-09-22T23:00+08:00'));
    await h.message('/run -- Second task');
    expect(store.latest(h.scope)?.stopAt).toBe(Date.parse('2026-09-23T00:55+08:00'));
    expect(store.get(first.id)?.stopAt).toBe(first.stopAt);
    expect(h.agent.options).toHaveLength(0);
    expect(h.controls.profileConfig.preferences.reasoningEffort).toBe('high');
    expect(await readRunDefaults({ ...h.controls, profile: 'another-bot' })).toMatchObject({ until: '2h', marginMinutes: 5 });
  });

  it('lets explicit task flags override defaults and default inherit conversation settings without rewriting the preset', async () => {
    const h = await harness();
    await h.message('/run defaults --until 2h --tz UTC --margin 5 --model custom/night --effort ultra');
    await h.message('/run --until 90m --margin 10 --model default --effort default -- One task');
    const job = (await timedRuns(h.controls)).latest(h.scope)!;
    expect(job).toMatchObject({ modelSettings: { model: 'custom/day', reasoningEffort: 'high' } });
    expect(job.deadlineAt - job.stopAt).toBe(10 * 60_000);
    expect(await readRunDefaults(h.controls)).toMatchObject({ until: '2h', marginMinutes: 5, model: 'custom/night', reasoningEffort: 'ultra' });
  });

  it('edits defaults through a scoped admin card without creating a job and pre-fills the task form', async () => {
    const h = await harness();
    await h.message('/run defaults');
    expect(JSON.stringify(h.channel.sent.at(-1))).toContain('run.defaults.save');
    const click = (owner: string, scope = h.scope) => h.handlers.cardAction!({
      chatId: 'oc_chat', messageId: 'card', operator: { openId: owner },
      action: { value: { cmd: 'run.defaults.save', settings_scope: scope } },
      raw: { action: { form_value: { until: '01:00', time_zone: 'Asia/Shanghai', margin: '5', model_pick: '__manual__', model: 'custom/saved', effort: 'ultra' } } },
    } as unknown as CardActionEvent);
    await click('reader');
    expect(JSON.stringify(h.channel.sent.at(-1))).toContain('管理员');
    expect((await readRunDefaults(h.controls)).until).toBe('2h');
    await click('owner', 'wrong-topic');
    expect(JSON.stringify(h.channel.sent.at(-1))).toContain('无法确认');
    await click('owner');
    expect(await readRunDefaults(h.controls)).toMatchObject({ until: '01:00', model: 'custom/saved', reasoningEffort: 'ultra' });
    expect((await timedRuns(h.controls)).latest(h.scope)).toBeUndefined();
    await h.message('/run');
    const form = JSON.stringify(h.channel.sent.at(-1));
    expect(form).toContain('custom/saved');
    expect(form).toContain('"initial_option":"ultra"');
    expect(form).toContain('"default_value":"01:00"');
    await h.message('/run defaults reset');
    expect(await readRunDefaults(h.controls)).toMatchObject({ until: '2h', model: undefined, reasoningEffort: undefined });
  });

  it('rejects fixed-date defaults and too-late tasks without silently moving to the next quota window', async () => {
    const h = await harness();
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-22T00:57+08:00'));
    await h.message('/run defaults --until 2026-09-23T01:00+08:00');
    expect(JSON.stringify(h.channel.sent.at(-1))).toContain('不能保存固定日期');
    await h.message('/run defaults --until 01:00 --tz Asia/Shanghai --margin 5 --effort ultra');
    await h.message('/run -- Too late');
    expect(JSON.stringify(h.channel.sent.at(-1))).toContain('不足 10 秒');
    expect((await timedRuns(h.controls)).latest(h.scope)).toBeUndefined();
    expect(h.agent.options).toHaveLength(0);
  });

  it('previews absolute times, starts once, and restores ordinary model preferences for the next message', async () => {
    const h = await harness();
    await h.message('/run --until 2h --tz Asia/Shanghai --margin 5 --model custom/night --effort ultra -- Review the code');
    const store = await timedRuns(h.controls);
    const job = store.latest(h.scope)!;
    expect(job).toMatchObject({ state: 'draft', scope: h.scope, owner: 'owner', modelSettings: { model: 'custom/night', reasoningEffort: 'ultra' } });
    expect(job.deadlineAt - job.stopAt).toBe(5 * 60_000);
    expect(h.agent.options).toHaveLength(0);
    expect(JSON.stringify(h.channel.sent.at(-1))).toContain('Asia/Shanghai');
    await h.click('run.start', job.id);
    await vi.waitFor(() => expect(h.agent.options).toHaveLength(1));
    expect(h.agent.options[0]).toMatchObject({ deadlineAt: job.stopAt, model: 'custom/night', reasoningEffort: 'ultra' });
    expect(h.agent.options[0]?.prompt).toContain(new Date(job.stopAt).toISOString());
    await h.click('run.start', job.id);
    expect(h.agent.options).toHaveLength(1);
    await h.message('This must not become an unbounded followup');
    expect(JSON.stringify(h.channel.sent.at(-1))).toContain('未排队');
    h.agent.finish(0);
    await vi.waitFor(() => expect(store.get(job.id)?.state).toBe('completed'));
    await vi.waitFor(() => expect(h.controls.activeTimedRun?.(h.scope)).toBeUndefined());
    await h.message('A fresh user task');
    await vi.waitFor(() => expect(h.agent.options).toHaveLength(2), { timeout: 2000 });
    expect(h.agent.options[1]).toMatchObject({ model: 'custom/day', reasoningEffort: 'high', deadlineAt: undefined });
    h.agent.finish(1);
  });

  it('denies forwarded, unscoped and other-user start clicks', async () => {
    const h = await harness();
    await h.message('/run --until 2h --tz UTC -- task');
    const store = await timedRuns(h.controls);
    const job = store.latest(h.scope)!;
    await h.click('run.start', job.id, 'reader');
    expect(JSON.stringify(h.channel.sent.at(-1))).toContain('创建者');
    h.channel.rawThreadIds.clear();
    await h.click('run.start', job.id);
    expect(JSON.stringify(h.channel.sent.at(-1))).toContain('无法确认');
    h.channel.rawThreadIds.set('card', 'topic');
    await h.click('run.start', job.id, 'owner', false);
    expect(store.get(job.id)?.state).toBe('draft');
    expect(h.agent.options).toHaveLength(0);
  });

  it('starts a card-submitted manual model and supports /stop without changing preferences', async () => {
    const h = await harness();
    await h.message('/run');
    expect(JSON.stringify(h.channel.sent.at(-1))).toContain('run.submit');
    await h.handlers.cardAction!({
      chatId: 'oc_chat', messageId: 'card', operator: { openId: 'owner' },
      action: { value: { cmd: 'run.submit', settings_scope: h.scope } },
      raw: { action: { form_value: { task: 'Card task', until: '90m', time_zone: 'UTC', margin: '5', model_pick: '__manual__', model: 'private/model', effort: 'ultra' } } },
    } as unknown as CardActionEvent);
    const store = await timedRuns(h.controls);
    const job = store.latest(h.scope)!;
    await h.click('run.start', job.id);
    await vi.waitFor(() => expect(h.agent.options).toHaveLength(1));
    await h.message('/stop');
    await vi.waitFor(() => expect(store.get(job.id)?.state).toBe('stopped'));
    expect(h.controls.profileConfig.preferences).toMatchObject({ model: 'custom/day', reasoningEffort: 'high' });
  });
});

class GateAgent implements AgentAdapter {
  readonly id = 'codex';
  readonly displayName = 'Test Codex';
  readonly options: AgentRunOptions[] = [];
  private finishes: Array<() => void> = [];
  async isAvailable() { return true; }
  finish(index: number) { this.finishes[index]?.(); }
  run(opts: AgentRunOptions) {
    this.options.push(opts);
    let finish!: () => void;
    const done = new Promise<void>((resolve) => { finish = resolve; });
    this.finishes.push(finish);
    return { runId: opts.runId,
      events: { async *[Symbol.asyncIterator](): AsyncGenerator<AgentEvent> {
        yield { type: 'system', threadId: 'native-thread' };
        yield { type: 'text', delta: 'Working' };
        await done;
        yield { type: 'final_text', content: 'Finished' };
        yield { type: 'done', terminationReason: 'normal' };
      } },
      async stop() { finish(); }, async waitForExit() { return true; },
    };
  }
}

async function harness() {
  const tmp = await createTmpProfile('timed-channel-');
  const codexHome = join(tmp.root, 'codex-home');
  await mkdir(codexHome);
  await writeFile(join(codexHome, 'config.toml'), '');
  const profile = createDefaultProfileConfig({ agentKind: 'codex',
    accounts: { app: { id: 'test', secret: 'test-secret', tenant: 'feishu' } },
    access: { allowedChats: ['oc_chat'], allowedUsers: ['owner', 'reader'], admins: ['owner'] },
    codex: { binaryPath: 'codex', codexHome },
    preferences: { model: 'custom/day', reasoningEffort: 'high', messageReply: 'text', messageReplyMigrated: true, cotMessages: 'off' },
  });
  profile.workspaces.default = tmp.workspace;
  const root: RootConfig = { schemaVersion: 2, activeProfile: 'test', preferences: {}, profiles: { test: profile } };
  const controls: Controls = { profile: 'test', profileConfig: profile, cfg: runtimeProfileConfig(root, 'test'),
    configPath: join(tmp.root, 'config.json'), processId: 'test', botOwnerId: 'owner', ownerRefreshState: 'ok',
    async refreshOwner() {}, async restart() {}, async exit() {},
  };
  const handlers: { message?: (msg: NormalizedMessage) => Promise<void>; cardAction?: (evt: CardActionEvent) => Promise<void> } = {};
  const channel = Object.assign(createFakeChannel(), {
    botIdentity: { openId: 'bot', name: 'Test' },
    on(next: typeof handlers) { Object.assign(handlers, next); }, async connect() {}, async disconnect() {},
    async getChatMode() { return 'group'; }, getConnectionStatus() { return { state: 'connected' }; },
  });
  Object.assign(channel.rawClient, { application: { v6: { application: { get: async () => ({ data: { app: { owner: { owner_id: 'owner' } } } }) } } } });
  channel.rawThreadIds.set('card', 'topic');
  sdk.channel = channel;
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const agent = new GateAgent();
  cleanup.push(async () => { await sessions.flush(); await workspaces.flush(); await tmp.cleanup(); });
  const bridge = await startChannel({ cfg: controls.cfg, agent, sessions, workspaces, controls });
  cleanup.push(async () => { await bridge.disconnect(); });
  const scope = 'oc_chat:topic';
  return { controls, agent, channel, handlers, scope,
    message: (content: string) => handlers.message!({
      chatId: 'oc_chat', messageId: 'message', threadId: 'topic', chatType: 'group', senderId: 'owner',
      content, rawContentType: 'text', resources: [], mentions: [], mentionedBot: true, mentionAll: false, createTime: Date.now(),
    } as NormalizedMessage),
    click: (cmd: string, id: string, owner = 'owner', scoped = true) => handlers.cardAction!({
      chatId: 'oc_chat', messageId: 'card', operator: { openId: owner },
      action: { value: { cmd, arg: id, ...(scoped ? { settings_scope: scope } : {}) } },
    } as CardActionEvent),
  };
}
