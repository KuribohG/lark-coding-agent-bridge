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
  vi.unstubAllEnvs();
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

describe('in-flight IM delivery', () => {
  it('delivers ordinary text to the existing turn with scoped acknowledgement', async () => {
    const h = await harness();
    await h.message('original task');
    await vi.waitFor(() => expect(h.agent.options).toHaveLength(1), { timeout: 2500 });
    await h.message('focus on hg02', { messageId: 'supplement' });
    expect(h.agent.options).toHaveLength(1);
    expect(h.agent.stops).toHaveLength(0);
    expect(h.agent.supplements).toHaveLength(1);
    expect(h.agent.supplements[0]).toContain('focus on hg02');
    expect(h.agent.supplements[0]).toContain('supplement');
    expect(h.channel.sent.at(-1)).toMatchObject({ content: { markdown: '已送入当前任务，等待模型处理。' }, options: { replyTo: 'supplement', replyInThread: true } });
    await h.message('/stop');
    expect(h.agent.stops.length).toBeGreaterThan(0);
  });
  it('keeps authorization and mention gates ahead of in-flight delivery', async () => {
    const h = await harness();
    await h.message('original');
    await vi.waitFor(() => expect(h.agent.options).toHaveLength(1), { timeout: 2500 });
    h.controls.profileConfig.access.allowedChats = [];
    await h.message('untrusted', { senderId: 'outsider' });
    await h.message('unmentioned', { mentionedBot: false });
    expect(h.agent.supplements).toHaveLength(0);
  });
  it('does not create an unbounded follow-up when a timed turn ends during delivery', async () => {
    const h = await harness();
    await h.message('original');
    await vi.waitFor(() => expect(h.agent.options).toHaveLength(1), { timeout: 2500 });
    h.controls.activeTimedRun = () => 'timed-job';
    h.agent.onSteer = async () => {
      h.controls.activeTimedRun = () => undefined;
      h.agent.finish(0);
      return 'inactive';
    };
    await h.message('late supplement');
    expect(JSON.stringify(h.channel.sent)).toContain('这条消息未排队执行');
    await new Promise(resolve => setTimeout(resolve, 800));
    expect(h.agent.options).toHaveLength(1);
  });
  it('cancels queued text before stop acknowledgement and never auto-resumes it', async () => {
    const h = await harness(); h.agent.supportsSteer = false;
    await h.message('original');
    await vi.waitFor(() => expect(h.agent.options).toHaveLength(1), { timeout: 2500 });
    await h.message('queued');
    expect(JSON.stringify(h.channel.sent.at(-1))).toContain('已排队');
    await h.message('/stop');
    expect(JSON.stringify(h.channel.sent)).toContain('已取消 1 条排队消息');
    await new Promise(resolve => setTimeout(resolve, 800));
    expect(h.agent.options).toHaveLength(1);
  });
  it('does not spawn after /stop cancels preparation', async () => {
    const h = await harness();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const prepare = vi.spyOn(h.agent, 'prepareRun').mockImplementation(() => gate);
    await h.message('original');
    await vi.waitFor(() => expect(prepare).toHaveBeenCalled(), { timeout: 2500 });
    await h.message('/stop'); release();
    await new Promise(resolve => setTimeout(resolve, 800));
    expect(h.agent.options).toHaveLength(0);
  });
  it('cancels a debouncing message even when no run has started', async () => {
    const h = await harness();
    await h.message('pending'); await h.message('/stop');
    await new Promise(resolve => setTimeout(resolve, 800));
    expect(h.agent.options).toHaveLength(0);
    expect(JSON.stringify(h.channel.sent)).toContain('已取消 1 条排队消息');
  });
});

class GateAgent implements AgentAdapter {
  readonly id = 'codex';
  readonly displayName = 'Test Codex';
  readonly options: AgentRunOptions[] = [];
  readonly supplements: string[] = [];
  supportsSteer = true;
  onSteer?: () => Promise<'accepted' | 'inactive'>;
  readonly stops: string[] = [];
  private finishes: Array<() => void> = [];
  async isAvailable() { return true; }
  async prepareRun(): Promise<void> {}
  finish(index: number) { this.finishes[index]?.(); }
  run(opts: AgentRunOptions) {
    this.options.push(opts);
    let finish!: () => void;
    const done = new Promise<void>((resolve) => { finish = resolve; });
    this.finishes.push(finish);
    const self = this;
    return { runId: opts.runId,
      ...(this.supportsSteer ? { steer: async (prompt: string) => { self.supplements.push(prompt); return self.onSteer ? self.onSteer() : 'accepted' as const; } } : {}),
      events: { async *[Symbol.asyncIterator](): AsyncGenerator<AgentEvent> {
        yield { type: 'system', threadId: 'native-thread' };
        yield { type: 'text', delta: 'Working' };
        await done;
        yield { type: 'final_text', content: 'Finished' };
        yield { type: 'done', terminationReason: 'normal' };
      } },
      async stop() { self.stops.push(opts.runId); finish(); }, async waitForExit() { return true; },
    };
  }
}

async function harness(agentKind: 'claude' | 'codex' = 'codex') {
  const tmp = await createTmpProfile('timed-channel-');
  const codexHome = join(tmp.root, 'codex-home');
  await mkdir(codexHome);
  await writeFile(join(codexHome, 'config.toml'), '');
  // Keep the operator's real Claude settings out of the model environment.
  vi.stubEnv('CLAUDE_CONFIG_DIR', join(tmp.root, 'claude-home'));
  vi.stubEnv('ANTHROPIC_MODEL', undefined);
  vi.stubEnv('CLAUDE_CODE_EFFORT_LEVEL', undefined);
  const profile = createDefaultProfileConfig({ agentKind,
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
    message: (content: string, extra: Partial<NormalizedMessage> = {}) => handlers.message!({
      chatId: 'oc_chat', messageId: 'message', threadId: 'topic', chatType: 'group', senderId: 'owner',
      content, rawContentType: 'text', resources: [], mentions: [], mentionedBot: true, mentionAll: false, createTime: Date.now(), ...extra,
    } as NormalizedMessage),
    click: (cmd: string, id: string, owner = 'owner', scoped = true) => handlers.cardAction!({
      chatId: 'oc_chat', messageId: 'card', operator: { openId: owner },
      action: { value: { cmd, arg: id, ...(scoped ? { settings_scope: scope } : {}) } },
    } as CardActionEvent),
  };
}
