import { preparedRun } from '../../../../src/agent/prepared-run';
import type { CardActionEvent, NormalizedMessage } from '@larksuite/channel';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentAdapter, AgentEvent, AgentRunOptions } from '../../../../src/agent/types';
import type { Controls } from '../../../../src/commands';
import { createDefaultProfileConfig, type RootConfig } from '../../../../src/config/profile-schema';
import { runtimeProfileConfig } from '../../../../src/config/profile-store';
import { SessionStore } from '../../../../src/session/store';
import { WorkspaceStore } from '../../../../src/workspace/store';
import { timedRuns } from '../../../../src/runtime/timed-runs';
import { MAX_RESUME_ATTEMPTS } from '../../../../src/channels/lark/interrupted-turns';
import { createFakeChannel } from '../../../helpers/fake-channel';
import { createTmpProfile, type TmpProfile } from '../../../helpers/tmp-profile';

const sdk = vi.hoisted(() => ({ channel: undefined as unknown }));
vi.mock('@larksuite/channel', async (original) => ({
  ...await original<typeof import('@larksuite/channel')>(), createLarkChannel: () => sdk.channel,
}));
// Hosts live only as long as a test says so; nothing here spawns a real run host.
const hosts = vi.hoisted(() => ({ live: new Set<string>(), removed: [] as string[], terminated: [] as string[] }));
vi.mock('../../../../src/agent/run-host', async (original) => ({
  ...await original<typeof import('../../../../src/agent/run-host')>(),
  runHostsSupported: () => true,
  probeRunHost: async (key: string) => hosts.live.has(key) ? 'running' : 'missing',
  runHostAgent: (key: string) => hosts.live.has(key) ? 'codex' : undefined,
  terminateRunHost: async (key: string) => { hosts.terminated.push(key); hosts.live.delete(key); },
  removeRunHost: (key: string) => { hosts.removed.push(key); },
  sweepRunHosts: async () => {},
}));
import { startChannel } from '../../../../src/channels/lark';
import { STREAMED_EXECUTION } from '../../../helpers/fake-agent';
import { FixedExecutionController } from '../../../helpers/fixed-execution';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const fn of cleanup.splice(0).reverse()) await fn();
  hosts.live.clear();
  hosts.removed.length = 0;
  hosts.terminated.length = 0;
});

const RESUME_NOTE = '自动续跑（第 1 次）';

describe('turns cut off by a bridge shutdown', () => {
  it('replays the interrupted input once on the next start and forgets it after completion', async () => {
    const h = await harness();
    const first = await h.start();
    await first.message('整理发布记录');
    await vi.waitFor(() => expect(h.agent.options).toHaveLength(1));
    await first.stop();
    expect(await h.journal()).toEqual([expect.objectContaining({ scope: h.scope, attempts: 0 })]);

    const second = await h.start();
    await vi.waitFor(() => expect(h.agent.options).toHaveLength(2));
    expect(h.agent.options[1]?.prompt).toContain('整理发布记录');
    expect(h.agent.options[1]?.prompt).toContain('现已重启并自动续跑（第 1 次）');
    expect(JSON.stringify(second.channel.sent)).toContain(RESUME_NOTE);
    expect(await h.journal()).toEqual([expect.objectContaining({ scope: h.scope, attempts: 1 })]);
    h.agent.finish(1);
    await vi.waitFor(async () => expect(await h.journal()).toEqual([]));
    await second.stop();

    await h.start();
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(h.agent.options).toHaveLength(2);
  });

  it('hands interrupted turns to the replacement channel of an in-process restart', async () => {
    const h = await harness();
    const first = await h.start();
    await first.message('跨重连的任务');
    await vi.waitFor(() => expect(h.agent.options).toHaveLength(1));
    h.controls = h.freshControls();
    const next = await h.start({ restorePending: false });
    await first.stop();
    expect(h.agent.options).toHaveLength(1);
    await h.controls.reloadPendingInput?.();
    h.controls.resumePendingInput?.();
    await vi.waitFor(() => expect(h.agent.options).toHaveLength(2));
    expect(h.agent.options[1]?.prompt).toContain('跨重连的任务');
    expect(JSON.stringify(next.channel.sent)).toContain(RESUME_NOTE);
    h.agent.finish(1);
    await vi.waitFor(async () => expect(await h.journal()).toEqual([]));
  });

  it('does not replay a turn the user stopped before the shutdown', async () => {
    const h = await harness();
    const first = await h.start();
    await first.message('长任务');
    await vi.waitFor(() => expect(h.agent.options).toHaveLength(1));
    await first.message('/stop');
    await vi.waitFor(async () => expect(await h.journal()).toEqual([]));
    await first.stop();
    const second = await h.start();
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(h.agent.options).toHaveLength(1);
    expect(JSON.stringify(second.channel.sent)).not.toContain('自动续跑');
  });

  it('gives up with a notice once the replay budget is spent', async () => {
    const h = await harness();
    await mkdir(h.stateDir, { recursive: true });
    await writeFile(join(h.stateDir, 'interrupted-turns.json'), JSON.stringify({ version: 1, turns: [{
      scope: h.scope, messages: [h.input('反复中断的任务')], startedAt: Date.now(), attempts: MAX_RESUME_ATTEMPTS,
    }] }));
    const bridge = await h.start();
    await vi.waitFor(() => expect(JSON.stringify(bridge.channel.sent)).toContain('不再自动续跑'));
    expect(h.agent.options).toHaveLength(0);
    await vi.waitFor(async () => expect(await h.journal()).toEqual([]));
  });

  it('reattaches to a hosted run that kept going, without replaying the input or notifying', async () => {
    const h = await harness();
    h.agent.hosted = true;
    const first = await h.start();
    await first.message('跨重启的长任务');
    await vi.waitFor(() => expect(h.agent.options).toHaveLength(1));
    const key = h.agent.options[0]?.host?.key;
    expect(key).toBeTruthy();
    expect(h.agent.options[0]?.host?.attach).toBeUndefined();
    await first.stop();
    expect(JSON.stringify(first.channel.sent)).toContain('任务没有中断');
    expect(await h.journal()).toEqual([expect.objectContaining({ scope: h.scope, hostKey: key, attempts: 0 })]);

    const second = await h.start();
    await vi.waitFor(() => expect(h.agent.options).toHaveLength(2));
    expect(h.agent.options[1]?.host).toEqual({ key, attach: true });
    expect(JSON.stringify(second.channel.sent)).not.toContain('自动续跑');
    expect(hosts.terminated).toEqual([]);
    h.agent.finish(1);
    await vi.waitFor(async () => expect(await h.journal()).toEqual([]));
    expect(hosts.removed).toContain(key);
  });

  it('replays the input under a new host when the old host is gone', async () => {
    const h = await harness();
    h.agent.hosted = true;
    const first = await h.start();
    await first.message('宿主丢失的任务');
    await vi.waitFor(() => expect(h.agent.options).toHaveLength(1));
    const key = h.agent.options[0]!.host!.key;
    await first.stop();
    hosts.live.delete(key);

    const second = await h.start();
    await vi.waitFor(() => expect(h.agent.options).toHaveLength(2));
    expect(h.agent.options[1]?.host?.attach).toBeUndefined();
    expect(h.agent.options[1]?.host?.key).not.toBe(key);
    expect(h.agent.options[1]?.prompt).toContain('现已重启并自动续跑（第 1 次）');
    expect(JSON.stringify(second.channel.sent)).toContain(RESUME_NOTE);
    expect(hosts.terminated).toContain(key);
    h.agent.finish(1);
    await vi.waitFor(async () => expect(await h.journal()).toEqual([]));
  });

  it('reattaches an interrupted timed run whose host is still running', async () => {
    const h = await harness();
    h.agent.hosted = true;
    const first = await h.start();
    await first.message('/run --until 2h --tz UTC -- 夜间巡检');
    const job = (await timedRuns(h.controls)).latest(h.scope)!;
    await first.click('run.start', job.id);
    await vi.waitFor(() => expect(h.agent.options).toHaveLength(1));
    const key = h.agent.options[0]!.host!.key;
    await first.stop();
    h.controls = h.freshControls();
    expect((await timedRuns(h.controls)).get(job.id)?.state).toBe('interrupted');

    await h.start();
    await vi.waitFor(() => expect(h.agent.options).toHaveLength(2));
    expect(h.agent.options[1]).toMatchObject({ deadlineAt: job.stopAt, host: { key, attach: true } });
    const store = await timedRuns(h.controls);
    await vi.waitFor(() => expect(store.get(job.id)?.state).toBe('running'));
    h.agent.finish(1);
    await vi.waitFor(() => expect(store.get(job.id)?.state).toBe('completed'));
    await vi.waitFor(async () => expect(await h.journal()).toEqual([]));
  });

  it('resumes an interrupted timed run before its stop time', async () => {
    const h = await harness();
    const first = await h.start();
    await first.message('/run --until 2h --tz UTC -- 夜间检查');
    const job = (await timedRuns(h.controls)).latest(h.scope)!;
    await first.click('run.start', job.id);
    await vi.waitFor(() => expect(h.agent.options).toHaveLength(1));
    await first.stop();
    h.controls = h.freshControls();
    expect((await timedRuns(h.controls)).get(job.id)?.state).toBe('interrupted');

    await h.start();
    await vi.waitFor(() => expect(h.agent.options).toHaveLength(2));
    expect(h.agent.options[1]).toMatchObject({ deadlineAt: job.stopAt });
    expect(h.agent.options[1]?.prompt).toContain('夜间检查');
    expect(h.agent.options[1]?.prompt).toContain('现已重启并自动续跑（第 1 次）');
    const store = await timedRuns(h.controls);
    await vi.waitFor(() => expect(store.get(job.id)?.state).toBe('running'));
    expect(store.get(job.id)?.finishedAt).toBeUndefined();
    h.agent.finish(1);
    await vi.waitFor(() => expect(store.get(job.id)?.state).toBe('completed'));
    await vi.waitFor(async () => expect(await h.journal()).toEqual([]));
  });
});

class GateAgent implements AgentAdapter {
  readonly id = 'codex';
  readonly displayName = 'Test Codex';
  readonly capabilities = STREAMED_EXECUTION;
  readonly options: AgentRunOptions[] = [];
  /** Runs started under a host keep going when the bridge stops, like a real hosted agent. */
  hosted = false;
  private finishes: Array<() => void> = [];
  async isAvailable() { return true; }
  finish(index: number) { this.finishes[index]?.(); }
  async prepareRun(opts: AgentRunOptions) { return preparedRun({}, () => this.run(opts)); }

  run(opts: AgentRunOptions) {
    this.options.push(opts);
    if (this.hosted && opts.host && !opts.host.attach) hosts.live.add(opts.host.key);
    let finish!: () => void;
    const done = new Promise<void>((resolve) => { finish = resolve; });
    this.finishes.push(finish);
    return { runId: opts.runId, capabilities: this.capabilities, ...(this.hosted && opts.host ? { detachOnShutdown: true } : {}),
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
  const tmp: TmpProfile = await createTmpProfile('resume-channel-');
  const codexHome = join(tmp.root, 'codex-home');
  await mkdir(codexHome);
  await writeFile(join(codexHome, 'config.toml'), '');
  vi.stubEnv('CLAUDE_CONFIG_DIR', join(tmp.root, 'claude-home'));
  const profile = createDefaultProfileConfig({ agentKind: 'codex',
    accounts: { app: { id: 'test', secret: 'test-secret', tenant: 'feishu' } },
    access: { allowedChats: ['oc_chat'], allowedUsers: ['owner'], admins: ['owner'] },
    codex: { binaryPath: 'codex', codexHome },
    preferences: { model: 'custom/day', reasoningEffort: 'high', messageReply: 'text', cotMessages: 'off' },
  });
  profile.workspaces.default = tmp.workspace;
  const root: RootConfig = { schemaVersion: 2, activeProfile: 'test', preferences: {}, profiles: { test: profile } };
  const freshControls = (): Controls => ({ profile: 'test', profileConfig: profile, cfg: runtimeProfileConfig(root, 'test'),
    configPath: join(tmp.root, 'config.json'), processId: 'test', botOwnerId: 'owner', ownerRefreshState: 'ok',
    async refreshOwner() {}, async restart() {}, async exit() {},
  });
  const stateDir = tmp.profile;
  const appPaths = { mediaDir: join(stateDir, 'media'), secretsFile: join(stateDir, 'secrets.json'),
    keystoreSaltFile: join(stateDir, 'keystore-salt') };
  const sessions = new SessionStore(join(stateDir, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(stateDir, 'workspaces.json'));
  const agent = new GateAgent();
  cleanup.push(async () => { await sessions.flush(); await workspaces.flush(); await tmp.cleanup(); });
  const scope = 'oc_chat:topic';
  const input = (content: string, messageId = `m-${content}`) => ({
    chatId: 'oc_chat', messageId, threadId: 'topic', chatType: 'group', senderId: 'owner',
    content, rawContentType: 'text', resources: [], mentions: [], mentionedBot: true, mentionAll: false, createTime: Date.now(),
  }) as NormalizedMessage;

  const h = {
    agent, scope, stateDir, input, freshControls, controls: freshControls(),
    journal: async () => {
      try {
        return (JSON.parse(await readFile(join(stateDir, 'interrupted-turns.json'), 'utf8')) as { turns: unknown[] }).turns;
      } catch { return []; }
    },
    /** Starts one bridge process generation over the shared profile state. */
    start: async (options: { restorePending?: boolean } = {}) => {
      const handlers: { message?: (msg: NormalizedMessage) => Promise<void>; cardAction?: (evt: CardActionEvent) => Promise<void> } = {};
      const channel = Object.assign(createFakeChannel(), {
        botIdentity: { openId: 'bot', name: 'Test' },
        on(next: typeof handlers) { Object.assign(handlers, next); }, async connect() {}, async disconnect() {},
        async getChatMode() { return 'group'; }, getConnectionStatus() { return { state: 'connected' }; },
      });
      Object.assign(channel.rawClient, { application: { v6: { application: { get: async () => ({ data: { app: { owner: { owner_id: 'owner' } } } }) } } } });
      channel.rawThreadIds.set('card', 'topic');
      sdk.channel = channel;
      const controls = h.controls;
      const bridge = await startChannel({ cfg: controls.cfg, execution: new FixedExecutionController(agent, controls.profileConfig),
        sessions, workspaces, controls, appPaths, ...options });
      let stopped = false;
      const stop = async () => { if (!stopped) { stopped = true; await bridge.disconnect(); } };
      cleanup.push(stop);
      return {
        channel, stop,
        message: (content: string) => handlers.message!(input(content, `m-${content}`)),
        click: (cmd: string, id: string) => handlers.cardAction!({
          chatId: 'oc_chat', messageId: 'card', operator: { openId: 'owner' },
          action: { value: { cmd, arg: id, settings_scope: scope } },
        } as CardActionEvent),
      };
    },
  };
  return h;
}
