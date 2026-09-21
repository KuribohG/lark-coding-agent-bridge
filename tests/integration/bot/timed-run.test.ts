import type { CardActionEvent, NormalizedMessage } from '@larksuite/channel';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentAdapter, AgentEvent, AgentRunOptions } from '../../../src/agent/types';
import type { Controls } from '../../../src/commands';
import { createDefaultProfileConfig, type RootConfig } from '../../../src/config/profile-schema';
import { runtimeProfileConfig } from '../../../src/config/profile-store';
import { SessionStore } from '../../../src/session/store';
import { WorkspaceStore } from '../../../src/workspace/store';
import { timedRuns } from '../../../src/runtime/timed-runs';
import { createFakeChannel } from '../../helpers/fake-channel';
import { createTmpProfile } from '../../helpers/tmp-profile';

const sdk = vi.hoisted(() => ({ channel: undefined as unknown }));
vi.mock('@larksuite/channel', async (original) => ({
  ...await original<typeof import('@larksuite/channel')>(), createLarkChannel: () => sdk.channel,
}));
import { startChannel } from '../../../src/bot/channel';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

describe('one-shot tasks through Lark commands and cards', () => {
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
