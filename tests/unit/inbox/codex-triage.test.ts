import { expect, it, vi } from 'vitest';
import type { AgentAdapter, AgentEvent, AgentRunOptions } from '../../../src/agent/types';
import type { InboxJob } from '../../../src/inbox/types';
import { createTriageAgent, triageFailureReason, triageWithCodex } from '../../../src/inbox/codex-triage';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { resolveAppPaths } from '../../../src/config/app-paths';
import { createRuntimeAgent } from '../../../src/runtime/agent-runtime';

vi.mock('../../../src/runtime/agent-runtime', () => ({ createRuntimeAgent: vi.fn() }));
const job = (id: string): InboxJob => ({ id, ownerOpenId: 'ou_owner', source: { chatId: 'oc_source', name: 'test', type: 'p2p' }, messages: [] } as unknown as InboxJob);
const answer = (id: string, state = 'quiet') => ({ id, state, reason: '具体事实', priority: 'normal' });
function fixture(events: (options: AgentRunOptions) => AsyncIterable<AgentEvent>) {
  const stop = vi.fn(async () => {}), waitForExit = vi.fn(async () => true);
  const run = vi.fn((opts: AgentRunOptions) => ({ runId: opts.runId, events: events(opts), stop, waitForExit }));
  return { agent: { run } as unknown as AgentAdapter, run, stop };
}
it('inherits provider, home, MCP environment and workspace without changing the profile default model', () => {
  const profile = createDefaultProfileConfig({ agentKind: 'codex', accounts: { app: { id: 'cli_test', secret: 'fixture', tenant: 'feishu' } }, codex: { binaryPath: 'codex', transport: 'app-server', codexHome: '/private/codex', ignoreUserConfig: false, ignoreRules: false } });
  profile.preferences.model = 'default-model';
  const paths = resolveAppPaths({ rootDir: '/private/bridge', profile: 'codex' });
  createTriageAgent(profile, paths);
  expect(createRuntimeAgent).toHaveBeenCalledWith(expect.objectContaining({ codex: profile.codex, preferences: profile.preferences }), paths);
  expect(profile.preferences.model).toBe('default-model');
});
it('runs flash with tools, streams provisional reasons and only accepts the authoritative complete final answer', async () => {
  const progress = vi.fn();
  const f = fixture(async function* (opts) {
    yield { type: 'thinking', delta: 'private-reasoning' };
    yield { type: 'tool_use', id: 'tool', name: 'exec', input: { secret: 'never-show' } };
    yield { type: 'tool_result', id: 'tool', output: 'private-tool-result', isError: false };
    opts.onMessageDelta!('item1', '{"items":[{"id":"a","reason":"需要\\u786');
    expect(progress).toHaveBeenLastCalledWith([{ id: 'a', text: '需要' }]);
    opts.onMessageDelta!('item1', 'e认"}]}');
    expect(progress).toHaveBeenLastCalledWith([{ id: 'a', text: '需要确认' }]);
    yield { type: 'text', delta: '查询说明，不能当作结果' };
    yield { type: 'final_text', content: JSON.stringify({ items: [answer('a', 'needed')] }) };
    yield { type: 'done', terminationReason: 'normal' };
  });
  expect(await triageWithCodex([job('a')], 'CI blockers', f.agent, '/workspace', new AbortController().signal, progress)).toEqual([answer('a', 'needed')]);
  expect(f.run).toHaveBeenCalledWith(expect.objectContaining({ cwd: '/workspace', model: 'deepseek-flash', deadlineAt: expect.any(Number) }));
  expect(JSON.stringify(progress.mock.calls)).not.toMatch(/private-|never-show/);
  expect(f.stop).not.toHaveBeenCalled();
});
it.each(['missing', 'duplicate', 'failed', 'partial'] as const)('rejects %s results for automatic retry', async kind => {
  const f = fixture(async function* () {
    if (kind === 'failed') { yield { type: 'error', message: 'HTTP 429 Bearer secret', terminationReason: 'failed' }; return; }
    yield { type: 'final_text', content: JSON.stringify({ items: kind === 'missing' ? [] : kind === 'duplicate' ? [answer('a'), answer('a')] : [answer('a')] }) };
    if (kind !== 'partial') yield { type: 'done', terminationReason: 'normal' };
  });
  await expect(triageWithCodex([job('a')], '', f.agent, '/workspace', new AbortController().signal)).rejects.toThrow();
});
it('retains genuine uncertainty and returns temporary query failures for retry', async () => {
  const f = fixture(async function* () {
    yield { type: 'final_text', content: JSON.stringify({ items: [answer('a', 'uncertain'), answer('b', 'retry')] }) };
    yield { type: 'done', terminationReason: 'normal' };
  });
  const result = await triageWithCodex([job('a'), job('b')], '', f.agent, '/workspace', new AbortController().signal);
  expect(result.map(r => r.state)).toEqual(['uncertain', 'pending']);
});
it('passes all 50 items and refuses oversize batches before launching a child', async () => {
  const jobs = Array.from({ length: 50 }, (_, i) => job(String(i)));
  const f = fixture(async function* (opts) {
    for (const j of jobs) expect(opts.prompt).toContain(`"id":"${j.id}"`);
    yield { type: 'final_text', content: JSON.stringify({ items: jobs.map(j => answer(j.id)) }) };
    yield { type: 'done', terminationReason: 'normal' };
  });
  expect(await triageWithCodex(jobs, '', f.agent, '/workspace', new AbortController().signal)).toHaveLength(50);
  await expect(triageWithCodex([...jobs, job('extra')], '', f.agent, '/workspace', new AbortController().signal)).rejects.toThrow('50');
  expect(f.run).toHaveBeenCalledTimes(1);
});
it('stops the child on cancellation and does not accept late results', async () => {
  const controller = new AbortController();
  const f = fixture(async function* () {
    controller.abort();
    yield { type: 'final_text', content: JSON.stringify({ items: [answer('a')] }) };
    yield { type: 'done', terminationReason: 'normal' };
  });
  await expect(triageWithCodex([job('a')], '', f.agent, '/workspace', controller.signal)).rejects.toThrow();
  expect(f.stop).toHaveBeenCalledTimes(1);
});
it('expires a stuck execution and redacts operational errors', async () => {
  let finish!: () => void;
  const f = fixture(async function* () { await new Promise<void>(r => { finish = r; }); yield { type: 'done', terminationReason: 'interrupted' }; });
  f.stop.mockImplementation(async () => { finish(); });
  await expect(triageWithCodex([job('a')], '', f.agent, '/workspace', new AbortController().signal, undefined, 10)).rejects.toThrow('超时');
  expect(f.stop).toHaveBeenCalledTimes(1);
  expect(triageFailureReason(Error('HTTP 401 Bearer sensitive-token'))).toBe('工具或模型授权暂不可用');
});
