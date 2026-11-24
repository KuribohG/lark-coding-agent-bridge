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
      { type: 'usage', inputTokens: 12, outputTokens: 4, cachedInputTokens: undefined, reasoningOutputTokens: undefined, contextTokens: 13 },
      { type: 'final_text', content: 'final answer' },
      { type: 'done', sessionId: 'conversation-1', terminationReason: 'normal' },
    ]);
    expect(t.translate(result())).toEqual([]);
  });

  it('reports latest single-call contextTokens separately from cumulative multi-step usage', () => {
    const t = new AgyStreamTranslator(); t.translate(init);
    t.translate(step(1, { step_type: 'tool', state: 'DONE', tool_name: 'read_file',
      tool_info: { parameters: { Path: '/repo/a.ts' }, output: 'ok' },
      usage: { input_tokens: 5000, cache_read_tokens: 100000, output_tokens: 1000 } }));
    t.translate(step(2, { step_type: 'tool', state: 'DONE', tool_name: 'read_file',
      tool_info: { parameters: { Path: '/repo/b.ts' }, output: 'ok' },
      usage: { input_tokens: 5000, cache_read_tokens: 100000, output_tokens: 1000 } }));
    t.translate(step(3, { step_type: 'agent_response', state: 'DONE', text_delta: 'done',
      usage: { input_tokens: 5000, cache_read_tokens: 100000, output_tokens: 1000 } }));
    expect(t.translate(result('SUCCESS'))).toEqual([
      { type: 'usage', inputTokens: 15000, outputTokens: 3000, cachedInputTokens: 300000, reasoningOutputTokens: undefined, contextTokens: 106000 },
      { type: 'final_text', content: 'final answer' },
      { type: 'done', sessionId: 'conversation-1', terminationReason: 'normal' },
    ]);
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

  it('flushes completed tool steps missing output or error when another step or result arrives', () => {
    const t = new AgyStreamTranslator(); t.translate(init);
    t.translate(step(3, { step_type: 'tool', state: 'ACTIVE', tool_name: 'read_file',
      tool_info: { parameters: { Path: '/repo/a.ts' } } }));
    expect(t.translate(step(3, { state: 'DONE' }))).toEqual([]);
    expect(t.translate(step(4, { step_type: 'agent_response', state: 'ACTIVE', text_delta: 'next' }))).toEqual([
      { type: 'tool_result', id: 'agy:conversation-1:3', output: '', isError: false },
      { type: 'text', delta: 'next' },
    ]);
    expect(t.translate(step(4, { step_type: 'agent_response', state: 'DONE' }))).toEqual([]);

    t.translate(step(5, { step_type: 'tool', state: 'ACTIVE', tool_name: 'run_command',
      tool_info: { parameters: { CommandLine: 'true' } } }));
    expect(t.translate(step(5, { state: 'DONE' }))).toEqual([]);
    expect(t.translate(result('SUCCESS'))).toEqual([
      { type: 'tool_result', id: 'agy:conversation-1:5', output: '', isError: false },
      { type: 'final_text', content: 'final answer' },
      { type: 'done', sessionId: 'conversation-1', terminationReason: 'normal' },
    ]);
  });

  it('marks ERROR tool steps as failed even without tool_info.error and flushes unfinished tools on result', () => {
    const t = new AgyStreamTranslator(); t.translate(init);
    expect(t.translate(step(3, { step_type: 'tool', state: 'ACTIVE', tool_name: 'read_file',
      tool_info: { parameters: { Path: '/repo/missing.ts' } } }))).toEqual([
      { type: 'tool_use', id: 'agy:conversation-1:3', name: 'read_file', input: { Path: '/repo/missing.ts' } },
    ]);
    expect(t.translate(step(3, { state: 'ERROR' }))).toEqual([
      { type: 'tool_result', id: 'agy:conversation-1:3', output: '', isError: true },
    ]);

    t.translate(step(4, { step_type: 'tool', state: 'ACTIVE', tool_name: 'read_file',
      tool_info: { parameters: { Path: '/repo/late.ts' } } }));
    expect(t.translate(result('SUCCESS'))).toEqual([
      { type: 'tool_result', id: 'agy:conversation-1:4', output: '', isError: false },
      { type: 'final_text', content: 'final answer' },
      { type: 'done', sessionId: 'conversation-1', terminationReason: 'normal' },
    ]);
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

  it('translates step_type subagent lifecycle into sanitized tool calls and agent task events', () => {
    const t = new AgyStreamTranslator();
    t.translate(init);
    const active = step(2, {
      step_type: 'subagent',
      state: 'ACTIVE',
      tool_name: 'invoke_subagent',
      subagent_info: {
        subagents: [{
          type_name: 'research',
          role: 'Contract and Correctness Auditor',
          initial_prompt: 'Inspect the contract carefully.',
        }],
      },
    });
    expect(t.translate(active)).toEqual([
      {
        type: 'tool_use',
        id: 'agy:conversation-1:2',
        name: 'invoke_subagent',
        input: {
          subagents: [{
            role: 'Contract and Correctness Auditor',
            typeName: 'research',
            promptPreview: 'Inspect the contract carefully.',
          }],
        },
      },
    ]);

    const done = step(2, {
      step_type: 'subagent',
      state: 'DONE',
      tool_name: 'invoke_subagent',
      subagent_info: {
        subagents: [{
          type_name: 'research',
          role: 'Contract and Correctness Auditor',
          initial_prompt: 'Inspect the contract carefully.',
          conversation_id: 'd2ee1ad2-1111-2222-3333-444455556666',
          log_uri: 'file:///C:/Users/secret/.gemini/antigravity/brain/d2ee1ad2/transcript.jsonl',
        }],
      },
    });
    const doneEvents = t.translate(done);
    expect(doneEvents).toEqual([
      {
        type: 'task',
        id: 'd2ee1ad2-1111-2222-3333-444455556666',
        kind: 'agent',
        nativeType: 'research',
        state: 'running',
        name: 'Contract and Correctness Auditor',
        description: 'Inspect the contract carefully.',
        background: true,
        members: [{
          index: 0,
          label: 'Contract and Correctness Auditor',
          agentId: 'd2ee1ad2-1111-2222-3333-444455556666',
          state: 'running',
        }],
      },
      {
        type: 'tool_result',
        id: 'agy:conversation-1:2',
        output: JSON.stringify({
          subagents: [{
            conversationId: 'd2ee1ad2-1111-2222-3333-444455556666',
            role: 'Contract and Correctness Auditor',
            typeName: 'research',
          }],
        }),
        isError: false,
      },
    ]);
    expect(JSON.stringify(doneEvents)).not.toContain('log_uri');
    expect(JSON.stringify(doneEvents)).not.toContain('C:/Users/secret');
    expect(t.translate(done)).toEqual([]);

    expect(t.translate(result('SUCCESS'))).toEqual([
      {
        type: 'task',
        id: 'd2ee1ad2-1111-2222-3333-444455556666',
        state: 'completed',
        members: [{
          index: 0,
          label: 'Contract and Correctness Auditor',
          agentId: 'd2ee1ad2-1111-2222-3333-444455556666',
          state: 'done',
        }],
      },
      { type: 'final_text', content: 'final answer' },
      { type: 'done', sessionId: 'conversation-1', terminationReason: 'normal' },
    ]);
  });

  it('tracks multiple native subagents across steps and multi-item payloads', () => {
    const t = new AgyStreamTranslator();
    t.translate(init);
    const step2 = t.translate(step(2, {
      step_type: 'subagent',
      state: 'DONE',
      tool_name: 'invoke_subagent',
      subagent_info: {
        subagents: [
          { type_name: 'research', role: 'Adversarial Challenger and Auditor', conversation_id: 'fb214631-0000-0000-0000-000000000001' },
          { type_name: 'research', role: 'Variant Hunter and Evidence Verifier', conversation_id: '480a98b5-0000-0000-0000-000000000002' },
        ],
      },
    }));
    const tasks = step2.filter(e => e.type === 'task');
    expect(tasks.map(e => (e as { id: string }).id)).toEqual([
      'fb214631-0000-0000-0000-000000000001',
      '480a98b5-0000-0000-0000-000000000002',
    ]);
    expect(tasks.map(e => (e as { name: string }).name)).toEqual([
      'Adversarial Challenger and Auditor',
      'Variant Hunter and Evidence Verifier',
    ]);

    const resEvents = t.translate(result('SUCCESS'));
    expect(resEvents.filter(e => e.type === 'task')).toHaveLength(2);
  });

  it('marks ERROR subagent steps as failed and settles running subagents as stopped on cancellation', () => {
    const tErr = new AgyStreamTranslator();
    tErr.translate(init);
    const errEvents = tErr.translate(step(2, {
      step_type: 'subagent',
      state: 'ERROR',
      tool_name: 'invoke_subagent',
      subagent_info: {
        subagents: [{ type_name: 'research', role: 'Failed Auditor', conversation_id: 'child-err-1' }],
      },
    }));
    expect(errEvents).toContainEqual(expect.objectContaining({ type: 'task', id: 'child-err-1', state: 'failed' }));
    expect(errEvents).toContainEqual(expect.objectContaining({ type: 'tool_result', id: 'agy:conversation-1:2', isError: true }));

    const tCancel = new AgyStreamTranslator();
    tCancel.translate(init);
    tCancel.translate(step(2, {
      step_type: 'subagent',
      state: 'DONE',
      tool_name: 'invoke_subagent',
      subagent_info: {
        subagents: [{ type_name: 'research', role: 'Interrupted Auditor', conversation_id: 'child-cancel-1' }],
      },
    }));
    expect(tCancel.translate(result('CANCELED'))).toEqual([
      {
        type: 'task',
        id: 'child-cancel-1',
        state: 'stopped',
        members: [{ index: 0, label: 'Interrupted Auditor', agentId: 'child-cancel-1', state: 'stopped' }],
      },
      { type: 'done', sessionId: 'conversation-1', terminationReason: 'interrupted' },
    ]);
  });
});
