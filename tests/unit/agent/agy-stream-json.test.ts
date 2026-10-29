import { describe, expect, it } from 'vitest';
import { AgyStreamTranslator } from '../../../src/agent/agy/stream-json';

const init = { event: 'init', conversation_id: 'conversation-1', init: { cwd: '/repo', model: 'gemini-new' } };
const step = (step_index: number, rest: object) => ({ event: 'step_update', step_update: { step_index, ...rest } });
const result = (status = 'SUCCESS', rest: object = {}) => ({ event: 'result', result: {
  conversation_id: 'conversation-1', status, response: 'final answer', ...rest,
} });

describe('Antigravity stream protocol', () => {
  it('keeps provisional output separate from the authoritative result and counts each completed step once', () => {
    const t = new AgyStreamTranslator();
    expect(t.translate(init)).toEqual([{ type: 'system', sessionId: 'conversation-1', cwd: '/repo', model: 'gemini-new' }]);
    expect(t.translate(step(1, { step_type: 'agent_response', state: 'ACTIVE', text_delta: 'working…' })))
      .toEqual([{ type: 'text', delta: 'working…' }]);
    const done = step(1, { step_type: 'agent_response', state: 'DONE', text_delta: '\n', usage: { input_tokens: 10, output_tokens: 3 } });
    t.translate(done);
    expect(t.translate(done)).toEqual([]);
    t.translate(step(2, { step_type: 'checkpoint', state: 'DONE', usage: { input_tokens: 2, output_tokens: 1 } }));
    expect(t.translate(result('SUCCESS', { usage: { input_tokens: 1000, output_tokens: 100 } }))).toEqual([
      { type: 'usage', inputTokens: 12, outputTokens: 4, cachedInputTokens: undefined, reasoningOutputTokens: undefined },
      { type: 'final_text', content: 'final answer' },
      { type: 'done', sessionId: 'conversation-1', terminationReason: 'normal' },
    ]);
    expect(t.translate(result())).toEqual([]);
  });

  it('synthesizes tool starts for completion-only updates and retains permission failures', () => {
    const t = new AgyStreamTranslator(); t.translate(init);
    const call = step(3, { step_type: 'tool', state: 'DONE', tool_name: 'run_command',
      tool_info: { parameters: { CommandLine: 'npm test' }, error: { type: 'permission_denied', message: 'command denied' } } });
    expect(t.translate(call)).toEqual([
      { type: 'tool_use', id: 'agy:conversation-1:3', name: 'run_command', input: { CommandLine: 'npm test' } },
      { type: 'tool_result', id: 'agy:conversation-1:3', output: 'command denied', isError: true },
    ]);
    expect(t.translate(call)).toEqual([]);
    t.stderr('Tool permission denied: run_command');
    expect(t.translate(result())[0]).toMatchObject({ type: 'status', code: 'tool-permission-denied' });
  });

  it('merges partial step updates without dropping a delayed tool output', () => {
    const t = new AgyStreamTranslator(); t.translate(init);
    t.translate(step(3, { step_type: 'tool', state: 'ACTIVE', tool_name: 'run_command',
      tool_info: { parameters: { CommandLine: 'pwd' } } }));
    expect(t.translate(step(3, { state: 'DONE' }))).toEqual([]);
    expect(t.translate(step(3, { tool_info: { output: '/repo' } }))).toEqual([
      { type: 'tool_result', id: 'agy:conversation-1:3', output: '/repo', isError: false },
    ]);
    expect(t.translate(step(3, { tool_info: { output: '/repo' } }))).toEqual([]);
  });

  it.each(['ERROR', 'INVALID', 'WAITING', 'RUNNING'])('never reports %s as a completed task', status => {
    const events = new AgyStreamTranslator().translate(result(status));
    expect(events).toEqual([expect.objectContaining({ type: 'error', terminationReason: 'failed' })]);
  });

  it.each(['CANCELED', 'INTERRUPTED'])('maps native %s to interruption without a final answer', status => {
    expect(new AgyStreamTranslator().translate(result(status)))
      .toEqual([{ type: 'done', sessionId: 'conversation-1', terminationReason: 'interrupted' }]);
  });

  it('rejects a truncated stream even when the process exits successfully', () => {
    const t = new AgyStreamTranslator(); t.translate(init);
    expect(t.finish({ exitCode: 0, stderr: '', interrupted: false, timedOut: false }))
      .toEqual([expect.objectContaining({ type: 'error', message: expect.stringContaining('without a result') })]);
  });

  it('classifies missing authentication separately from retryable rate limits', () => {
    expect(new AgyStreamTranslator().finish({ exitCode: 1, stderr: 'Please sign in to continue', interrupted: false, timedOut: false })[0])
      .toMatchObject({ type: 'error', failureKind: 'authentication' });
    expect(new AgyStreamTranslator().translate(result('ERROR', { error: '429 Too Many Requests' }))[0])
      .toMatchObject({ type: 'error', failureKind: 'rate_limit' });
  });
});
