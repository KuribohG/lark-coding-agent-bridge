import { describe, expect, it } from 'vitest';
import { ConversationEvents, type ConversationStreamEvent } from '../../../src/runtime/conversation-events';
import { initialState } from '../../../src/runtime/run-state';

const state = (content: string) => ({ ...initialState, blocks: [{ kind: 'text' as const, content, streaming: true }] });

function collect(events: ConversationEvents, scope: string, cursor = {}) {
  const received: ConversationStreamEvent[] = [];
  const stop = events.subscribe(scope, cursor, event => { received.push(event); });
  return { received, stop };
}

describe('ConversationEvents', () => {
  it('opens every subscription, replays what the cursor missed and then delivers live events', () => {
    const events = new ConversationEvents();
    const first = events.publish('a', { type: 'run.started', runId: 'r1' });
    events.publish('b', { type: 'run.started', runId: 'other' });
    const second = events.publish('a', { type: 'run.finished', runId: 'r1', result: 'completed' });

    const all = collect(events, 'a');
    expect(all.received).toEqual([{ type: 'stream.opened', stream: events.id, sequence: second.sequence }, first, second]);

    const resumed = collect(events, 'a', { stream: events.id, after: first.sequence });
    expect(resumed.received.slice(1)).toEqual([second]);
    const third = events.publish('a', { type: 'run.started', runId: 'r2' });
    expect(resumed.received.at(-1)).toEqual(third);
    expect(third.sequence).toBeGreaterThan(second.sequence);

    resumed.stop();
    events.publish('a', { type: 'run.finished', runId: 'r2', result: 'completed' });
    expect(resumed.received.at(-1)).toEqual(third);
    expect(all.received).toHaveLength(5);
  });

  it('replays everything to a cursor issued by another stream', () => {
    const events = new ConversationEvents();
    const first = events.publish('a', { type: 'run.started', runId: 'r1' });
    expect(collect(events, 'a', { stream: 'previous-process', after: 99 }).received.slice(1)).toEqual([first]);
  });

  it('keeps only the newest state snapshot of a run and a bounded history', () => {
    const events = new ConversationEvents();
    events.publish('a', { type: 'run.state', runId: 'r1', state: state('one') });
    events.publish('a', { type: 'run.question', runId: 'r1', id: 'q', mode: 'async', questions: [] });
    const latest = events.publish('a', { type: 'run.state', runId: 'r1', state: state('two') });
    expect(collect(events, 'a').received.slice(1).map(event => event.type)).toEqual(['run.question', 'run.state']);
    expect(collect(events, 'a').received.at(-1)).toEqual(latest);

    for (let i = 0; i < 300; i++) events.publish('a', { type: 'run.started', runId: `r${i}` });
    const replay = collect(events, 'a').received;
    expect(replay).toHaveLength(257);
    expect(replay.at(-1)).toMatchObject({ runId: 'r299' });
  });

  it('isolates a subscriber that throws', () => {
    const events = new ConversationEvents();
    events.subscribe('a', {}, () => { throw new Error('socket closed'); });
    const healthy = collect(events, 'a');
    expect(() => events.publish('a', { type: 'run.started', runId: 'r1' })).not.toThrow();
    expect(healthy.received).toHaveLength(2);
  });
});
