import type { CardActionEvent, CardActionResponse, NormalizedMessage } from '@larksuite/channel';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../../../src/agent/types.js';
import type { FakeAgentEvents } from '../../helpers/fake-agent.js';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema.js';
import { log } from '../../../src/core/logger.js';
import { CotClient } from '../../../src/bot/cot.js';
import { UserQuestions } from '../../../src/bot/user-questions.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { FakeAgentAdapter } from '../../helpers/fake-agent.js';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile.js';

const sdkMock = vi.hoisted(() => ({
  channel: undefined as FakeLarkChannel | undefined,
  createLarkChannel: vi.fn(() => {
    if (!sdkMock.channel) throw new Error('fake channel not configured');
    return sdkMock.channel;
  }),
}));

vi.mock('@larksuite/channel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@larksuite/channel')>();
  return {
    ...actual,
    createLarkChannel: sdkMock.createLarkChannel,
  };
});

import { startChannel } from '../../../src/bot/channel.js';

interface MessageHandlerMap {
  message?: (msg: NormalizedMessage) => Promise<void> | void;
  cardAction?: (evt: CardActionEvent) => Promise<CardActionResponse | void>;
}

interface FakeLarkChannel {
  botIdentity: { openId: string; name: string };
  handlers: MessageHandlerMap;
  sent: Array<{ chatId: string; content: unknown; options?: unknown }>;
  rawClient: {
    request: ReturnType<typeof vi.fn>;
    application: {
      v6: {
        application: {
          get: ReturnType<typeof vi.fn>;
        };
      };
    };
    im: {
      v1: {
        message: {
          get: ReturnType<typeof vi.fn>;
        };
        messageReaction: {
          create: ReturnType<typeof vi.fn>;
          delete: ReturnType<typeof vi.fn>;
        };
      };
    };
  };
  on(handlers: MessageHandlerMap): void;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getChatMode(chatId: string): Promise<'group' | 'topic'>;
  getConnectionStatus(): { state: 'connected'; reconnectAttempts: number };
  send(chatId: string, content: unknown, options?: unknown): Promise<{ messageId: string }>;
  stream(chatId: string, input: unknown, options?: unknown): Promise<void>;
  addReaction(messageId: string, emojiType: string): Promise<string>;
  removeReaction(messageId: string, reactionId: string): Promise<void>;
}

type StreamFn = FakeLarkChannel['stream'];
type SendFn = FakeLarkChannel['send'];

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  sdkMock.channel = undefined;
  sdkMock.createLarkChannel.mockClear();
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('markdown stream startup failures', () => {
  it('returns a question confirmation through the registered SDK callback', async () => {
    const response = { card: { type: 'raw', data: { schema: '2.0', body: { elements: [] } } } };
    const answer = vi.spyOn(UserQuestions.prototype, 'answer').mockResolvedValue(response);
    const h = await createHarness();
    h.profileConfig.access.allowedChats.push('oc_group');
    await startTestBridge(h);
    const result = await h.channel.handlers.cardAction?.({ chatId: 'oc_group', messageId: 'om_question',
      operator: { openId: 'ou_user' }, action: { value: { cmd: 'question.answer' } },
    } as CardActionEvent);
    expect(answer).toHaveBeenCalledOnce();
    expect(result).toEqual(response);
  });
  it('uses native COT by default and sends the final answer separately', async () => {
    const create = vi.spyOn(CotClient.prototype, 'create').mockResolvedValue({ cot_id: 'cot_test', message_id: 'om_cot' });
    const update = vi.spyOn(CotClient.prototype, 'update').mockResolvedValue(undefined);
    vi.spyOn(CotClient.prototype, 'complete').mockResolvedValue(undefined);
    const stream = vi.fn(async () => {});
    const h = await createHarness({ stream, events: [
      { type: 'text', delta: 'COT_PROGRESS' },
      { type: 'tool_use', id: 'tool_1', name: 'Bash', input: { command: 'pwd' } },
      { type: 'tool_result', id: 'tool_1', output: '/workspace', isError: false },
      { type: 'final_text', content: 'FINAL_WITH_COT' },
      { type: 'done', terminationReason: 'normal' },
    ] });
    delete h.profileConfig.preferences.cotMessages;
    await startTestBridge(h);
    await h.channel.handlers.message?.(message('om_default_cot', 'run'));
    await waitFor(() => h.channel.sent.length === 1);

    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith('oc_dm', 'om_default_cot');
    const events = update.mock.calls.flatMap(call => call[1]);
    expect(JSON.stringify(events)).toContain('COT_PROGRESS');
    expect(events.some(event => event.event_type === 'TOOL_CALL_START')).toBe(true);
    expect(events.some(event => event.event_type === 'TOOL_CALL_ARGS')).toBe(false);
    expect(stream).not.toHaveBeenCalled();
    expect(lastMarkdown(h.channel)).toContain('FINAL_WITH_COT');
  });

  it.each(['rejected', 'missing-ids', 'notice-failed'] as const)('notifies once on initial COT creation failure and preserves the final answer (%s)', async failure => {
    const create = vi.spyOn(CotClient.prototype, 'create');
    if (failure === 'missing-ids') create.mockResolvedValue({});
    else create.mockRejectedValue(new Error('fetch failed'));
    const update = vi.spyOn(CotClient.prototype, 'update');
    const visible: string[] = [];
    const h = await createHarness({
      events: [
        { type: 'text', delta: 'FALLBACK_PROGRESS' },
        { type: 'final_text', content: 'FINAL_AFTER_CREATE_FAILURE' },
        { type: 'done', terminationReason: 'normal' },
      ],
      send: async (_chatId, content) => {
        if (failure === 'notice-failed' && JSON.stringify(content).includes('COT 过程消息创建失败')) {
          throw new Error('notice delivery failed');
        }
        return { messageId: 'om_sent' };
      },
      stream: async (_chatId, input) => {
        await (input as { markdown(ctrl: { setContent(value: string): Promise<void> }): Promise<void> })
          .markdown({ setContent: async value => { visible.push(value); } });
      },
    });
    delete h.profileConfig.preferences.cotMessages;
    h.profileConfig.access.allowedChats = ['oc_topic'];
    await startTestBridge(h);
    await h.channel.handlers.message?.({ ...message('om_create_failure', 'run'),
      chatType: 'group', chatId: 'oc_topic', mentionedBot: true, threadId: 'omt_test' });
    await waitFor(() => h.channel.sent.some(m => JSON.stringify(m.content).includes('FINAL_AFTER_CREATE_FAILURE')));

    expect(create).toHaveBeenCalledTimes(1);
    expect(update).not.toHaveBeenCalled();
    const notices = h.channel.sent.filter(m => JSON.stringify(m.content).includes('COT 过程消息创建失败'));
    expect(notices).toHaveLength(1);
    expect(JSON.stringify(notices[0]?.content)).toContain('异常回退');
    expect(notices[0]?.options).toMatchObject({ replyTo: 'om_create_failure', replyInThread: true });
    expect(visible.join('\n')).toContain('FALLBACK_PROGRESS');
    expect(lastMarkdown(h.channel)).toContain('FINAL_AFTER_CREATE_FAILURE');
    expect(h.agent.runs[0]?.stopped).toBe(false);
  });

  it.each(['text', 'markdown', 'card'] as const)('delivers an async question before completion in %s mode', async messageReply => {
    const finished = deferred<void>();
    const h = await createHarness({ events: [], messageReply });
    const spawn = h.agent.run.bind(h.agent);
    h.agent.run = options => {
      const raw = spawn(options);
      return { runId: raw.runId, capabilities: raw.capabilities, waitForExit: raw.waitForExit.bind(raw),
        stop: async () => { finished.resolve(undefined); await raw.stop(); },
        events: { async *[Symbol.asyncIterator](): AsyncGenerator<AgentEvent> {
          yield { type: 'user_input', id: 'q', threadId: 'codex-thread', questions: [{ title: 'QUESTION_WHILE_RUNNING', options: ['A', 'B'] }] };
          await finished.promise;
          yield { type: 'final_text', content: 'FINAL_AFTER_QUESTION' };
          yield { type: 'done', terminationReason: 'normal' };
        } },
      };
    };
    await startTestBridge(h);
    await h.channel.handlers.message?.(message('om_question', 'run'));
    try {
      // The test channel has no CardKit API, exercising the visible text fallback.
      await waitFor(() => h.channel.sent.some(m => JSON.stringify(m.content).includes('QUESTION_WHILE_RUNNING')));
      expect(JSON.stringify(h.channel.sent)).not.toContain('FINAL_AFTER_QUESTION');
      expect(h.channel.sent[0]?.options).toMatchObject({ replyTo: 'om_question' });
      expect(h.agent.runs[0]?.stopped).toBe(false);
      finished.resolve(undefined);
      await waitFor(() => h.channel.sent.some(m => JSON.stringify(m.content).includes('FINAL_AFTER_QUESTION')));
    } finally { finished.resolve(undefined); }
  });

  it.each([false, true])('silently falls back on COT update failure during backoff and preserves retry execution (fallback fails: %s)', async failFallback => {
    vi.spyOn(CotClient.prototype, 'create').mockResolvedValue({ cot_id: 'cot_test', message_id: 'om_cot' });
    vi.spyOn(CotClient.prototype, 'update').mockRejectedValue(new Error('COT update timed out'));
    vi.spyOn(CotClient.prototype, 'complete').mockResolvedValue(undefined);
    const resumed = deferred<void>();
    const finished = deferred<void>();
    const visible: string[] = [];
    const streams: unknown[] = [];
    const h = await createHarness({ events: [], stream: async (_chatId, input, options) => {
      streams.push(options);
      if (failFallback) throw new Error('fallback connection failed');
      await (input as { markdown(ctrl: { setContent(value: string): Promise<void> }): Promise<void> })
        .markdown({ setContent: async value => { visible.push(value); } });
    } });
    h.profileConfig.preferences.cotMessages = 'brief';
    const spawn = h.agent.run.bind(h.agent);
    h.agent.run = options => {
      const raw = spawn(options);
      return { runId: raw.runId, capabilities: raw.capabilities, waitForExit: raw.waitForExit.bind(raw),
        stop: async () => { resumed.resolve(undefined); finished.resolve(undefined); await raw.stop(); },
        events: { async *[Symbol.asyncIterator](): AsyncGenerator<AgentEvent> {
          yield { type: 'retry', attempt: 2, maxAttempts: 3, delayMs: 60_000 };
          await resumed.promise;
          yield { type: 'retry', attempt: 2, maxAttempts: 3, delayMs: 0 };
          yield { type: 'text', delta: 'WORK_RESUMED' };
          await finished.promise;
          yield { type: 'final_text', content: 'FINAL_AFTER_RETRY' };
          yield { type: 'done', terminationReason: 'normal' };
        } },
      };
    };
    await startTestBridge(h);
    await h.channel.handlers.message?.(message('om_retry_visibility', 'run'));
    try {
      await waitFor(() => streams.length === 1);
      expect(h.channel.sent).toHaveLength(0);
      expect(streams[0]).toMatchObject({ replyTo: 'om_retry_visibility' });
      if (!failFallback) expect(visible.join('\n')).toContain('60 秒后自动重试（2/3）');
      resumed.resolve(undefined);
      if (!failFallback) {
        await waitFor(() => visible.some(value => value.includes('WORK_RESUMED')));
        expect(visible.join('\n')).toContain('正在自动重试（2/3）');
      }
      finished.resolve(undefined);
      await waitFor(() => h.channel.sent.some(m => JSON.stringify(m.content).includes('FINAL_AFTER_RETRY')));
      expect(h.channel.sent).toHaveLength(1);
      expect(h.channel.sent.filter(m => JSON.stringify(m.content).includes('FINAL_AFTER_RETRY'))).toHaveLength(1);
      expect(visible.join('\n')).not.toContain('FINAL_AFTER_RETRY');
      expect(h.agent.runs[0]?.stopped).toBe(false);
    } finally {
      resumed.resolve(undefined);
      finished.resolve(undefined);
    }
  });

  const fileLinks = [{ localRoot: '/exports', fileBaseUrl: 'https://example.com/files/', browseBaseUrl: 'https://example.com/tree/' }];
  it.each(['claude', 'codex'] as const)('maps %s replies in every mode, including stream failure fallback', async agentKind => {
    for (const messageReply of ['text', 'markdown', 'card'] as const) {
      for (const failStream of [false, true]) {
        const visible: string[] = [];
        const content = '[report](/exports/report.html)';
        const h = await createHarness({ agentKind, messageReply,
          events: agentKind === 'codex' ? [
            { type: 'text', delta: content },
            { type: 'final_text', content },
            { type: 'done', terminationReason: 'normal' },
          ] : [{ type: 'text', delta: content }, { type: 'done', terminationReason: 'normal' }],
          stream: async (_chatId, input) => {
            if (failStream) throw new Error('test stream failure');
            const callbacks = input as {
              markdown?: (ctrl: { setContent(value: string): Promise<void> }) => Promise<void>;
              card?: { producer: (ctrl: { update(value: unknown): Promise<void> }) => Promise<void> };
            };
            await callbacks.markdown?.({ setContent: async value => { visible.push(value); } });
            await callbacks.card?.producer({ update: async value => { visible.push(JSON.stringify(value)); } });
          },
        });
        h.profileConfig.preferences.fileLinks = fileLinks;
        await startTestBridge(h);
        await h.channel.handlers.message?.(message('om_links', 'run'));
        await waitFor(() => [...visible, ...h.channel.sent.map(v => JSON.stringify(v.content))]
          .some(v => v.includes('https://example.com/files/report.html')));
        if (agentKind === 'codex' || messageReply === 'text' || failStream) {
          await waitFor(() => h.channel.sent.length > 0);
          expect(JSON.stringify(h.channel.sent.at(-1)?.content)).toContain('https://example.com/files/report.html');
        }
      }
    }
  }, 30000);

  it.each(['text', 'markdown', 'card'] as const)('uses run output semantics even when the profile name differs (%s)', async messageReply => {
    const h = await createHarness({ agentKind: 'claude', finalAnswer: 'separate-event', messageReply,
      events: [{ type: 'text', delta: 'progress' }, { type: 'final_text', content: 'contract final' }, { type: 'done', terminationReason: 'normal' }],
      stream: async () => { throw new Error('test stream failure'); },
    });
    await startTestBridge(h);
    await h.channel.handlers.message?.(message('om_contract', 'run'));
    await waitFor(() => h.channel.sent.some(sent => JSON.stringify(sent.content).includes('contract final')));
    expect(h.channel.sent).toHaveLength(1);
    expect(JSON.stringify(h.channel.sent[0]?.content)).not.toContain('progress');
  });

  it('does not leave the IM queue blocked when the agent exits before stream producer starts', async () => {
    const h = await createHarness();
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_first', 'first'));
    await waitFor(() => h.agent.runOptions.length === 1);

    await h.channel.handlers.message?.(message('om_second', 'second'));
    await waitFor(() => h.agent.runOptions.length === 2);

    expect(h.channel.rawClient.im.v1.messageReaction.delete).toHaveBeenCalledWith(
      expect.objectContaining({
        path: { message_id: 'om_first', reaction_id: 'reaction_1' },
      }),
    );
    expect(lastMarkdown(h.channel)).toContain('agent 失败');
    expect(lastMarkdown(h.channel)).toContain('codex exited with code 1');
  });

  it('does not wait for the working reaction before draining a failed agent run', async () => {
    const reaction = deferred<{ data: { reaction_id: string } }>();
    const h = await createHarness({
      reactionCreate: () => reaction.promise,
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_first', 'first'));
    await waitFor(() => h.agent.runOptions.length === 1);

    await h.channel.handlers.message?.(message('om_second', 'second'));
    await waitFor(() => h.agent.runOptions.length === 2, 1000);

    expect(lastMarkdown(h.channel)).toContain('agent 失败');

    reaction.resolve({ data: { reaction_id: 'reaction_1' } });
    await waitFor(() => h.channel.rawClient.im.v1.messageReaction.delete.mock.calls.length > 0);
  });

  it('logs stream failures that arrive after terminal grace expires', async () => {
    const streamFailure = deferred<void>();
    let streamProducerStarted = false;
    const h = await createHarness({
      // The first run has to stream something, or no progress stream is opened
      // at all and there is no late failure to log.
      events: [
        [
          { type: 'text', delta: 'progress update' },
          {
            type: 'error',
            message: 'codex exited with code 1: Error loading config.toml',
            terminationReason: 'failed',
          },
        ],
        [{ type: 'done', terminationReason: 'normal' }],
      ],
      stream: async (_chatId, input) => {
        const producer = (input as {
          markdown?: (ctrl: { setContent(markdown: string): Promise<void> }) => Promise<void>;
        }).markdown;
        if (producer) {
          streamProducerStarted = true;
          void producer({ setContent: vi.fn(async () => {}) });
        }
        await streamFailure.promise;
      },
    });
    const fail = vi.spyOn(log, 'fail').mockImplementation(() => {});
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_first', 'first'));
    await waitFor(() => streamProducerStarted);
    await waitFor(
      () => h.channel.rawClient.im.v1.messageReaction.delete.mock.calls.length > 0,
      4500,
    );

    await h.channel.handlers.message?.(message('om_second', 'second'));
    await waitFor(() => h.agent.runOptions.length === 2);

    streamFailure.reject(new Error('late stream failed'));

    await waitFor(() =>
      fail.mock.calls.some((call) =>
        call[0] === 'stream' &&
        call[1] instanceof Error &&
        call[1].message === 'late stream failed' &&
        (call[2] as { step?: string } | undefined)?.step === 'stream-terminal-late',
      ),
    );
  }, 10_000);

  it('sends one dedicated non-streaming final reply after progress completes', async () => {
    const visibleProgress: string[] = [];
    const h = await createHarness({
      events: [
        { type: 'text', delta: 'progress update' },
        { type: 'final_text', content: 'FINAL_SENTINEL' },
        { type: 'done', terminationReason: 'normal' },
      ],
      stream: async (_chatId, input) => {
        const producer = (input as {
          markdown?: (ctrl: { setContent(markdown: string): Promise<void> }) => Promise<void>;
        }).markdown;
        await producer?.({
          setContent: vi.fn(async (markdown: string) => {
            visibleProgress.push(markdown);
          }),
        });
      },
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_final', 'run'));
    await waitFor(() => h.channel.sent.length === 1);

    expect(visibleProgress.some((markdown) => markdown.includes('progress update'))).toBe(true);
    expect(h.channel.sent).toHaveLength(1);
    expect(lastMarkdown(h.channel)).toContain('FINAL_SENTINEL');
    expect(h.channel.sent[0]?.options).toMatchObject({ replyTo: 'om_final' });
  });

  it('opens no progress stream or COT for a final-only round with COT explicitly off', async () => {
    const createCot = vi.spyOn(CotClient.prototype, 'create');
    // The regression this guards: Codex answering without any commentary. The
    // SDK sends its streaming card as soon as `stream()` is called and finishes
    // an empty one with "(no content)", so the user saw that placeholder for a
    // few seconds, watched it get recalled, and only then got the answer.
    const streamCalls: unknown[] = [];
    const h = await createHarness({
      events: [
        { type: 'final_text', content: 'FINAL_ONLY_SENTINEL' },
        { type: 'done', terminationReason: 'normal' },
      ],
      stream: async (_chatId, input) => {
        streamCalls.push(input);
      },
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_final_only', 'run'));
    await waitFor(() => h.channel.sent.length === 1);
    // give a stray stream / recall a chance to fire before asserting
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(streamCalls).toHaveLength(0);
    expect(createCot).not.toHaveBeenCalled();
    expect(h.channel.sent).toHaveLength(1);
    expect(lastMarkdown(h.channel)).toContain('FINAL_ONLY_SENTINEL');
  });

  it('does not repeat streamed text as the final reply when Codex held nothing back', async () => {
    // Codex only reserves its *last* message as `final_text`; an abnormal turn
    // end (turn.failed, or the process dying before turn.completed) flushes it
    // as a text block instead. Those blocks are already on screen, so the
    // dedicated final reply must not post the same words a second time.
    const visibleProgress: string[] = [];
    const h = await createHarness({
      events: [
        { type: 'text', delta: '这是答案' },
        { type: 'done', terminationReason: 'normal' },
      ],
      stream: async (_chatId, input) => {
        const producer = (input as {
          markdown?: (ctrl: { setContent(markdown: string): Promise<void> }) => Promise<void>;
        }).markdown;
        await producer?.({
          setContent: vi.fn(async (markdown: string) => {
            visibleProgress.push(markdown);
          }),
        });
      },
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_no_final', 'run'));
    await waitFor(() => visibleProgress.some((markdown) => markdown.includes('这是答案')));
    // give a (duplicate) final reply a chance to fire before asserting
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(h.channel.sent).toHaveLength(0);
  });

  it('waits for a slow-opening progress stream instead of replying alongside it', async () => {
    // Opening a streaming card costs two API round trips. When the run finishes
    // first, replying right away duplicates the answer verbatim — once as text,
    // once as the card that lands a moment later.
    const visibleProgress: string[] = [];
    const h = await createHarness({
      agentKind: 'claude',
      events: [
        { type: 'text', delta: 'ANSWER_ONCE' },
        { type: 'done', terminationReason: 'normal' },
      ],
      stream: async (_chatId, input) => {
        const producer = (input as {
          markdown?: (ctrl: { setContent(markdown: string): Promise<void> }) => Promise<void>;
        }).markdown;
        await new Promise((resolve) => setTimeout(resolve, 200));
        await producer?.({
          setContent: vi.fn(async (markdown: string) => {
            visibleProgress.push(markdown);
          }),
        });
      },
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_slow_stream', 'run'));
    await waitFor(() => visibleProgress.some((markdown) => markdown.includes('ANSWER_ONCE')));
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(h.channel.sent).toHaveLength(0);
  });

  it('renders nothing in a progress stream it already gave up on', async () => {
    // If the stream is still not producing after the grace window we do reply
    // without it — but the stream must then stay empty, or the answer shows up
    // twice as soon as it catches up.
    const gate = deferred<void>();
    const setContent = vi.fn(async () => {});
    const h = await createHarness({
      agentKind: 'claude',
      events: [
        { type: 'text', delta: 'ANSWER_ONCE' },
        { type: 'done', terminationReason: 'normal' },
      ],
      stream: async (_chatId, input) => {
        const producer = (input as {
          markdown?: (ctrl: { setContent(markdown: string): Promise<void> }) => Promise<void>;
        }).markdown;
        await gate.promise;
        await producer?.({ setContent });
      },
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_stuck_stream', 'run'));
    await waitFor(() => h.channel.sent.length === 1, 6000);
    gate.resolve();
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(lastMarkdown(h.channel)).toContain('ANSWER_ONCE');
    expect(h.channel.sent).toHaveLength(1);
    expect(setContent).not.toHaveBeenCalled();
  }, 15_000);

  it('still sends the final reply when the progress stream fails at completion', async () => {
    const fail = vi.spyOn(log, 'fail').mockImplementation(() => {});
    const h = await createHarness({
      events: [
        { type: 'text', delta: 'progress update' },
        { type: 'final_text', content: 'FINAL_AFTER_STREAM_FAILURE' },
        { type: 'done', terminationReason: 'normal' },
      ],
      stream: async (_chatId, input) => {
        const producer = (input as {
          markdown?: (ctrl: { setContent(markdown: string): Promise<void> }) => Promise<void>;
        }).markdown;
        await producer?.({ setContent: vi.fn(async () => {}) });
        throw new Error('progress stream failed');
      },
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_stream_fail', 'run'));
    await waitFor(() => h.channel.sent.length === 1);

    expect(lastMarkdown(h.channel)).toContain('FINAL_AFTER_STREAM_FAILURE');
    expect(
      fail.mock.calls.some(
        (call) =>
          call[0] === 'stream' &&
          call[1] instanceof Error &&
          call[1].message === 'progress stream failed' &&
          (call[2] as { step?: string } | undefined)?.step === 'progress-stream',
      ),
    ).toBe(true);
  });

  it('does not record delivery when the final send has no message receipt', async () => {
    const fail = vi.spyOn(log, 'fail').mockImplementation(() => {});
    const info = vi.spyOn(log, 'info').mockImplementation(() => {});
    const h = await createHarness({
      events: [
        { type: 'final_text', content: 'FINAL_WITHOUT_RECEIPT' },
        { type: 'done', terminationReason: 'normal' },
      ],
      send: async () => ({ messageId: '' }),
      stream: async (_chatId, input) => {
        const producer = (input as {
          markdown?: (ctrl: { setContent(markdown: string): Promise<void> }) => Promise<void>;
        }).markdown;
        await producer?.({ setContent: vi.fn(async () => {}) });
      },
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_no_receipt', 'run'));
    await waitFor(() =>
      fail.mock.calls.some(
        (call) => call[1] instanceof Error && call[1].message.includes('missing message receipt'),
      ),
    );

    expect(
      info.mock.calls.some((call) => call[0] === 'outbound' && call[1] === 'sent'),
    ).toBe(false);
  });

  it('sends one dedicated final reply card after progress completes in card mode', async () => {
    const progressCards: unknown[] = [];
    const h = await createHarness({
      messageReply: 'card',
      events: [
        { type: 'text', delta: 'progress update' },
        { type: 'final_text', content: 'FINAL_SENTINEL' },
        { type: 'done', terminationReason: 'normal' },
      ],
      stream: async (_chatId, input) => {
        const producer = (input as {
          card?: { producer?: (ctrl: { update(next: unknown): Promise<void> }) => Promise<void> };
        }).card?.producer;
        await producer?.({
          update: vi.fn(async (next: unknown) => {
            progressCards.push(next);
          }),
        });
      },
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_card_final', 'run'));
    await waitFor(() => h.channel.sent.length === 1);

    // Intermediate agent messages stream as progress; the final answer never
    // leaks into the progress card (it is held back for the dedicated reply).
    const progressJson = JSON.stringify(progressCards);
    expect(progressJson).toContain('progress update');
    expect(progressJson).not.toContain('FINAL_SENTINEL');

    // The terminal answer arrives as exactly one non-streaming card send.
    expect(h.channel.sent).toHaveLength(1);
    const finalJson = JSON.stringify(h.channel.sent[0]?.content);
    expect(finalJson).toContain('FINAL_SENTINEL');
    expect(finalJson).not.toContain('progress update');
    expect(h.channel.sent[0]?.options).toMatchObject({ replyTo: 'om_card_final' });
  });
});

async function createHarness(options: {
  reactionCreate?: () => Promise<{ data: { reaction_id: string } }>;
  stream?: StreamFn;
  send?: SendFn;
  /** One run's events, or one array per run. */
  events?: FakeAgentEvents;
  messageReply?: 'card' | 'markdown' | 'text';
  /** Codex holds its answer back for a dedicated final reply; Claude streams it. */
  agentKind?: 'claude' | 'codex';
  finalAnswer?: 'separate-event' | 'stream';
} = {}): Promise<{
  tmp: TmpProfile;
  channel: FakeLarkChannel;
  agent: FakeAgentAdapter;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  profileConfig: ReturnType<typeof createDefaultProfileConfig>;
  controls: ReturnType<typeof createControls>;
}> {
  const tmp = await createTmpProfile('markdown-stream-startup-failure-');
  const workspace = await realpath(tmp.workspace);
  const baseProfileConfig = createDefaultProfileConfig({
    agentKind: options.agentKind ?? 'codex',
    accounts: {
      app: {
        id: 'cli_test',
        secret: 'secret',
        tenant: 'feishu',
      },
    },
    access: {
      allowedUsers: ['ou_user'],
    },
    codex: {
      binaryPath: '/usr/local/bin/codex',
    },
    preferences: {
      cotMessages: 'off',
      ...(options.messageReply ? { messageReply: options.messageReply, messageReplyMigrated: true } : {}),
    },
  });
  const profileConfig = {
    ...baseProfileConfig,
    workspaces: {
      ...baseProfileConfig.workspaces,
      default: workspace,
    },
  };
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const agent = new FakeAgentAdapter({
    id: 'arbitrary-backend',
    displayName: 'Contract test backend',
    capabilities: { finalAnswer: options.finalAnswer ?? ((options.agentKind ?? 'codex') === 'codex' ? 'separate-event' : 'stream'), input: 'unsupported' },
    events: options.events ?? [
      [
        {
          type: 'error',
          message: 'codex exited with code 1: Error loading config.toml',
          terminationReason: 'failed',
        },
      ],
      [{ type: 'done', terminationReason: 'normal' }],
    ],
  });
  const channel = createFakeLarkChannel(options);
  sdkMock.channel = channel;
  const controls = createControls(profileConfig);
  cleanups.push(async () => {
    await Promise.all([sessions.flush(), workspaces.flush()]);
    await tmp.cleanup();
  });
  return {
    tmp,
    channel,
    agent,
    sessions,
    workspaces,
    profileConfig,
    controls,
  };
}

async function startTestBridge(h: {
  profileConfig: ReturnType<typeof createDefaultProfileConfig>;
  agent: FakeAgentAdapter;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  controls: ReturnType<typeof createControls>;
}): Promise<void> {
  const bridge = await startChannel({
    cfg: h.profileConfig,
    agent: h.agent,
    sessions: h.sessions,
    workspaces: h.workspaces,
    controls: h.controls,
  });
  cleanups.push(() => bridge.disconnect());
}

function createFakeLarkChannel(harnessOptions: {
  reactionCreate?: () => Promise<{ data: { reaction_id: string } }>;
  stream?: StreamFn;
  send?: SendFn;
} = {}): FakeLarkChannel {
  const handlers: MessageHandlerMap = {};
  const sent: FakeLarkChannel['sent'] = [];
  const channel: FakeLarkChannel = {
    handlers,
    sent,
    botIdentity: { openId: 'ou_bot', name: 'Bridge' },
    rawClient: {
      request: vi.fn(async () => ({ data: { items: [] } })),
      application: {
        v6: {
          application: {
            get: vi.fn(async () => ({
              data: { app: { owner: { owner_id: 'ou_owner' } } },
            })),
          },
        },
      },
      im: {
        v1: {
          message: {
            get: vi.fn(async () => ({ data: { items: [] } })),
          },
          messageReaction: {
            create: vi.fn(harnessOptions.reactionCreate ?? (async () => ({ data: { reaction_id: 'reaction_1' } }))),
            delete: vi.fn(async () => ({})),
          },
        },
      },
    },
    on(nextHandlers) {
      Object.assign(handlers, nextHandlers);
    },
    async connect() {},
    async disconnect() {},
    async getChatMode() {
      return 'group';
    },
    getConnectionStatus() {
      return { state: 'connected', reconnectAttempts: 0 };
    },
    async send(chatId, content, options) {
      sent.push({ chatId, content, options });
      if (harnessOptions.send) return harnessOptions.send(chatId, content, options);
      return { messageId: `sent_${sent.length}` };
    },
    stream: harnessOptions.stream ?? (async () => {
      await new Promise<void>(() => {});
    }),
    async addReaction(messageId, emojiType) {
      const r = await channel.rawClient.im.v1.messageReaction.create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: emojiType } },
      });
      return (r as { data?: { reaction_id?: string } })?.data?.reaction_id ?? '';
    },
    async removeReaction(messageId, reactionId) {
      await channel.rawClient.im.v1.messageReaction.delete({
        path: { message_id: messageId, reaction_id: reactionId },
      });
    },
  };
  return channel;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createControls(profileConfig: ReturnType<typeof createDefaultProfileConfig>) {
  return {
    profile: 'codex',
    profileConfig,
    ownerRefreshState: 'unknown' as const,
    async refreshOwner() {},
    async restart() {},
    async exit() {},
    configPath: '/tmp/config.json',
    cfg: profileConfig,
    processId: 'proc_test',
  };
}

function message(messageId: string, content: string): NormalizedMessage {
  return {
    messageId,
    chatId: 'oc_dm',
    chatType: 'p2p',
    senderId: 'ou_user',
    senderName: 'User',
    content,
    rawContentType: 'text',
    resources: [],
    mentionedBot: false,
    createTime: 1760000001000,
  } as unknown as NormalizedMessage;
}

function lastMarkdown(channel: FakeLarkChannel): string {
  const content = channel.sent.at(-1)?.content as { markdown?: string } | undefined;
  expect(content?.markdown).toBeTypeOf('string');
  return content?.markdown ?? '';
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('timed out waiting for async work');
}
