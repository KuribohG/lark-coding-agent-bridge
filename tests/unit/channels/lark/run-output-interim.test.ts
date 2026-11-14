import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../../../../src/agent/types';
import { createLarkRunOutput } from '../../../../src/channels/lark/run-output';
import { CotPublisher } from '../../../../src/channels/lark/cot';

async function render(events: AgentEvent[], send = vi.fn(async () => ({ messageId: 'om_reply' }))) {
  const client = { create: vi.fn(async () => ({ cot_id: 'cot', message_id: 'om_cot' })), update: vi.fn(async () => {}), complete: vi.fn(async () => {}) };
  const iterate = async function* () { yield* events; };
  const output = createLarkRunOutput({
    channel: { send, stream: vi.fn(() => new Promise(() => {})) } as never,
    chatId: 'chat', replyMode: 'markdown', sendOpts: { replyTo: 'om_user' }, cardRenderOptions: {},
    cotMessages: 'brief', cotClient: client as never, originMessageId: 'om_user', inputPreview: 'question',
    preparedCot: new CotPublisher({ client: client as never, chatId: 'chat', originMessageId: 'om_user' }),
  });
  await output.render({
    runId: 'run', scope: 'chat', handle: { interrupted: false, run: { stop: vi.fn() }, inputMessageIds: new Set() } as never,
    events: iterate(), subscribe: iterate, separateFinalAnswer: false, filterForPrefs: state => state,
  });
  return send.mock.calls.map(call => (call as unknown[])[1]);
}

const held: AgentEvent[] = [
  { type: 'text', delta: 'build started' },
  { type: 'interim_answer', content: 'build started' },
  { type: 'status', code: 'background_tasks', content: 'waiting' },
];

describe('interim answers in CoT replies', () => {
  it('posts the answer written before a background wait at once, and only the rest at the end', async () => {
    expect(await render([...held, { type: 'final_text', content: 'build passed' }, { type: 'done', terminationReason: 'normal' }]))
      .toEqual([{ markdown: 'build started' }, { markdown: 'build passed' }]);
  });

  it('does not post the interim answer again when the run ends without further text', async () => {
    expect(await render([...held, { type: 'done', terminationReason: 'normal' }])).toEqual([{ markdown: 'build started' }]);
  });

  it('carries an interim answer that failed to send in the final reply', async () => {
    const send = vi.fn().mockRejectedValueOnce(new Error('send failed')).mockResolvedValue({ messageId: 'om_reply' });
    expect(await render([...held, { type: 'final_text', content: 'build passed' }, { type: 'done', terminationReason: 'normal' }], send))
      .toEqual([{ markdown: 'build started' }, { markdown: 'build started\n\nbuild passed' }]);
  });
});
