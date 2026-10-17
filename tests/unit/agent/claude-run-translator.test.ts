import { describe, expect, it } from 'vitest';
import { ClaudeRunTranslator } from '../../../src/agent/claude/stream-json';

const assistant = (id: string | undefined, text: string) => ({ type: 'assistant', message: { id, content: [{ type: 'text', text }] } });
const result = (text: string) => ({ type: 'result', subtype: 'success', result: text, session_id: 'session' });

describe('Claude final-answer contract', () => {
  it('holds split blocks of the final message until result, emitting the answer exactly once', () => {
    const t = new ClaudeRunTranslator();
    expect([...t.translate(assistant('final', 'first '))]).toEqual([]);
    expect([...t.translate({ type: 'assistant', message: { id: 'final', content: [{ type: 'thinking', thinking: 'private' }] } })])
      .toEqual([{ type: 'thinking', delta: 'private' }]);
    expect([...t.translate(assistant('final', 'second'))]).toEqual([]);
    expect([...t.translate({ ...result('first second'), usage: { input_tokens: 2, output_tokens: 3 } })])
      .toEqual([{ type: 'final_text', content: 'first second' },
        { type: 'usage', inputTokens: 2, outputTokens: 3, cachedInputTokens: undefined, costUsd: undefined },
        { type: 'done', sessionId: 'session', terminationReason: 'normal' }]);
    expect([...t.flushProgress()]).toEqual([]);
  });

  it('releases text before a tool call, including tools in a later block of the same message', () => {
    const t = new ClaudeRunTranslator();
    expect([...t.translate(assistant('work', 'checking'))]).toEqual([]);
    expect([...t.translate({ type: 'assistant', message: { id: 'work', content: [{ type: 'tool_use', id: 'tool', name: 'Read', input: {} }] } })])
      .toEqual([{ type: 'text', delta: 'checking' }, { type: 'tool_use', id: 'tool', name: 'Read', input: {} }]);
    expect([...t.translate(assistant('final', 'answer'))]).toEqual([]);
    expect([...t.translate(result('answer'))].map(e => e.type)).toEqual(['final_text', 'done']);
  });

  it('does not duplicate final fragments when message IDs are absent', () => {
    const t = new ClaudeRunTranslator();
    expect([...t.translate(assistant(undefined, 'first '))]).toEqual([]);
    expect([...t.translate(assistant(undefined, 'second'))]).toEqual([]);
    expect([...t.translate(result('first second'))]).toEqual([
      { type: 'final_text', content: 'first second' }, { type: 'done', sessionId: 'session', terminationReason: 'normal' },
    ]);
    expect([...t.flushProgress()]).toEqual([]);
  });

  it('releases earlier messages as progress without duplicating the final one', () => {
    const t = new ClaudeRunTranslator();
    t.translate(assistant('progress', 'checking')).next();
    expect([...t.translate(assistant('final', 'answer'))]).toEqual([{ type: 'text', delta: 'checking' }]);
    expect([...t.translate(result('answer'))]).toContainEqual({ type: 'final_text', content: 'answer' });
  });

  it('does not let nested or orphaned task results finish the parent or flush its final answer', () => {
    const t = new ClaudeRunTranslator();
    expect([...t.translate(assistant('parent', 'parent answer'))]).toEqual([]);
    expect([...t.translate({ ...result('child answer'), parent_tool_use_id: 'child' })]).toEqual([]);
    expect([...t.translate({ ...result(''), origin: { kind: 'task-notification' } })]).toEqual([]);
    expect([...t.translate(result('parent answer'))]).toEqual([
      { type: 'final_text', content: 'parent answer' }, { type: 'done', sessionId: 'session', terminationReason: 'normal' },
    ]);
  });

  it.each([{ is_error: true }, { subtype: 'error_max_turns' }])('never treats a failed result as an answer (%j)', flags => {
    const t = new ClaudeRunTranslator();
    expect([...t.translate(assistant('attempt', 'partial'))]).toEqual([]);
    const events = [...t.translate({ ...result('failure detail'), ...flags })];
    expect(events).toEqual([{ type: 'text', delta: 'partial' }, { type: 'error', message: 'failure detail', terminationReason: 'failed' }]);
  });

  it('does not invent final text when a result or process has no authoritative answer', () => {
    const t = new ClaudeRunTranslator();
    expect([...t.translate(assistant('partial', 'partial'))]).toEqual([]);
    expect([...t.flushProgress()]).toEqual([{ type: 'text', delta: 'partial' }]);
    expect([...t.translate({ type: 'result', session_id: 'session' })]).toEqual([{ type: 'done', sessionId: 'session', terminationReason: 'normal' }]);
  });
});
