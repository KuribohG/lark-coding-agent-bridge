import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../../../src/agent/types';
import { processInbox } from '../../../src/monitoring/sources/lark/processor';
import type { InboxJob } from '../../../src/inbox/types';
import { FakeAgentAdapter } from '../../helpers/fake-agent';

const job: InboxJob = { id: 'retry-item', ownerOpenId: 'ou_owner', profile: 'codex',
  destination: { chatId: 'oc_target', threadId: 'omt_item', replyTo: 'om_item' }, source: { chatId: 'oc_source', name: '项目群', type: 'group' },
  messages: [], state: 'running', attempt: 1, automatic: true, alert: false, createdAt: 1, updatedAt: 1 };
const rateLimit: AgentEvent = { type: 'error', terminationReason: 'failed', message: 'exceeded retry limit, last status: 429 Too Many Requests' };
const system: AgentEvent = { type: 'system', threadId: 'existing-thread' };
const final: AgentEvent = { type: 'final_text', content: JSON.stringify({ replyDraft: '已核实', analysis: '有证据', missingInfo: '' }) };
const done: AgentEvent = { type: 'done', terminationReason: 'normal' };
afterEach(() => vi.useRealTimers());

async function start(events: AgentEvent[][], timeoutMs = 30 * 60_000) {
  const workspace = await mkdtemp(join(tmpdir(), 'inbox-retry-'));
  vi.useFakeTimers();
  const agent = new FakeAgentAdapter({ capabilities: { finalAnswer: 'separate-event', input: 'unsupported' }, events });
  const controller = new AbortController();
  let retryReady!: () => void;
  const retry = new Promise<void>(resolve => { retryReady = resolve; });
  const seen: AgentEvent[] = [];
  const outcome = processInbox(job, agent, workspace, '', controller.signal, timeoutMs, event => {
    seen.push(event);
    if (event.type === 'retry' && event.delayMs > 0) retryReady();
  }).then(result => ({ result }), (error: unknown) => ({ error }));
  return { agent, controller, retry, seen, outcome };
}

it('resumes the same analysis after 429, retains its deadline and emits one successful result', async () => {
  const h = await start([[system, { type: 'tool_result', id: 'read', output: 'already checked', isError: false }, rateLimit], [final, done]]);
  await h.retry;
  await vi.advanceTimersByTimeAsync(29_999); expect(h.agent.runs).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(await h.outcome).toMatchObject({ result: { text: final.content } });
  expect(h.agent.runs).toHaveLength(2);
  expect(h.agent.runOptions[1]).toMatchObject({ ...h.agent.runOptions[0], threadId: 'existing-thread',
    prompt: expect.stringContaining('不要重复执行已完成的操作') });
  expect(h.seen.filter(e => e.type === 'error')).toEqual([]);
  expect(h.seen.filter(e => e.type === 'done')).toEqual([done]);
  expect(vi.getTimerCount()).toBe(0);
});

it('bounds consecutive 429 retries and preserves a specific failure reason', async () => {
  const h = await start([[system, rateLimit], [rateLimit], [rateLimit], [rateLimit], [final, done]]);
  await h.retry;
  await vi.advanceTimersByTimeAsync(210_000);
  expect(await h.outcome).toMatchObject({ error: { code: 'rate_limit', message: expect.stringContaining('429') } });
  expect(h.agent.runs).toHaveLength(4);
  expect(h.seen.filter(e => e.type === 'retry' && e.delayMs > 0).map(e => e.type === 'retry' && e.delayMs))
    .toEqual([30_000, 60_000, 120_000]);
  expect(vi.getTimerCount()).toBe(0);
});

it.each(['cancel', 'timeout'] as const)('stops during retry backoff on %s without another model call', async reason => {
  const h = await start([[system, rateLimit], [final, done]], reason === 'timeout' ? 15_000 : undefined);
  await h.retry;
  if (reason === 'cancel') h.controller.abort();
  else await vi.advanceTimersByTimeAsync(15_000);
  expect(await h.outcome).toMatchObject({ error: reason === 'timeout' ? { code: 'timeout' } : { name: 'AbortError' } });
  await vi.advanceTimersByTimeAsync(300_000);
  expect(h.agent.runs).toHaveLength(1);
  expect(h.agent.runs[0]?.stopped).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it.each([
  ['429 insufficient_quota', 'quota'],
  ['401 authentication failed secret=do-not-publish', 'authentication'],
  ['unexpected provider response secret=do-not-publish', 'agent'],
])('does not retry nonrecoverable errors (%s) or expose raw diagnostics', async (message, code) => {
  const h = await start([[{ type: 'error', terminationReason: 'failed', message }], [final, done]]);
  const outcome = await h.outcome;
  expect(outcome).toMatchObject({ error: { code } });
  expect('error' in outcome && String(outcome.error)).not.toContain('do-not-publish');
  expect(h.agent.runs).toHaveLength(1);
});

it('does not deliver a failed attempt\'s final text if the resumed turn has no answer', async () => {
  const h = await start([[system, final, rateLimit], [done]]);
  await h.retry; await vi.advanceTimersByTimeAsync(30_000);
  expect(await h.outcome).toMatchObject({ error: { code: 'incomplete' } });
});

it.each<{ name: string; events: AgentEvent[]; code: string }>([
  { name: 'missing terminal event', events: [], code: 'incomplete' },
  { name: 'missing result fields', events: [{ type: 'final_text', content: '{"analysis": "partial"}' }, done], code: 'invalid_result' },
  { name: 'agent timeout', events: [{ type: 'done', terminationReason: 'timeout' }], code: 'timeout' },
  { name: 'agent interruption', events: [{ type: 'error', terminationReason: 'interrupted', message: 'stopped' }], code: 'cancelled' },
])('rejects incomplete or abnormal terminal output: $name', async ({ events, code }) => {
  const h = await start([events]);
  expect(await h.outcome).toMatchObject({ error: { code } });
  expect(h.agent.runs).toHaveLength(1);
});


it('honors the configured model and effort on an isolated analysis run', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'inbox-model-'));
  const agent = new FakeAgentAdapter({ capabilities: { finalAnswer: 'separate-event', input: 'unsupported' }, events: [[final, done]] });
  await processInbox(job, agent, workspace, '', new AbortController().signal, undefined, undefined, { model: 'selected-model', reasoningEffort: 'high' });
  expect(agent.runOptions[0]).toMatchObject({ model: 'selected-model', reasoningEffort: 'high' });
});
