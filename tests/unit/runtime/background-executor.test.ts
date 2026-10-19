import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentExecutionCapabilities } from '../../../src/agent/types';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { profileExecutionCapabilities, supportsBackgroundProfile } from '../../../src/runtime/agent-capabilities';
import { executeBackgroundRun } from '../../../src/runtime/background-executor';
import { CodexAdapter } from '../../../src/agent/codex/adapter';
import { createRuntimeAgent } from '../../../src/runtime/agent-runtime';
import { FakeAgentAdapter } from '../../helpers/fake-agent';

const capabilities: AgentExecutionCapabilities = { finalAnswer: 'separate-event', input: 'unsupported' };
const done: AgentEvent = { type: 'done', terminationReason: 'normal' };
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function options() { const cwd = await mkdtemp(join(tmpdir(), 'background-contract-')); dirs.push(cwd); return { cwd, runId: 'r', prompt: 'investigate' }; }

it('collects a plain final answer from any declared backend, leaving validation to its caller', async () => {
  const agent = new FakeAgentAdapter({ id: 'unrelated-engine', capabilities, events: [
    { type: 'text', delta: 'progress only' }, { type: 'final_text', content: 'plain answer' },
    { type: 'usage', inputTokens: 10, outputTokens: 20 }, done,
  ] });
  const observed = vi.fn(); const startedAt = Date.now();
  expect(await executeBackgroundRun(agent, await options(), new AbortController().signal, observed))
    .toEqual({ text: 'plain answer', inputTokens: 10, outputTokens: 20 });
  expect(observed).toHaveBeenCalledWith({ type: 'text', delta: 'progress only' });
  expect(agent.runOptions[0]?.deadlineAt).toBeGreaterThanOrEqual(startedAt + 30 * 60_000);
  expect(agent.runs[0]?.stopped).toBe(false);
});

it('does not infer final-answer support from a Codex name or launch legacy adapters', async () => {
  const agent = new FakeAgentAdapter({ id: 'codex', events: [done] });
  await expect(executeBackgroundRun(agent, await options(), new AbortController().signal)).rejects.toMatchObject({ code: 'unsupported' });
  expect(agent.runs).toHaveLength(0);
});

it('rejects a declared adapter whose run lacks the promised capability and cleans it up', async () => {
  const agent = new FakeAgentAdapter({ capabilities });
  const legacy = new FakeAgentAdapter({ events: [done] });
  agent.run = opts => legacy.run(opts);
  await expect(executeBackgroundRun(agent, await options(), new AbortController().signal)).rejects.toMatchObject({ code: 'unsupported' });
  expect(legacy.runs[0]?.stopped).toBe(true);
});

it('does not promote progress text to an authoritative final answer', async () => {
  const agent = new FakeAgentAdapter({ capabilities, events: [{ type: 'text', delta: 'unfinished' }, done] });
  await expect(executeBackgroundRun(agent, await options(), new AbortController().signal)).rejects.toMatchObject({ code: 'incomplete' });
});

it('uses typed failures without exposing diagnostics or retrying a quota failure', async () => {
  const agent = new FakeAgentAdapter({ capabilities, events: [{ type: 'error', terminationReason: 'failed',
    failureKind: 'quota', message: '429 private-provider-diagnostic' }] });
  const error = await executeBackgroundRun(agent, await options(), new AbortController().signal).catch(error => error);
  expect(error).toMatchObject({ code: 'quota' }); expect(String(error)).not.toContain('private-provider');
  expect(agent.runs).toHaveLength(1); expect(agent.runs[0]?.stopped).toBe(true);
});

it('rejects expired work before preparing or launching an agent', async () => {
  const agent = new FakeAgentAdapter({ capabilities });
  await expect(executeBackgroundRun(agent, { ...await options(), deadlineAt: Date.now() - 1 }, new AbortController().signal))
    .rejects.toMatchObject({ code: 'timeout' });
  expect(agent.runs).toHaveLength(0);
});

it.each([undefined, 'app-server'] as const)('declares the same %s capabilities for discovery and execution', transport => {
  const profile = createDefaultProfileConfig({ agentKind: 'codex', codex: { binaryPath: 'codex', transport },
    accounts: { app: { id: 'test', secret: 'fixture', tenant: 'feishu' } } });
  const agent = new CodexAdapter({ binary: 'codex', transport, profileStateDir: '.' });
  expect(agent.capabilities.input).toBe('active-turn');
  expect(createRuntimeAgent(profile, { profileDir: '.' }).capabilities).toEqual(agent.capabilities);
  expect(profileExecutionCapabilities(profile)).toEqual(agent.capabilities);
  expect(supportsBackgroundProfile(profile)).toBe(true);
  expect(supportsBackgroundProfile({ ...profile, mode: 'team' })).toBe(false);
  expect(supportsBackgroundProfile({ ...profile, agentKind: 'claude' })).toBe(true);
});
