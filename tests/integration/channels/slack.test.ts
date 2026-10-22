import { afterEach, describe, expect, it } from 'vitest';
import type { AgentEvent } from '../../../src/agent/types';
import type { RunProfileConfig } from '../../../src/config/profile-schema';
import { createSlackPlugin } from '../../../src/channels/slack/plugin';
import type {
  SlackApi,
  SlackAuthIdentity,
  SlackReactionInput,
  SlackUpdateMessageInput,
} from '../../../src/channels/slack/api';
import type {
  SlackEventEnvelope,
  SlackEventHandler,
  SlackMessageEvent,
  SlackTransport,
  SlackTransportErrorHandler,
} from '../../../src/channels/slack/transport';
import { FakeAgentAdapter } from '../../helpers/fake-agent';
import { createTmpProfile } from '../../helpers/tmp-profile';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

class FakeSlackApi implements SlackApi {
  readonly posts: Array<{ channel: string; text: string; threadTs: string }> = [];
  readonly updates: SlackUpdateMessageInput[] = [];
  readonly reactions: SlackReactionInput[] = [];
  readonly removedReactions: SlackReactionInput[] = [];
  private nextTs = 1;

  async authTest(): Promise<SlackAuthIdentity> {
    return { teamId: 'T1', userId: 'UBOT', userName: 'bridge' };
  }

  async postMessage(input: { channel: string; text: string; threadTs: string }): Promise<string> {
    this.posts.push(input);
    return `${this.nextTs++}.000`;
  }

  async updateMessage(input: SlackUpdateMessageInput): Promise<void> {
    this.updates.push(input);
  }

  async addReaction(input: SlackReactionInput): Promise<void> {
    this.reactions.push(input);
  }

  async removeReaction(input: SlackReactionInput): Promise<void> {
    this.removedReactions.push(input);
  }
}

class FakeSlackTransport implements SlackTransport {
  private readonly handlers = new Map<string, SlackEventHandler[]>();
  private errorHandler: SlackTransportErrorHandler | undefined;

  onEvent(type: SlackMessageEvent['type'], handler: SlackEventHandler): void {
    const current = this.handlers.get(type) ?? [];
    current.push(handler);
    this.handlers.set(type, current);
  }

  onError(handler: SlackTransportErrorHandler): void {
    this.errorHandler = handler;
  }

  async start(): Promise<void> {}

  async close(): Promise<void> {}

  async emit(input: SlackEventEnvelope): Promise<void> {
    const handlers = this.handlers.get(input.event.type) ?? [];
    if (handlers.length === 0) throw Error(`missing handler for ${input.event.type}`);
    for (const handler of handlers) {
      try {
        await handler(input);
      } catch (error) {
        this.errorHandler?.(error);
        throw error;
      }
    }
  }
}

function config(workspace: string): RunProfileConfig {
  return {
    agentKind: 'claude',
    preferences: { maxConcurrentRuns: 1 },
    workspaces: { default: workspace },
    permissions: { defaultAccess: 'workspace', maxAccess: 'workspace' },
    access: { allowedUsers: [], allowedChats: [], admins: [], requireMentionInGroup: false },
    attachments: {
      maxCount: 0,
      maxBytes: 0,
      maxFileBytes: 0,
      imageMaxBytes: 0,
      cacheTtlMs: 0,
      cacheMaxBytes: 0,
    },
  };
}

async function harness(events: AgentEvent[][], showProgress = true) {
  const tmp = await createTmpProfile('bridge-slack-');
  cleanups.push(tmp.cleanup);
  const agent = new FakeAgentAdapter({ id: 'claude', events });
  const api = new FakeSlackApi();
  const transport = new FakeSlackTransport();
  const plugin = createSlackPlugin({
    agent,
    config: config(tmp.workspace),
    stateDir: tmp.profile,
    namespace: 'test',
    systemPrompt: 'Slack test prompt',
    allowedUsers: ['U1'],
    allowedChannels: ['C1'],
    display: { show_progress: showProgress },
    api,
    transport,
    progressIntervalMs: 0,
  });
  const connection = await plugin.connect();
  cleanups.push(() => connection.close());
  return { tmp, agent, api, transport, connection };
}

function channelEvent(input: Partial<SlackMessageEvent> & Pick<SlackMessageEvent, 'type' | 'ts'>): SlackEventEnvelope {
  return {
    teamId: 'T1',
    eventId: `evt-${input.type}-${input.ts}`,
    event: {
      channel: 'C1',
      channel_type: 'channel',
      user: 'U1',
      text: '<@UBOT> hello',
      ...input,
    },
  };
}

describe('Slack channel plugin', () => {
  it('accepts a mention after its ordinary event and tracks an existing thread', async () => {
    const h = await harness([
      [{ type: 'system', sessionId: 'existing-thread' }, { type: 'done', terminationReason: 'normal' }],
      [{ type: 'done', terminationReason: 'normal' }],
    ]);
    const message = { ts: '90.002', thread_ts: '90.001' };
    await h.transport.emit(channelEvent({ ...message, type: 'message' }));
    expect(h.agent.runOptions).toHaveLength(0);
    await h.transport.emit(channelEvent({ ...message, type: 'app_mention' }));
    await h.transport.emit(channelEvent({ ...message, type: 'message' }));
    expect(h.agent.runOptions).toHaveLength(1);
    await h.transport.emit(channelEvent({ type: 'message', ts: '90.003', thread_ts: '90.001', text: 'continue' }));
    expect(h.agent.runOptions).toHaveLength(2);
    expect(h.agent.runOptions[1]?.sessionId).toBe('existing-thread');
    expect(h.api.posts.every(post => post.threadTs === '90.001')).toBe(true);
  });

  it('starts a thread conversation, resumes it without another mention, and keeps progress in-place', async () => {
    const h = await harness([
      [
        { type: 'system', sessionId: 'session-one' },
        { type: 'text', delta: 'working' },
        { type: 'final_text', content: '**first answer**' },
        { type: 'done', terminationReason: 'normal' },
      ],
      [
        { type: 'system', sessionId: 'session-one' },
        { type: 'final_text', content: 'second answer' },
        { type: 'done', terminationReason: 'normal' },
      ],
    ]);
    expect(h.connection).toMatchObject({ teamId: 'T1', botUserId: 'UBOT' });

    await h.transport.emit(channelEvent({ type: 'app_mention', ts: '100.001' }));
    expect(h.agent.runOptions[0]?.prompt).toBe('hello');
    expect(h.agent.runOptions[0]?.systemPrompt).toBe('Slack test prompt');
    expect(h.api.posts.at(-1)?.threadTs).toBe('100.001');
    expect(h.api.updates.at(-1)?.text).toContain('*first answer*');
    expect(h.api.reactions).toContainEqual({ channel: 'C1', timestamp: '100.001', name: 'eyes' });
    expect(h.api.removedReactions).toContainEqual({ channel: 'C1', timestamp: '100.001', name: 'eyes' });

    await h.transport.emit(channelEvent({
      type: 'message',
      ts: '100.002',
      thread_ts: '100.001',
      text: 'continue',
    }));
    expect(h.agent.runOptions[1]?.sessionId).toBe('session-one');
    expect(h.agent.runOptions[1]?.prompt).toBe('continue');
    expect(h.api.updates.at(-1)?.text).toContain('second answer');
  });

  it('deduplicates retries, enforces access, and resets the current thread session', async () => {
    const h = await harness([
      [
        { type: 'system', sessionId: 'session-reset' },
        { type: 'final_text', content: 'first' },
        { type: 'done', terminationReason: 'normal' },
      ],
      [
        { type: 'final_text', content: 'fresh' },
        { type: 'done', terminationReason: 'normal' },
      ],
    ]);
    const first = channelEvent({ type: 'app_mention', ts: '200.001' });
    await h.transport.emit(first);
    await h.transport.emit(first);
    expect(h.agent.runOptions).toHaveLength(1);

    await h.transport.emit(channelEvent({
      type: 'message',
      ts: '200.002',
      thread_ts: '200.001',
      text: '/new',
    }));
    expect(h.api.posts.at(-1)?.text).toContain('new session');

    await h.transport.emit(channelEvent({
      type: 'message',
      ts: '200.003',
      thread_ts: '200.001',
      text: 'after reset',
    }));
    expect(h.agent.runOptions[1]?.sessionId).toBeUndefined();

    const denied = channelEvent({
      type: 'app_mention',
      ts: '300.001',
      user: 'U2',
      text: '<@UBOT> secret',
    });
    await h.transport.emit(denied);
    expect(h.agent.runOptions).toHaveLength(2);
    expect(h.api.posts.at(-1)?.text).toContain('not allowed');
  });

  it('reports status and ignores unknown channel messages', async () => {
    const h = await harness([]);
    await h.transport.emit(channelEvent({
      type: 'message',
      ts: '400.001',
      thread_ts: '400.000',
      text: 'not part of a bridge thread',
    }));
    expect(h.agent.runOptions).toHaveLength(0);

    await h.transport.emit(channelEvent({ type: 'app_mention', ts: '400.002' }));
    await h.transport.emit(channelEvent({
      type: 'message',
      ts: '400.003',
      thread_ts: '400.002',
      text: '/status',
    }));
    expect(h.api.posts.at(-1)?.text).toContain('*Engine:* claude');
    expect(h.api.posts.at(-1)?.text).toContain('*State:* idle');
  });

  it('can suppress intermediate messages while retaining the final answer', async () => {
    const h = await harness([[
      { type: 'text', delta: 'intermediate' },
      { type: 'final_text', content: 'final only' },
      { type: 'done', terminationReason: 'normal' },
    ]], false);
    await h.transport.emit(channelEvent({ type: 'app_mention', ts: '500.001' }));

    expect(h.api.posts).toHaveLength(1);
    expect(h.api.posts[0]?.text).toContain('final only');
    expect(h.api.posts[0]?.text).not.toContain('intermediate');
  });
});
