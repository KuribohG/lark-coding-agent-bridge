import { describe, expect, it } from 'vitest';
import { readJsonLines } from '../../../src/agent/jsonl';
import { PiRunTranslator } from '../../../src/agent/pi/jsonl-translator';

describe('PiRunTranslator', () => {
  it('splits JSONL records only on LF, not Unicode line separators', async () => {
    const payload = `${JSON.stringify({ type: 'text', value: 'a\u2028b' })}\r\n${JSON.stringify({ type: 'text', value: 'c\u2029d' })}\n`;
    const chunks = [
      Buffer.from(payload.slice(0, 11)),
      Buffer.from(payload.slice(11)),
    ];
    const lines: string[] = [];
    for await (const line of readJsonLines((async function* () {
      yield* chunks;
    })())) lines.push(line);

    expect(lines).toEqual([
      '{"type":"text","value":"a\u2028b"}',
      '{"type":"text","value":"c\u2029d"}',
    ]);
  });

  it('translates session, streaming text, tools, usage and the terminal event', () => {
    const translator = new PiRunTranslator();
    const events = [
      ...translator.translate({ type: 'session', id: 'sess-1', cwd: '/repo' }),
      ...translator.translate({ type: 'message_start', message: { role: 'assistant' } }),
      ...translator.translate({
        type: 'message_update',
        assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'plan' },
      }),
      ...translator.translate({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', contentIndex: 1, delta: 'hello' },
      }),
      ...translator.translate({
        type: 'tool_execution_start',
        toolCallId: 'tool-1',
        toolName: 'read',
        args: { path: 'README.md' },
      }),
      ...translator.translate({
        type: 'tool_execution_end',
        toolCallId: 'tool-1',
        result: { content: [{ type: 'text', text: 'contents' }] },
        isError: false,
      }),
      ...translator.translate({
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'hello' }],
          stopReason: 'stop',
          usage: {
            input: 12,
            output: 3,
            cacheRead: 7,
            cost: { total: 0.004 },
          },
        },
      }),
      ...translator.translate({ type: 'agent_settled', aborted: false }),
    ];

    expect(events).toEqual([
      { type: 'system', sessionId: 'sess-1', cwd: '/repo' },
      { type: 'thinking', delta: 'plan' },
      { type: 'text', delta: 'hello' },
      { type: 'tool_use', id: 'tool-1', name: 'read', input: { path: 'README.md' } },
      { type: 'tool_result', id: 'tool-1', output: 'contents', isError: false },
      {
        type: 'usage',
        inputTokens: 12,
        outputTokens: 3,
        cachedInputTokens: 7,
        costUsd: 0.004,
      },
      { type: 'done', sessionId: 'sess-1', terminationReason: 'normal' },
    ]);
    expect(translator.terminalEmitted()).toBe(true);
  });

  it('uses authoritative final content when a model emitted no deltas', () => {
    const translator = new PiRunTranslator();
    const events = translator.translate({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'final ' },
          { type: 'text', text: 'answer' },
        ],
        stopReason: 'stop',
      },
    });

    expect(events).toContainEqual({ type: 'text', delta: 'final answer' });
  });

  it('finishes older JSON mode releases from process exit', () => {
    const translator = new PiRunTranslator();
    translator.translate({ type: 'session', id: 'sess-old' });
    expect(translator.finish({
      exitCode: 0,
      stderr: '',
      interrupted: false,
      timedOut: false,
    })).toEqual([
      { type: 'done', sessionId: 'sess-old', terminationReason: 'normal' },
    ]);
  });

  it('surfaces non-zero exits and final provider errors', () => {
    const exitFailure = new PiRunTranslator();
    expect(exitFailure.finish({
      exitCode: 42,
      stderr: 'provider exploded',
      interrupted: false,
      timedOut: false,
    })).toEqual([{
      type: 'error',
      message: 'pi exited with code 42: provider exploded',
      terminationReason: 'failed',
    }]);

    const providerFailure = new PiRunTranslator();
    expect(providerFailure.translate({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [],
        stopReason: 'error',
        errorMessage: '401 unauthorized',
      },
    })).toContainEqual({
      type: 'error',
      message: '401 unauthorized',
      terminationReason: 'failed',
    });
  });
});
