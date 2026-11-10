import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeAdapter } from '../../../src/agent/claude/adapter.js';
import { translateEvent } from '../../../src/agent/claude/stream-json.js';
import type { AgentEvent } from '../../../src/agent/types.js';

describe('Claude stream-json translator', () => {
  it('translates system init metadata', () => {
    expect([
      ...translateEvent({
        type: 'system',
        subtype: 'init',
        session_id: 'sess-1',
        cwd: '/repo',
        model: 'sonnet',
      }),
    ]).toEqual([
      { type: 'system', sessionId: 'sess-1', cwd: '/repo', model: 'sonnet' },
    ]);
    expect([...translateEvent({ type: 'system', subtype: 'init', session_id: 'sess-1' })][0]).not.toHaveProperty('threadId');
  });

  it('translates assistant text and tool_use blocks, dropping raw thinking', () => {
    expect([
      ...translateEvent({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'hello' },
            { type: 'thinking', thinking: 'checking' },
            { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'pwd' } },
          ],
        },
      }),
    ]).toEqual([
      { type: 'text', delta: 'hello' },
      { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'pwd' } },
    ]);
  });

  it('translates user tool_result blocks including structured output and errors', () => {
    expect([
      ...translateEvent({
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' },
            {
              type: 'tool_result',
              tool_use_id: 'tool-2',
              content: [{ type: 'text', text: 'bad' }],
              is_error: true,
            },
          ],
        },
      }),
    ]).toEqual([
      { type: 'tool_result', id: 'tool-1', output: 'ok', isError: false },
      {
        type: 'tool_result',
        id: 'tool-2',
        output: JSON.stringify([{ type: 'text', text: 'bad' }]),
        isError: true,
      },
    ]);
  });

  it('translates result usage before done', () => {
    expect([
      ...translateEvent({
        type: 'result',
        session_id: 'sess-2',
        usage: { input_tokens: 12, output_tokens: 34, cache_read_input_tokens: 5 },
        total_cost_usd: 0.1234,
      }),
    ]).toEqual([
      { type: 'usage', inputTokens: 12, outputTokens: 34, cachedInputTokens: 5, costUsd: 0.1234 },
      { type: 'done', sessionId: 'sess-2', terminationReason: 'normal' },
    ]);
    expect([...translateEvent({ type: 'result', session_id: 'sess-2' })][0]).not.toHaveProperty('threadId');
  });

  it('ignores unknown, empty, and incomplete raw events', () => {
    expect([...translateEvent(null)]).toEqual([]);
    expect([...translateEvent({ type: 'assistant', message: { content: [{ type: 'text', text: '' }] } })]).toEqual([]);
    expect([...translateEvent({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't' }] } })]).toEqual([]);
    expect([...translateEvent({ type: 'system', subtype: 'other' })]).toEqual([]);
  });

  it('surfaces compaction, model fallback, API retries, and warnings', () => {
    const notices = (raw: object) => [...translateEvent({ type: 'system', ...raw })];
    expect(notices({ subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 812_345, post_tokens: 40_100 } }))
      .toEqual([{ type: 'status', code: 'context_compaction', content: '🗜️ 上下文已自动压缩（812K → 40K tokens），任务继续执行。' }]);
    expect(notices({ subtype: 'compact_boundary', compact_metadata: { trigger: 'manual' } }))
      .toEqual([{ type: 'status', code: 'context_compaction', content: '🗜️ 上下文已压缩，任务继续执行。' }]);
    expect(notices({ subtype: 'status', status: null, compact_result: 'failed', compact_error: 'prompt too long' }))
      .toEqual([{ type: 'status', code: 'context_compaction_failed', content: '⚠️ 上下文压缩失败：prompt too long' }]);
    expect(notices({ subtype: 'status', status: 'compacting' })).toEqual([]);
    expect(notices({ subtype: 'status', status: null, compact_result: 'success' })).toEqual([]);

    expect(notices({ subtype: 'model_fallback', trigger: 'overloaded', original_model: 'opus', fallback_model: 'sonnet', content: 'Opus is overloaded; switched to sonnet' }))
      .toEqual([{ type: 'status', code: 'model_fallback', content: '⚠️ Opus is overloaded; switched to sonnet' }]);
    expect(notices({ subtype: 'model_fallback', original_model: 'opus', fallback_model: 'sonnet', content: 'Model overloaded' }))
      .toEqual([{ type: 'status', code: 'model_fallback', content: '⚠️ Model overloaded（opus → sonnet）' }]);
    expect(notices({ subtype: 'model_refusal_fallback', original_model: 'opus', fallback_model: 'sonnet' }))
      .toEqual([{ type: 'status', code: 'model_refusal_fallback', content: '⚠️ 模型已切换：opus → sonnet' }]);
    expect(notices({ subtype: 'model_refusal_no_fallback', original_model: 'opus', content: '' }))
      .toEqual([{ type: 'status', code: 'model_refusal_no_fallback', content: '⚠️ opus 拒绝了本次请求，且没有可用的降级模型。' }]);

    expect(notices({ subtype: 'api_retry', attempt: 2, max_retries: 10, retry_delay_ms: 4000, error_status: 529, error: 'server_error' }))
      .toEqual([{ type: 'retry', attempt: 2, maxAttempts: 10, delayMs: 4000, failureKind: 'transient' }]);
    expect(notices({ subtype: 'api_retry', attempt: 1, max_retries: 10, retry_delay_ms: 1000, error_status: 429, error: 'rate_limit' }))
      .toEqual([{ type: 'retry', attempt: 1, maxAttempts: 10, delayMs: 1000, failureKind: 'rate_limit' }]);
    for (const status of [401, 403]) {
      expect(notices({ subtype: 'api_retry', attempt: 1, max_retries: 10, retry_delay_ms: 600, error_status: status, error: 'authentication_failed' }))
        .toEqual([{ type: 'retry', attempt: 1, maxAttempts: 10, delayMs: 600, failureKind: 'authentication' }]);
    }
    expect(notices({ subtype: 'api_retry' })).toEqual([]);

    expect(notices({ subtype: 'notification', key: 'k', text: 'Credits exhausted', color: 'error' }))
      .toEqual([{ type: 'status', code: 'notification:k', content: '⚠️ Credits exhausted' }]);
    expect(notices({ subtype: 'notification', key: 'k', text: 'Tip', priority: 'low' })).toEqual([]);
    expect(notices({ subtype: 'permission_denied', tool_name: 'Bash', decision_reason: 'blocked by policy' }))
      .toEqual([{ type: 'status', code: 'tool-permission-denied', content: '⚠️ 工具 Bash 被拒绝执行：blocked by policy' }]);
  });

  it('reports a native workflow and its agents as partial task events', () => {
    const task = (raw: object) => [...translateEvent({ type: 'system', ...raw })];
    // Field names as Claude Code 2.1 writes them to stream-json.
    expect(task({ subtype: 'task_started', task_id: 'wf1', run_id: 'r1', tool_use_id: 'tu1', description: 'Review the last 10 commits',
      task_type: 'local_workflow', workflow_name: 'review-recent-commits', is_backgrounded: true, prompt: 'export const meta = {}' }))
      .toEqual([{ type: 'task', id: 'wf1', state: 'running', kind: 'workflow', nativeType: 'local_workflow', name: 'review-recent-commits',
        description: 'Review the last 10 commits', background: true }]);
    expect(task({ subtype: 'task_started', task_id: 'ag1', task_type: 'local_agent', parent_task_id: 'wf1', description: 'review:tooling' }))
      .toEqual([{ type: 'task', id: 'ag1', state: 'running', kind: 'agent', nativeType: 'local_agent', parentId: 'wf1', description: 'review:tooling' }]);
    expect(task({ subtype: 'task_progress', task_id: 'wf1', usage: { total_tokens: 1200, tool_uses: 4, duration_ms: 9000 }, last_tool_name: 'Bash',
      workflow_progress: [
        { type: 'workflow_agent', index: 0, label: 'review:tooling', phaseIndex: 0, phaseTitle: 'Review', agentId: 'a1', model: 'flash', state: 'start',
          queuedAt: 10, lastProgressAt: 20, promptPreview: 'Read the diff' },
        { type: 'workflow_agent', index: 1, label: 'review:ue', phaseIndex: 0, phaseTitle: 'Review', state: 'done', resultPreview: 'No defects', lastProgressAt: 30 },
        { type: 'workflow_log', text: 'not a member' },
      ] }))
      .toEqual([{ type: 'task', id: 'wf1', state: 'running', lastTool: 'Bash', usage: { tokens: 1200, toolUses: 4, durationMs: 9000 }, members: [
        { index: 0, label: 'review:tooling', phaseIndex: 0, phase: 'Review', state: 'start', agentId: 'a1', model: 'flash', prompt: 'Read the diff', startedAt: 10, updatedAt: 20 },
        { index: 1, label: 'review:ue', phaseIndex: 0, phase: 'Review', state: 'done', result: 'No defects', updatedAt: 30 },
      ] }]);
    expect(task({ subtype: 'task_updated', task_id: 'ag1', patch: { status: 'killed', error: 'Workflow aborted' } }))
      .toEqual([{ type: 'task', id: 'ag1', state: 'stopped', error: 'Workflow aborted' }]);
    expect(task({ subtype: 'task_notification', task_id: 'wf1', status: 'completed', summary: '3 findings', output_file: '', workflow_progress: [], workflow_progress_omitted: 2 }))
      .toEqual([{ type: 'task', id: 'wf1', state: 'completed', summary: '3 findings', members: [], membersOmitted: 2 }]);
    // Internal tasks and events without an id are not the user's work.
    expect(task({ subtype: 'task_started', task_id: 'x', task_type: 'local_agent', ambient: true })).toEqual([]);
    expect(task({ subtype: 'task_progress' })).toEqual([]);
  });
});

describe('Claude stream-json reader behavior', () => {
  let cleanup: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
  });

  it('skips non-JSON stdout lines and reports non-zero stderr detail without redacting visible paths', async () => {
    const stderr = 'fatal stderr at /Users/example/work/repo/file.ts';
    const binary = await createFakeBinary([
      'not json',
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'kept' }] } }),
    ], 7, stderr);
    cleanup = binary.cleanup;

    const run = (await new ClaudeAdapter({ binary: binary.path }).prepareRun({
      runId: 'run-reader',
      prompt: 'hi',
      cwd: tmpdir(),
    })).start();
    const events = await collect(run.events);

    expect(events).toEqual([
      { type: 'text', delta: 'kept' },
      {
        type: 'error',
        message: `claude exited with code 7: ${stderr}`,
        terminationReason: 'failed',
        failureKind: 'runtime',
      },
    ]);
  });
});

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

async function createFakeBinary(lines: string[], exitCode: number, stderr: string): Promise<{
  path: string;
  cleanup(): Promise<void>;
}> {
  const dir = await mkdtemp(join(tmpdir(), 'claude-stream-json-test-'));
  const path = join(dir, 'fake-claude.mjs');
  await writeFile(
    path,
    [
      '#!/usr/bin/env node',
      `const lines = ${JSON.stringify(lines)};`,
      'for (const line of lines) console.log(line);',
      `process.stderr.write(${JSON.stringify(stderr)});`,
      `process.exit(${exitCode});`,
    ].join('\n'),
    'utf8',
  );
  await chmod(path, 0o755);
  return {
    path,
    cleanup: async () => {
      const { rm } = await import('node:fs/promises');
      await rm(dir, { recursive: true, force: true });
    },
  };
}
