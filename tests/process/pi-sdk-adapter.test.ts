import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PiSdkAdapter } from '../../src/agent/pi-sdk/adapter';
import type { AgentEvent } from '../../src/agent/types';
import type { PiConfig } from '../../src/agent/pi/config';
import type { ResolvedModelProvider } from '../../src/model-provider/types';

// The test host runs on the CI Node, which may predate the SDK's 22.19 floor.
vi.mock('../../src/agent/preflight', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/agent/preflight')>(),
  checkAgentAvailability: vi.fn(async () => ({ ok: true as const, version: 'v22.23.3' })),
}));

const fixtureHost = fileURLToPath(new URL('../fixtures/pi-sdk/fake-host.mjs', import.meta.url));
const adapters: PiSdkAdapter[] = [];
const dirs: string[] = [];
const envKeys = [
  'FAKE_HOST_RECORD',
  'FAKE_HOST_EVENTS',
  'FAKE_HOST_ABORT_EVENTS',
  'FAKE_HOST_EVENT_DELAY_MS',
  'FAKE_HOST_HOLD_MS',
  'FAKE_HOST_OPEN_ERROR',
  'FAKE_HOST_PROMPT_ERROR',
  'FAKE_HOST_EXIT_AFTER_PROMPT',
];

afterEach(async () => {
  for (const adapter of adapters.splice(0)) await adapter.shutdown();
  for (const key of envKeys) delete process.env[key];
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })));
});

describe('PiSdkAdapter process contract', () => {
  it('runs a prompt through the host and maps SDK events', async () => {
    const harness = await createAdapter({
      FAKE_HOST_EVENTS: JSON.stringify([
        { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'OK' } },
        {
          type: 'message_end',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'OK' }],
            stopReason: 'stop',
            usage: { input: 2, output: 1, cacheRead: 0, cost: { total: 0 } },
          },
        },
        { type: 'agent_settled', aborted: false },
      ]),
    });

    const run = (await harness.adapter.prepareRun({
      runId: 'run-1',
      prompt: 'hello <bridge_context>',
      cwd: harness.dir,
      sessionId: 'sess-old',
      model: 'openai-codex/gpt-6.1-sol',
      reasoningEffort: 'high',
      sandbox: 'read-only',
      env: { LARK_WORKFLOW_ID: 'w-1' },
    })).start();

    expect(run.capabilities).toEqual({ finalAnswer: 'separate-event', input: 'active-turn' });
    expect(await collect(run.events)).toEqual([
      { type: 'system', sessionId: 'sess-old', cwd: await realpath(harness.dir) },
      { type: 'text', delta: 'OK' },
      { type: 'usage', inputTokens: 2, outputTokens: 1, cachedInputTokens: 0, costUsd: 0 },
      { type: 'final_text', content: 'OK' },
      { type: 'done', sessionId: 'sess-old', terminationReason: 'normal' },
    ]);
    expect(await run.waitForExit(1000)).toBe(true);

    const calls = await harness.calls();
    expect(calls.map((call) => call.cmd)).toEqual(['session.open', 'run.prompt']);
    expect(calls[0]!.params).toMatchObject({
      sessionId: 'sess-old',
      cwd: await realpath(harness.dir),
      systemPrompt: 'BRIDGE SYSTEM PROMPT',
      tools: ['read', 'grep', 'find', 'ls'],
      noExtensions: true,
      model: 'openai-codex/gpt-6.1-sol',
      thinkingLevel: 'high',
      runEnv: { LARK_WORKFLOW_ID: 'w-1' },
    });
    expect(calls[1]!.params).toMatchObject({
      sessionId: 'sess-old',
      runId: 'run-1',
      text: 'hello <bridge_context>',
      systemPrompt: 'BRIDGE SYSTEM PROMPT',
      thinkingLevel: 'high',
      runEnv: { LARK_WORKFLOW_ID: 'w-1' },
    });
  });

  it('forks a parent session and keeps the provider registration out of argv', async () => {
    const harness = await createAdapter({
      FAKE_HOST_EVENTS: JSON.stringify([{ type: 'agent_settled', aborted: false }]),
    });
    const provider = providerFixture();

    const run = (await harness.adapter.prepareRun({
      runId: 'run-fork',
      prompt: 'side question',
      cwd: harness.dir,
      sessionId: 'sess-parent',
      forkSession: true,
      model: provider.model,
      modelProvider: provider,
    })).start();
    expect(await collect(run.events)).toEqual([
      { type: 'system', sessionId: 'sess-fork', cwd: await realpath(harness.dir) },
      { type: 'done', sessionId: 'sess-fork', terminationReason: 'normal' },
    ]);

    const calls = await harness.calls();
    expect(calls[0]!.params).toMatchObject({
      forkFrom: 'sess-parent',
      model: 'lark_deepseek_abc/deepseek-flash',
      modelProvider: provider.pi,
      providerEnv: provider.env,
      noExtensions: false,
    });
    expect(calls[0]!.params).not.toHaveProperty('sessionId');
    expect((await harness.record()).argv.join(' ')).not.toContain('provider-secret');
  });

  it('steers the active run and reports active-turn scope', async () => {
    const harness = await createAdapter({
      FAKE_HOST_EVENTS: JSON.stringify([
        { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'A' } },
        { type: 'agent_settled', aborted: false },
      ]),
      FAKE_HOST_HOLD_MS: '400',
    });

    const run = (await harness.adapter.prepareRun({ runId: 'run-steer', prompt: 'go', cwd: harness.dir })).start();
    const iterator = run.events[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toMatchObject({ type: 'system' });
    expect((await iterator.next()).value).toEqual({ type: 'text', delta: 'A' });

    const receipt = await run.sendInput!({ text: 'also do this', messageId: 'm-1', images: ['/tmp/a.png'] });
    expect(receipt).toEqual({ status: 'accepted', messageId: 'm-1', scope: 'active-turn' });

    const rest: AgentEvent[] = [];
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      rest.push(next.value);
    }
    expect(rest.at(-1)).toMatchObject({ type: 'done', terminationReason: 'normal' });
    expect((await harness.calls()).find((call) => call.cmd === 'run.steer')?.params).toMatchObject({
      sessionId: 'sess-1',
      runId: 'run-steer',
      text: 'also do this',
      images: ['/tmp/a.png'],
    });
  });

  it('aborts a run on stop and reports interruption', async () => {
    const harness = await createAdapter({
      FAKE_HOST_EVENTS: JSON.stringify([
        { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'started' } },
        { type: 'message_update', assistantMessageEvent: { type: 'text_end', contentIndex: 0, content: 'started' } },
      ]),
      FAKE_HOST_HOLD_MS: '15000',
    });

    const run = (await harness.adapter.prepareRun({ runId: 'run-stop', prompt: 'go', cwd: harness.dir })).start();
    const iterator = run.events[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toMatchObject({ type: 'system' });

    expect((await iterator.next()).value).toEqual({ type: 'text', delta: 'started' });
    const rest: AgentEvent[] = [];
    const drain = (async () => {
      for (;;) {
        const next = await iterator.next();
        if (next.done) return;
        rest.push(next.value);
      }
    })();

    await run.stop('cancelled');
    await drain;
    expect(rest.at(-1)).toEqual({ type: 'done', sessionId: 'sess-1', terminationReason: 'interrupted' });
    expect((await harness.calls()).some((call) => call.cmd === 'run.abort')).toBe(true);
  });

  it('reports a deadline as a timeout', async () => {
    const harness = await createAdapter({
      FAKE_HOST_EVENTS: JSON.stringify([{ type: 'agent_settled', aborted: true }]),
      FAKE_HOST_EVENT_DELAY_MS: '5000',
      FAKE_HOST_HOLD_MS: '5000',
    });

    const run = (await harness.adapter.prepareRun({
      runId: 'run-deadline',
      prompt: 'go',
      cwd: harness.dir,
      deadlineAt: Date.now() + 150,
    })).start();
    const events = await collect(run.events);
    expect(events.at(-1)).toEqual({ type: 'done', sessionId: 'sess-1', terminationReason: 'timeout' });
    expect(events.some((event) => event.type === 'error')).toBe(false);
  });

  it('surfaces host failures as errors', async () => {
    const openFailure = await createAdapter({ FAKE_HOST_OPEN_ERROR: 'sdk import failed' });
    expect(await collect((await openFailure.adapter.prepareRun({
      runId: 'run-open-error',
      prompt: 'go',
      cwd: openFailure.dir,
    })).start().events)).toEqual([
      {
        type: 'error',
        message: 'pi sdk session failed: sdk import failed',
        terminationReason: 'failed',
        failureKind: 'runtime',
      },
    ]);

    const hostExit = await createAdapter({ FAKE_HOST_EXIT_AFTER_PROMPT: '1' });
    const events = await collect((await hostExit.adapter.prepareRun({
      runId: 'run-host-exit',
      prompt: 'go',
      cwd: hostExit.dir,
    })).start().events);
    expect(events[0]).toMatchObject({ type: 'system' });
    expect(events.at(-1)).toMatchObject({ type: 'error', terminationReason: 'failed', failureKind: 'runtime' });
  });

  it('keeps the shared host alive until the active run finishes, then disposes it', async () => {
    const harness = await createAdapter({
      FAKE_HOST_EVENTS: JSON.stringify([
        { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'OK' } },
        {
          type: 'message_end',
          message: { role: 'assistant', content: [{ type: 'text', text: 'OK' }], stopReason: 'stop', usage: { input: 1, output: 1, cacheRead: 0, cost: { total: 0 } } },
        },
      ]),
      FAKE_HOST_EVENT_DELAY_MS: '10',
      FAKE_HOST_HOLD_MS: '400',
    });

    const run = (await harness.adapter.prepareRun({ runId: 'run-draining', prompt: 'go', cwd: harness.dir })).start();
    const rest: AgentEvent[] = [];
    const drain = (async () => {
      for await (const event of run.events) rest.push(event);
    })();
    await waitUntil(async () => rest.some((event) => event.type === 'text'));

    let disposed = false;
    const shutdown = harness.adapter.shutdown().then(() => { disposed = true; });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(disposed).toBe(false);

    await drain;
    await shutdown;
    expect(disposed).toBe(true);
    expect(rest.at(-1)).toMatchObject({ type: 'done', terminationReason: 'normal' });
    expect((await harness.calls()).map((call) => call.cmd)).toContain('shutdown');
  });
});

interface Harness {
  dir: string;
  adapter: PiSdkAdapter;
  calls(): Promise<Array<{ cmd: string; params: Record<string, unknown> }>>;
  record(): Promise<{ argv: string[]; calls: Array<{ cmd: string; params: Record<string, unknown> }> }>;
}

async function createAdapter(env: Record<string, string>): Promise<Harness> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'pi-sdk-adapter-')));
  dirs.push(dir);
  for (const key of envKeys) delete process.env[key];
  const recordPath = join(dir, 'host-record.json');
  Object.assign(process.env, env, { FAKE_HOST_RECORD: recordPath });
  const config: PiConfig = {
    binaryPath: join(dir, 'pi'),
    transport: 'sdk',
    sdkPath: fixtureHost,
    nodePath: process.execPath,
    hostScript: fixtureHost,
    agentDir: join(dir, 'agent'),
  };
  const adapter = new PiSdkAdapter({ config, systemPrompt: 'BRIDGE SYSTEM PROMPT', stopGraceMs: 1000 });
  adapters.push(adapter);
  const harness: Harness = {
    dir,
    adapter,
    async record() {
      const { readFile } = await import('node:fs/promises');
      return JSON.parse(await readFile(recordPath, 'utf8')) as {
        argv: string[];
        calls: Array<{ cmd: string; params: Record<string, unknown> }>;
      };
    },
    async calls() {
      return (await harness.record()).calls;
    },
  };
  return harness;
}

function providerFixture(): ResolvedModelProvider {
  return {
    id: 'deepseek',
    displayName: 'DeepSeek',
    model: 'lark_deepseek_abc/deepseek-flash',
    env: { LARK_MODEL_PROVIDER_KEY_ABC: 'provider-secret' },
    pi: {
      providerId: 'lark_deepseek_abc',
      name: 'DeepSeek',
      baseUrl: 'https://gateway.example/v1',
      api: 'openai-responses',
      apiKeyEnv: 'LARK_MODEL_PROVIDER_KEY_ABC',
      model: {
        id: 'deepseek-flash',
        name: 'DeepSeek-Flash',
        api: 'openai-responses',
        reasoning: true,
        input: ['text', 'image'],
        contextWindow: 1_048_576,
        maxTokens: 384_000,
        cost: { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 },
      },
    },
  };
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const all: AgentEvent[] = [];
  for await (const event of events) all.push(event);
  return all;
}

async function waitUntil(predicate: () => Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('condition was not met in time');
}
