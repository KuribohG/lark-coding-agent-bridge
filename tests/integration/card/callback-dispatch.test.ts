import type { CardActionEvent, CardActionResponse } from '@larksuite/channel';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UserQuestions } from '../../../src/bot/user-questions';
import { ActiveRuns } from '../../../src/bot/active-runs.js';
import { ChatModeCache } from '../../../src/bot/chat-mode-cache.js';
import { PendingQueue } from '../../../src/bot/pending-queue.js';
import { CallbackAuth } from '../../../src/card/callback-auth.js';
import { CallbackNonceStore } from '../../../src/card/callback-store.js';
import { handleCardAction } from '../../../src/card/dispatcher.js';
import type { Controls } from '../../../src/commands/index.js';
import { CommandRegistry } from '../../../src/commands/index.js';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { FakeAgentAdapter, type FakeAgentRun } from '../../helpers/fake-agent.js';
import { createFakeChannel, type FakeChannel } from '../../helpers/fake-channel.js';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile.js';

const cleanups: Array<() => Promise<void>> = [];

describe('signed card callback dispatch', () => {
  it('routes question forms by the carrier topic even after the run has ended', async () => {
    const response = { card: { type: 'raw', data: { schema: '2.0', body: { elements: [] } } } };
    const answer = vi.fn(async () => response);
    const h = await createHarness({ chatMode: 'topic', userQuestions: { answer } as unknown as UserQuestions });
    h.channel.rawThreadIds.set('om_card', 'th_topic');
    expect(await h.dispatch({ cmd: 'question.answer', question_id: 'q', choice: 'text', bridge_token: 'checked-by-question-handler' }, { answer: 'my answer' })).toEqual(response);
    expect(answer).toHaveBeenCalledWith(expect.objectContaining({ scope: 'oc_group:th_topic', formValue: { answer: 'my answer' } }));
    expect(h.pending.cancel('oc_group:th_topic')).toHaveLength(0);
  });
  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it.each(['chat', 'carrier'] as const)('responds before a slow %s lookup and still enforces callback authorization', async lookup => {
    const h = await createHarness({ chatMode: 'topic' });
    h.channel.rawThreadIds.set('om_card', 'th_topic');
    h.activeRuns.register('oc_group:th_topic', h.agent.run({ runId: 'run-active', prompt: 'running' }));
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const spy = lookup === 'chat'
      ? vi.spyOn(h.chatModeCache, 'resolve').mockImplementation(async () => { await gate; return 'topic'; })
      : vi.spyOn(h.channel, 'fetchRawMessage').mockImplementation(async () => { await gate; return [{ thread_id: 'th_topic' }]; });
    vi.useFakeTimers();
    const response = h.dispatch({
      __bridge_cb: true,
      bridge_token: h.token('agent_callback', { nonce: `slow-${lookup}`, scope: 'oc_group:th_topic' }),
      choice: 'a',
    });
    await vi.advanceTimersByTimeAsync(500);
    expect(await response).toMatchObject({ toast: { type: 'info' } });
    expect(h.pending.cancel('oc_group:th_topic')).toHaveLength(0);
    release();
    vi.useRealTimers();
    await vi.waitFor(() => expect(h.pending.hasWork('oc_group:th_topic')).toBe(true));
    expect(h.pending.cancel('oc_group:th_topic')).toHaveLength(1);
    spy.mockRestore();
    await h.dispatch({ __bridge_cb: true, bridge_token: 'invalid', choice: 'b' });
    expect(h.pending.cancel('oc_group:th_topic')).toHaveLength(0);
  });

  it('reports a question failure after the early response in the original topic', async () => {
    let fail!: (error: Error) => void;
    const answer = vi.fn(() => new Promise<void>((_resolve, reject) => { fail = reject; }));
    const h = await createHarness({ chatMode: 'topic', userQuestions: { answer } as unknown as UserQuestions });
    h.channel.rawThreadIds.set('om_card', 'th_topic');
    vi.useFakeTimers();
    const response = h.dispatch({ cmd: 'question.answer', question_id: 'q', choice: 0 });
    await vi.advanceTimersByTimeAsync(500);
    expect(await response).toMatchObject({ toast: { type: 'info' } });
    // Workspace identity resolution may still be awaiting filesystem IO.
    vi.useRealTimers();
    await vi.waitFor(() => expect(answer).toHaveBeenCalledOnce());
    fail(new Error('input transport failed'));
    await vi.waitFor(() => expect(h.channel.sent).toHaveLength(1));
    expect(h.channel.sent[0]).toMatchObject({
      chatId: 'oc_group', content: { markdown: expect.stringContaining('未能确认完成') },
      options: { replyTo: 'om_card', replyInThread: true },
    });
  });

  it('dispatches native inbox actions with carrier topic context and no active agent run', async () => {
    const h = await createHarness({ chatMode: 'topic', callbackAuth: false });
    h.channel.rawThreadIds.set('om_card', 'omt_topic');
    const command = vi.fn(async (_args: string, _ctx: unknown) => {});
    h.controls.commands = new CommandRegistry([{
      pluginId: 'test-inbox',
      definition: {
        name: 'inbox',
        access: 'user',
        pending: 'preserve',
        arguments: 'words',
        help: ['`/inbox` — test'],
      },
      handler: async (args, ctx) => {
        await command(args, {
          profile: ctx.controls.profile,
          operator: ctx.msg.senderId,
          chatId: ctx.msg.chatId,
          threadId: ctx.msg.threadId,
          messageId: ctx.msg.messageId,
        });
      },
    }]);
    await h.dispatch({ cmd: 'inbox.action', arg: 'choose encoded signed-action' });
    expect(command).toHaveBeenCalledWith('action choose encoded signed-action', {
      profile: 'claude', operator: 'ou_operator', chatId: 'oc_group', threadId: 'omt_topic', messageId: 'om_card',
    });
    expect(h.pending.cancel('oc_group:omt_topic')).toHaveLength(0);
  });

  it('runs built-in command callbacks only when the bridge token verifies', async () => {
    const h = await createHarness();
    const activeRun = h.agent.run({ runId: 'run-active', prompt: 'running' }) as FakeAgentRun;
    h.activeRuns.register('oc_group', activeRun);

    await h.dispatch({
      cmd: 'stop',
      __bridge_cb: true,
      bridge_token: h.token('stop'),
    });

    expect(activeRun.stopped).toBe(true);

    const deniedRun = h.agent.run({ runId: 'run-active', prompt: 'running' }) as FakeAgentRun;
    h.activeRuns.register('oc_group', deniedRun);
    await h.dispatch({
      cmd: 'stop',
      __bridge_cb: true,
      bridge_token: h.token('stop', { operatorOpenId: 'ou_other' }),
    });

    expect(deniedRun.stopped).toBe(false);
  });

  it('forwards signed bridge callbacks without leaking auth fields into the agent payload', async () => {
    const h = await createHarness();
    const activeRun = h.agent.run({ runId: 'run-active', prompt: 'running' });
    h.activeRuns.register('oc_group', activeRun);

    await h.dispatch(
      {
        __bridge_cb: true,
        bridge_token: h.token('agent_callback', { nonce: 'nonce-agent' }),
        choice: 'a',
      },
      { note: 'from form' },
    );

    const queued = h.pending.cancel('oc_group');
    expect(queued).toHaveLength(1);
    expect(queued[0]?.content).toBe('[card-click] {"choice":"a","form_value":{"note":"from form"}}');
    expect(queued[0]?.chatType).toBe('group');
  });

  it('drops legacy Claude callback markers before command dispatch', async () => {
    const h = await createHarness();
    const activeRun = h.agent.run({ runId: 'run-active', prompt: 'running' }) as FakeAgentRun;
    h.activeRuns.register('oc_group', activeRun);

    await h.dispatch({
      __claude_cb: true,
      cmd: 'stop',
    });

    expect(activeRun.stopped).toBe(false);
    expect(h.pending.cancel('oc_group')).toHaveLength(0);
  });

  it('scopes topic-group callbacks by the carrier message thread_id', async () => {
    const h = await createHarness({ chatMode: 'topic' });
    // The dispatcher must read items[0].thread_id from the raw message get to
    // compose the `${chatId}:${threadId}` scope. A regression here (e.g. using
    // channel.fetchMessage, whose normalized shape drops thread_id) would fall
    // back to the bare chatId and route the click into the wrong session.
    h.channel.rawThreadIds.set('om_card', 'th_topic');
    h.activeRuns.register('oc_group:th_topic', h.agent.run({ runId: 'run-active', prompt: 'running' }));

    await h.dispatch({
      __bridge_cb: true,
      bridge_token: h.token('agent_callback', { nonce: 'nonce-topic', scope: 'oc_group:th_topic' }),
      choice: 'a',
    });

    expect(h.pending.cancel('oc_group')).toHaveLength(0);
    const queued = h.pending.cancel('oc_group:th_topic');
    expect(queued).toHaveLength(1);
    expect(queued[0]?.content).toBe('[card-click] {"choice":"a"}');
  });

  it('rejects bridge callbacks when callback auth is unavailable', async () => {
    const h = await createHarness({ callbackAuth: false });
    const activeRun = h.agent.run({ runId: 'run-active', prompt: 'running' }) as FakeAgentRun;
    h.activeRuns.register('oc_group', activeRun);

    await h.dispatch({
      __bridge_cb: true,
      choice: 'unsafe',
    });

    expect(activeRun.stopped).toBe(false);
    expect(h.pending.cancel('oc_group')).toHaveLength(0);
  });
});

type Harness = {
  tmp: TmpProfile;
  channel: FakeChannel;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  activeRuns: ActiveRuns;
  agent: FakeAgentAdapter;
  controls: Controls;
  chatModeCache: ChatModeCache;
  pending: PendingQueue;
  auth: CallbackAuth;
  dispatch(value: Record<string, unknown>, formValue?: Record<string, unknown>): Promise<CardActionResponse | void>;
  token(
    action: string,
    overrides?: { operatorOpenId?: string; nonce?: string; scope?: string },
  ): string;
};

async function createHarness(
  opts: { callbackAuth?: boolean; chatMode?: 'p2p' | 'group' | 'topic'; userQuestions?: UserQuestions } = {},
): Promise<Harness> {
  const tmp = await createTmpProfile('callback-dispatch-test-');
  const channel = createFakeChannel();
  const sessions = new SessionStore(`${tmp.profile}/sessions.json`);
  const workspaces = new WorkspaceStore(`${tmp.profile}/workspaces.json`);
  const activeRuns = new ActiveRuns();
  const agent = new FakeAgentAdapter();
  const pending = new PendingQueue(60_000, () => {});
  const store = new CallbackNonceStore(`${tmp.profile}/callback-nonces.json`);
  const controls = {
    profile: 'claude',
    profileConfig: createDefaultProfileConfig({
      agentKind: 'claude',
      accounts: { app: { id: 'app-id', secret: 'secret', tenant: 'feishu' } },
      access: { allowedChats: ['oc_group'] },
    }),
    botOwnerId: 'ou_owner',
    ownerRefreshState: 'ok',
    async refreshOwner() {},
    async restart() {},
    async exit() {},
    configPath: `${tmp.profile}/config.json`,
    cfg: createDefaultProfileConfig({
      agentKind: 'claude',
      accounts: { app: { id: 'app-id', secret: 'secret', tenant: 'feishu' } },
      access: { allowedChats: ['oc_group'] },
    }),
    processId: 'proc-1',
  } satisfies Controls;
  let nonce = 'nonce-stop';
  const auth = new CallbackAuth({
    keys: [{ version: 1, secret: 'secret-1' }],
    nonceStore: store,
    now: () => 1000,
    createNonce: () => nonce,
  });
  const chatModeCache = new ChatModeCache();
  chatModeCache.resolve = async () => opts.chatMode ?? 'group';
  cleanups.push(async () => {
    pending.cancelAll();
    await Promise.all([sessions.flush(), workspaces.flush(), store.flush()]);
    await tmp.cleanup();
  });

  return {
    tmp,
    channel,
    sessions,
    workspaces,
    activeRuns,
    agent,
    controls,
    chatModeCache,
    pending,
    auth,
    token: (action, overrides = {}) => {
      nonce = overrides.nonce ?? `nonce-${action}`;
      return auth.sign({
        runId: 'run-active',
        scope: overrides.scope ?? 'oc_group',
        chatId: 'oc_group',
        operatorOpenId: overrides.operatorOpenId ?? 'ou_operator',
        action,
        policyFingerprint: 'fp-1',
        ttlMs: 60_000,
      });
    },
    dispatch: (value, formValue) =>
      handleCardAction({
        channel: channel as unknown as Parameters<typeof handleCardAction>[0]['channel'],
        evt: cardEvent(value, formValue),
        sessions,
        workspaces,
        activeRuns,
        agent,
        controls,
        pending,
        chatModeCache,
        ...(opts.callbackAuth === false ? {} : { callbackAuth: auth }),
        callbackPolicyFingerprint: 'fp-1',
        userQuestions: opts.userQuestions,
      }),
  };
}

function cardEvent(
  value: Record<string, unknown>,
  formValue?: Record<string, unknown>,
): CardActionEvent {
  return {
    action: { value },
    chatId: 'oc_group',
    messageId: 'om_card',
    operator: {
      openId: 'ou_operator',
      name: 'Operator',
    },
    raw: formValue ? { action: { form_value: formValue } } : undefined,
  } as unknown as CardActionEvent;
}
