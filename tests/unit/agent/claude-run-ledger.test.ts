import { describe, expect, it } from 'vitest';
import { ClaudeRunLedger } from '../../../src/agent/claude/run-ledger';

const result = (...uuids: string[]) => ({ type: 'result', user_message_uuids: uuids });
const notification = (runId: string, ...uuids: string[]) =>
  ({ type: 'result', origin: { kind: 'task-notification', runId }, ...(uuids.length ? { user_message_uuids: uuids } : {}) });
const hidden = { kind: 'hidden' };
const final = (event: object) => ({ kind: 'final', result: event });
const held = (event: object) => ({ kind: 'held', result: event });

function ledger(...sent: string[]) {
  const l = new ClaudeRunLedger();
  for (const uuid of ['prompt', ...sent]) l.sent(uuid);
  return l;
}

/** Launch a background task; `running` false means it has finished and its notification turn is due. */
function launch(l: ClaudeRunLedger, runId: string, running = true) {
  l.receive({ type: 'system', subtype: 'task_started', run_id: runId, is_backgrounded: true });
  l.receive({ type: 'system', subtype: 'background_tasks_changed', tasks: running ? [{ task_id: runId, run_id: runId }] : [] });
  if (!running) l.receive({ type: 'system', subtype: 'task_notification', run_id: runId });
}

describe('Claude run ledger', () => {
  it('ends the run at the result that covers the prompt', () => {
    const l = ledger();
    expect(l.receive({ type: 'assistant' })).toBeUndefined();
    expect(l.receive({ ...result('prompt'), parent_tool_use_id: 'tool' })).toBeUndefined();
    expect(l.awaitingResult).toBe(true);
    expect(l.receive(result('prompt'))).toEqual(final(result('prompt')));
    expect(l.quiet).toBe(true);
  });

  it('hides a result that precedes a supplement still awaiting its own', () => {
    const l = ledger('more');
    expect(l.receive(result('prompt'))).toEqual(hidden);
    expect(l.quiet).toBe(false);
    expect(l.receive(result('more'))).toEqual(final(result('more')));
  });

  it('tracks several inputs consumed together or across generations', () => {
    const l = ledger('one', 'two');
    expect(l.receive(result('prompt', 'one'))).toEqual(hidden);
    expect(l.receive(result('two'))).toEqual(final(result('two')));
  });

  it('holds a covering result while background work is outstanding', () => {
    const l = ledger();
    launch(l, 'task');
    expect(l.receive(result('prompt'))).toEqual(held(result('prompt')));
    l.receive({ type: 'system', subtype: 'task_notification', run_id: 'task' });
    l.receive({ type: 'system', subtype: 'background_tasks_changed', tasks: [] });
    expect(l.receive(notification('task'))).toEqual(final(notification('task')));
  });

  it('hides a notification turn that finishes ahead of a pending supplement', () => {
    const l = ledger();
    launch(l, 'task', false);
    l.receive(result('prompt'));
    l.sent('more');
    expect(l.receive(notification('task'))).toEqual(hidden);
    expect(l.receive(result('more'))).toEqual(final(result('more')));
  });

  it('counts a supplement answered inside a notification turn as answered', () => {
    const l = ledger();
    launch(l, 'task');
    l.receive(result('prompt'));
    l.sent('more');
    // The notification turn answers the supplement and launches another task.
    l.receive({ type: 'system', subtype: 'background_tasks_changed', tasks: [] });
    launch(l, 'task-2');
    const absorbed = notification('task', 'more');
    expect(l.receive(absorbed)).toEqual(held(absorbed));
    expect(l.awaitingResult).toBe(false);
    l.receive({ type: 'system', subtype: 'background_tasks_changed', tasks: [] });
    expect(l.receive(notification('task-2'))).toEqual(final(notification('task-2')));
  });

  it('hides notification turns replayed for tasks of an earlier process', () => {
    const l = ledger();
    expect(l.receive(notification('elsewhere', 'prompt'))).toEqual(hidden);
    expect(l.receive({ type: 'result', origin: { kind: 'task-notification' } })).toEqual(hidden);
    expect(l.awaitingResult).toBe(true);
  });

  it('ends on a failed result instead of holding it', () => {
    const l = ledger();
    launch(l, 'task');
    const error = { ...result('prompt'), is_error: true, errors: ['429 Too Many Requests'] };
    expect(l.receive(error)).toEqual(final(error));
    expect(l.failure('claude exited with code 1')).toBe('claude exited with code 1');
  });

  it('marks a failure that leaves a supplement unanswered as unsafe to retry', () => {
    const l = ledger('more');
    expect(l.receive({ ...result('prompt'), is_error: true, errors: ['429 Too Many Requests'] })).toMatchObject({
      kind: 'final', result: { is_error: true, errors: ['429 Too Many Requests', expect.stringContaining('delivery is unknown')] },
    });
    expect(l.failure('claude exited with code 1')).toContain('supplemental input delivery is unknown');
  });

  it('passes an error result through when it accounts for all inputs', () => {
    const l = ledger('more');
    const error = { ...result('prompt', 'more'), subtype: 'error_during_execution' };
    expect(l.receive(error)).toEqual(final(error));
  });

  it('supports legacy single-prompt results but does not guess supplemental completion', () => {
    expect(ledger().receive({ type: 'result' })).toEqual(final({ type: 'result' }));
    expect(ledger('more').receive({ type: 'result', result: 'done' })).toMatchObject({
      kind: 'final', result: { is_error: true, errors: ['done', expect.stringContaining('delivery is unknown')] },
    });
  });
});
