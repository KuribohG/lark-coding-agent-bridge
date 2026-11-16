import { existsSync } from 'node:fs';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { PiSdkAdapter } from '../../src/agent/pi-sdk/adapter';
import type { AgentEvent } from '../../src/agent/types';
import type { PiConfig } from '../../src/agent/pi/config';
import type { ResolvedModelProvider } from '../../src/model-provider/types';

// Opt-in live test: exercises the real Pi SDK host and one real model call.
// It needs the SDK entry, a Node >= 22.19 and a provider API key file:
//   PI_SDK_LIVE_SDK=/…/pi-coding-agent/dist/index.js
//   PI_SDK_LIVE_NODE=/…/node/bin/node
//   PI_SDK_LIVE_KEY_FILE=/…/model-provider.key  (optional)
const sdkPath = process.env.PI_SDK_LIVE_SDK;
const nodePath = process.env.PI_SDK_LIVE_NODE;
const live = Boolean(sdkPath && nodePath && existsSync(sdkPath) && existsSync(nodePath));
const hostScript = fileURLToPath(new URL('../../bin/pi-host.mjs', import.meta.url));
const dirs: string[] = [];
const adapters: PiSdkAdapter[] = [];

afterEach(async () => {
  for (const adapter of adapters.splice(0)) await adapter.shutdown();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })));
});

describe.skipIf(!live)('PiSdkAdapter live host', () => {
  it('is available, prompts a real model and resumes after a host restart', async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'pi-sdk-live-')));
    dirs.push(dir);
    const config: PiConfig = {
      binaryPath: nodePath!,
      transport: 'sdk',
      sdkPath: sdkPath!,
      nodePath: nodePath!,
      hostScript,
      agentDir: join(dir, 'agent'),
    };
    const adapter = new PiSdkAdapter({ config, systemPrompt: '只回复用户要求的内容，尽量短。' });
    adapters.push(adapter);
    expect(await adapter.checkAvailability()).toMatchObject({ ok: true });

    const provider = await liveProvider();

    const first = await collect((await adapter.prepareRun({
      runId: 'live-1',
      prompt: '请只回复两个字母：OK',
      cwd: dir,
      model: provider.model,
      modelProvider: provider,
      reasoningEffort: 'low',
    })).start().events);
    const finalText = first.find((event) => event.type === 'final_text');
    expect(finalText).toMatchObject({ type: 'final_text' });
    expect((finalText as { content: string }).content).toMatch(/OK/i);
    const sessionId = first.find((event) => event.type === 'system')?.sessionId;
    expect(sessionId).toBeTruthy();

    // Restart the host: the session must reopen from its JSONL file.
    await adapter.shutdown();
    const second = await collect((await adapter.prepareRun({
      runId: 'live-2',
      prompt: '你上一条回答的原文是什么？只回复那两个字。',
      cwd: dir,
      sessionId: sessionId!,
      model: provider.model,
      modelProvider: provider,
      reasoningEffort: 'low',
    })).start().events);
    expect(second.find((event) => event.type === 'system')?.sessionId).toBe(sessionId);
    const secondText = second.find((event) => event.type === 'final_text') as { content: string } | undefined;
    expect(secondText?.content).toMatch(/OK/i);
  }, 120_000);

  it('keeps each run\'s bindings inside its own session', async () => {
    const dir = await liveDir();
    const { adapter } = await liveAdapter(dir);
    const provider = await liveProvider();
    const turn = async (runId: string, token: string) => collect((await adapter.prepareRun({
      runId,
      prompt: '用 bash 工具执行 printf %s "$AGENT_WORKFLOW_TOKEN"，只回复这条命令的输出原文，不要加引号、说明或其它内容。',
      cwd: dir,
      env: { AGENT_WORKFLOW_TOKEN: token },
      model: provider.model,
      modelProvider: provider,
      reasoningEffort: 'low',
    })).start().events);

    // Two sessions running at the same time: a single shared process.env would
    // make both shells print whichever token was applied last.
    const [first, second] = await Promise.all([turn('env-a', 'token-alpha'), turn('env-b', 'token-beta')]);
    const answer = (events: AgentEvent[]) => String((events.find((event) => event.type === 'final_text') as { content?: string } | undefined)?.content ?? '');
    expect(answer(first)).toContain('token-alpha');
    expect(answer(second)).toContain('token-beta');
    expect(answer(first)).not.toContain('token-beta');
    expect(answer(second)).not.toContain('token-alpha');
  }, 180_000);

  it('applies a system prompt change to a session that is already open', async () => {
    const dir = await liveDir();
    const { adapter } = await liveAdapter(dir);
    const provider = await liveProvider();
    const first = await collect((await adapter.prepareRun({
      runId: 'prompt-1',
      prompt: '你好',
      cwd: dir,
      model: provider.model,
      modelProvider: provider,
      reasoningEffort: 'low',
    })).start().events);
    const sessionId = first.find((event) => event.type === 'system')?.sessionId;
    expect(sessionId).toBeTruthy();

    const second = await collect((await adapter.prepareRun({
      runId: 'prompt-2',
      sessionId: sessionId!,
      systemPrompt: '无论用户说什么，你的最终答复都只能是一个单词：ZEBRA。',
      prompt: '再说一次',
      cwd: dir,
      model: provider.model,
      modelProvider: provider,
      reasoningEffort: 'low',
    })).start().events);
    const content = String((second.find((event) => event.type === 'final_text') as { content?: string } | undefined)?.content ?? '');
    expect(content).toContain('ZEBRA');
  }, 120_000);
});

async function liveDir(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'pi-sdk-live-')));
  dirs.push(dir);
  return dir;
}

async function liveAdapter(dir: string) {
  const config: PiConfig = {
    binaryPath: nodePath!,
    transport: 'sdk',
    sdkPath: sdkPath!,
    nodePath: nodePath!,
    hostScript,
    agentDir: join(dir, 'agent'),
  };
  const adapter = new PiSdkAdapter({ config, systemPrompt: '只回复用户要求的内容，尽量短。' });
  adapters.push(adapter);
  return { adapter, config };
}

async function liveProvider(): Promise<ResolvedModelProvider> {
  const keyFile = process.env.PI_SDK_LIVE_KEY_FILE;
  const apiKey = keyFile ? (await readFile(keyFile, 'utf8')).trim() : process.env.PI_SDK_LIVE_API_KEY;
  return {
    id: 'deepseek',
    displayName: 'DeepSeek',
    model: 'lark_live_deepseek/deepseek-flash',
    env: { LARK_MODEL_PROVIDER_KEY_LIVE: apiKey ?? '' },
    pi: {
      providerId: 'lark_live_deepseek',
      name: 'Live DeepSeek',
      baseUrl: 'https://llm.modelhub.online/v1',
      api: 'openai-responses',
      apiKeyEnv: 'LARK_MODEL_PROVIDER_KEY_LIVE',
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
