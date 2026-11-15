import { describe, expect, it } from 'vitest';
import type { SlackApi, SlackPostMessageInput, SlackUpdateMessageInput } from '../../../src/channels/slack/api';
import { SlackEventMirror } from '../../../src/channels/slack/events';
import type { RunState } from '../../../src/runtime/run-state';

class FakeSlackApi {
  readonly posts: SlackPostMessageInput[] = [];
  readonly updates: SlackUpdateMessageInput[] = [];

  async authTest() { return { teamId: 'T1', userId: 'UBOT' }; }
  async postMessage(input: SlackPostMessageInput): Promise<string> {
    this.posts.push(input);
    return `${this.posts.length}.000`;
  }
  async updateMessage(input: SlackUpdateMessageInput): Promise<void> {
    this.updates.push(input);
  }
  async addReaction(): Promise<void> {}
  async removeReaction(): Promise<void> {}
}

function state(patch: Partial<RunState>): RunState {
  return {
    blocks: [], reasoning: { content: '', active: false }, footer: null, terminal: 'running', ...patch,
  };
}

describe('Slack event mirror', () => {
  it('posts workflow notices and turns a runtime-started run into one thread message', async () => {
    const api = new FakeSlackApi();
    const mirror = new SlackEventMirror({
      api: api as unknown as SlackApi,
      display: { show_tools: false, show_progress: true },
      progressIntervalMs: 0,
      now: () => 0,
    });

    await mirror.handle('C1/100.001', { type: 'notice', text: 'plan ready', sequence: 1 });
    await mirror.handle('C1/100.001', { type: 'run.started', runId: 'r1', sequence: 2 });
    await mirror.handle('C1/100.001', {
      type: 'run.state', runId: 'r1', sequence: 3,
      state: state({ blocks: [{ kind: 'text', content: 'working', streaming: true }] }),
    });
    await mirror.handle('C1/100.001', {
      type: 'run.state', runId: 'r1', sequence: 4,
      state: state({ blocks: [{ kind: 'text', content: 'answer', streaming: false }], finalText: 'answer', terminal: 'done' }),
    });
    await mirror.handle('C1/100.001', { type: 'run.finished', runId: 'r1', result: 'completed', sequence: 5 });

    expect(api.posts).toEqual([
      { channel: 'C1', threadTs: '100.001', text: 'plan ready' },
      { channel: 'C1', threadTs: '100.001', text: 'working' },
    ]);
    expect(api.updates.at(-1)).toEqual({ channel: 'C1', ts: '2.000', text: 'answer' });
  });

  it('keeps progress hidden when configured and still reports the result', async () => {
    const api = new FakeSlackApi();
    const mirror = new SlackEventMirror({
      api: api as unknown as SlackApi,
      display: { show_tools: false, show_progress: false },
      progressIntervalMs: 0,
    });

    await mirror.handle('C1/200.001', { type: 'run.started', runId: 'r1', sequence: 1 });
    await mirror.handle('C1/200.001', {
      type: 'run.state', runId: 'r1', sequence: 2,
      state: state({ blocks: [{ kind: 'text', content: 'working', streaming: true }] }),
    });
    await mirror.handle('C1/200.001', {
      type: 'run.state', runId: 'r1', sequence: 3,
      state: state({ blocks: [{ kind: 'text', content: 'answer', streaming: false }], finalText: 'answer', terminal: 'done' }),
    });
    await mirror.handle('C1/200.001', { type: 'run.finished', runId: 'r1', result: 'completed', sequence: 4 });

    expect(api.posts).toEqual([{ channel: 'C1', threadTs: '200.001', text: 'answer' }]);
    expect(api.updates.at(-1)).toEqual({ channel: 'C1', ts: '1.000', text: 'answer' });
  });
});
