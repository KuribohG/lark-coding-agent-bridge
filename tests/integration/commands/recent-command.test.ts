import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedMessage } from '@larksuite/channel';
import { ActiveRuns } from '../../../src/bot/active-runs.js';
import {
  tryHandleCommand,
  type CommandContext,
  type Controls,
} from '../../../src/commands/index.js';
import {
  createDefaultProfileConfig,
  type ProfileConfig,
} from '../../../src/config/profile-schema.js';
import { SessionCatalog } from '../../../src/session/catalog.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { createFakeAgent } from '../../helpers/fake-agent.js';
import { createFakeChannel, type FakeChannel } from '../../helpers/fake-channel.js';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile.js';

interface Harness {
  tmp: TmpProfile;
  channel: FakeChannel;
  catalog: SessionCatalog;
  activeRuns: ActiveRuns;
  controls: Controls;
  run(content: string, senderId?: string): Promise<boolean>;
}

const cleanups: Array<() => Promise<void>> = [];

describe('/recent command', () => {
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it('lists completed sessions across the profile for the owner in newest-first order', async () => {
    const h = await createHarness();
    const oldLink = messageLink('chat-1', 'thread-old', 1);
    const newLink = messageLink('chat-2', 'thread-new', 3);
    const middleLink = messageLink('chat-3', 'thread-middle', 2);
    h.channel.rawMessageLinks.set('om_old', oldLink);
    h.channel.rawMessageLinks.set('om_new', newLink);
    h.channel.rawMessageLinks.set('om_middle', middleLink);
    addSession(h.catalog, 'chat-1', 'thread-old', 'old task', 1000, 2000, {
      sourceMessageId: 'om_old',
    });
    addSession(h.catalog, 'chat-2', 'thread-new', 'new task', 3000, 5000, {
      sourceMessageId: 'om_new',
    });
    addSession(h.catalog, 'chat-3', 'thread-middle', 'middle task', 2000, 4000, {
      sourceMessageId: 'om_middle',
    });

    await expect(h.run('/recent 2')).resolves.toBe(true);

    const output = lastMarkdown(h.channel);
    expect(output).toContain('最近完成的 2 个 session（当前 profile）');
    expect(output).toContain('new task');
    expect(output).toContain('middle task');
    expect(output.indexOf('new task')).toBeLessThan(output.indexOf('middle task'));
    expect(output).toContain(`](${newLink})`);
    expect(output).toContain(`](${middleLink})`);
    expect(output).not.toContain('old task');
  });

  it('links to the exact source message when only its ID is retained', async () => {
    const h = await createHarness();
    const exact = messageLink('chat-1', 'thread-exact', 7);
    h.channel.rawMessageLinks.set('om_source', exact);
    addSession(h.catalog, 'chat-1', 'thread-exact', 'linked task', 1000, 2000, {
      sourceMessageId: 'om_source',
    });

    await expect(h.run('/recent')).resolves.toBe(true);

    expect(lastMarkdown(h.channel)).toContain(`[linked task](${exact})`);
  });

  it('falls back to a topic link for records created before source messages were stored', async () => {
    const h = await createHarness();
    addSession(h.catalog, 'oc_chat:omt_topic', 'thread-old', 'legacy task', 1000, 2000);

    await expect(h.run('/recent')).resolves.toBe(true);

    expect(lastMarkdown(h.channel)).toContain(
      '[legacy task](https://applink.feishu.cn/client/thread/open?open_chat_id=oc_chat&open_thread_id=omt_topic)',
    );
  });

  it('limits non-admin callers to the current chat or topic scope', async () => {
    const h = await createHarness();
    addSession(h.catalog, 'chat-1', 'thread-current', 'current task', 1000, 2000);
    addSession(h.catalog, 'chat-2', 'thread-other', 'other task', 3000, 4000);

    await expect(h.run('/recent', 'ou-user')).resolves.toBe(true);

    const output = lastMarkdown(h.channel);
    expect(output).toContain('current task');
    expect(output).toContain('当前会话');
    expect(output).not.toContain('other task');
  });

  it('omits scopes with a run still in progress', async () => {
    const h = await createHarness();
    addSession(h.catalog, 'chat-1', 'thread-done', 'finished task', 1000, 2000);
    addSession(h.catalog, 'chat-2', 'thread-running', 'running task', 3000, 5000);
    vi.spyOn(h.activeRuns, 'scopes').mockReturnValue(['chat-2']);

    await expect(h.run('/recent')).resolves.toBe(true);

    const output = lastMarkdown(h.channel);
    expect(output).toContain('finished task');
    expect(output).not.toContain('running task');
  });

  it('hides only the running native session, not older sessions in the same scope', async () => {
    const h = await createHarness();
    addSession(h.catalog, 'chat-1', 'thread-done', 'finished task', 1000, 2000, {
      policyFingerprint: 'fp-done',
    });
    addSession(h.catalog, 'chat-1', 'thread-running', 'running task', 3000, 4000, {
      policyFingerprint: 'fp-running',
    });
    const run = createFakeAgent().run({ runId: 'run-1', prompt: 'running' });
    h.activeRuns.register('chat-1', run);
    h.activeRuns.identifySession('chat-1', run, {
      agentId: 'codex',
      threadId: 'thread-running',
    });

    await expect(h.run('/recent')).resolves.toBe(true);

    const output = lastMarkdown(h.channel);
    expect(output).toContain('finished task');
    expect(output).not.toContain('running task');
  });

  it('does not treat an unfinished catalog entry as a completed session', async () => {
    const h = await createHarness();
    h.catalog.upsertActive({
      scopeId: 'chat-1',
      agentId: 'codex',
      cwdRealpath: '/repo',
      policyFingerprint: 'fp-1',
      threadId: 'thread-unfinished',
      now: 3000,
    });

    await expect(h.run('/recent')).resolves.toBe(true);

    expect(lastMarkdown(h.channel)).toContain('最近没有已完成的 session');
  });

  it('explains when there are no completed sessions', async () => {
    const h = await createHarness();

    await expect(h.run('/recent')).resolves.toBe(true);

    expect(lastMarkdown(h.channel)).toContain('还没有 session 记录');
  });
});

async function createHarness(): Promise<Harness> {
  const tmp = await createTmpProfile('recent-command-');
  const channel = createFakeChannel();
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const catalog = new SessionCatalog(join(tmp.profile, 'session-catalog.json'));
  const activeRuns = new ActiveRuns();
  const agent = createFakeAgent();
  const profileConfig = appConfig(tmp.workspace);
  const controls = {
    profile: 'claude',
    profileConfig,
    botOwnerId: 'ou-owner',
    ownerRefreshState: 'ok',
    async refreshOwner() {},
    restart: vi.fn(async () => {}),
    exit: vi.fn(async () => {}),
    configPath: join(tmp.profile, 'config.json'),
    cfg: profileConfig,
    processId: 'proc-1',
  } satisfies Controls;

  const run = (content: string, senderId = 'ou-owner'): Promise<boolean> =>
    tryHandleCommand({
      channel: channel as unknown as CommandContext['channel'],
      msg: message(content, senderId),
      scope: 'chat-1',
      chatMode: 'p2p',
      sessions,
      sessionCatalog: catalog,
      workspaces,
      agent,
      activeRuns,
      controls,
    });

  cleanups.push(async () => {
    vi.restoreAllMocks();
    await Promise.all([sessions.flush(), workspaces.flush(), catalog.flush()]);
    await tmp.cleanup();
  });

  return { tmp, channel, catalog, activeRuns, controls, run };
}

function addSession(
  catalog: SessionCatalog,
  scopeId: string,
  threadId: string,
  summary: string,
  startedAt: number,
  completedAt: number,
  options: {
    policyFingerprint?: string;
    sourceMessageId?: string;
  } = {},
): void {
  const identity = {
    scopeId,
    agentId: 'codex' as const,
    cwdRealpath: '/repo',
    policyFingerprint: options.policyFingerprint ?? 'fp-1',
  };
  catalog.upsertActive({ ...identity, threadId, now: startedAt });
  catalog.markCompleted({
    ...identity,
    now: completedAt,
    lastSummary: summary,
    ...(options.sourceMessageId ? { sourceMessageId: options.sourceMessageId } : {}),
  });
}

function appConfig(defaultWorkspace: string): ProfileConfig {
  const config = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: { app: { id: 'app-id', secret: 'secret', tenant: 'feishu' } },
    access: { admins: ['ou-admin'] },
  });
  config.workspaces.default = defaultWorkspace;
  return config;
}

function message(content: string, senderId: string): NormalizedMessage {
  return {
    messageId: `om-${content.replace(/\W+/g, '-')}`,
    chatId: 'chat-1',
    chatType: 'p2p',
    senderId,
    senderName: 'User',
    content,
    resources: [],
    mentions: [],
    mentionedBot: false,
  } as unknown as NormalizedMessage;
}

function lastMarkdown(channel: FakeChannel): string {
  const content = channel.sent.at(-1)?.content as { markdown?: unknown } | undefined;
  expect(content?.markdown).toBeTypeOf('string');
  return String(content?.markdown);
}

function messageLink(chatId: string, threadId: string, position: number): string {
  return 'https://applink.feishu.cn/client/thread/open'
    + `?open_chat_id=${chatId}&open_thread_id=${threadId}&thread_position=${position}`;
}
