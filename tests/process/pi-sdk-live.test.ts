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

    const keyFile = process.env.PI_SDK_LIVE_KEY_FILE;
    const apiKey = keyFile ? (await readFile(keyFile, 'utf8')).trim() : process.env.PI_SDK_LIVE_API_KEY;
    const provider: ResolvedModelProvider = {
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
});

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const all: AgentEvent[] = [];
  for await (const event of events) all.push(event);
  return all;
}
