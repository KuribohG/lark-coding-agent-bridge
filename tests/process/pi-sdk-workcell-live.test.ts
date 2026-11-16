import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PiSdkAdapter } from '../../src/agent/pi-sdk/adapter';
import type { AgentEvent } from '../../src/agent/types';
import type { PiConfig } from '../../src/agent/pi/config';
import type { ResolvedModelProvider } from '../../src/model-provider/types';

// Opt-in end-to-end run: a real workcell provider rents a real unit, the bridge
// pushes the runtime and the workspace, starts the host inside it and drives it
// over the forwarded port. Needs:
//   PI_WORKCELL_LIVE_PROVIDER=/path/to/provider.py
//   PI_SDK_LIVE_SDK=/…/pi-coding-agent/dist/index.js
//   PI_SDK_LIVE_NODE=/…/node/bin/node
//   PI_SDK_LIVE_KEY_FILE=/…/model-provider.key   (optional)

const provider = process.env.PI_WORKCELL_LIVE_PROVIDER;
const sdkPath = process.env.PI_SDK_LIVE_SDK;
const nodePath = process.env.PI_SDK_LIVE_NODE;
const live = Boolean(provider && sdkPath && nodePath && existsSync(provider));

const dirs: string[] = [];
const adapters: PiSdkAdapter[] = [];

afterEach(async () => {
  for (const adapter of adapters.splice(0)) await adapter.shutdown();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })));
});

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

describe.skipIf(!live)('pi SDK host inside a real workcell', () => {
  it('rents a unit, reads a pushed workspace with a real model and stops the unit on shutdown', async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'pi-workcell-live-')));
    dirs.push(dir);

    // Only this profile's credentials travel into the unit.
    const agentDir = join(dir, 'agent');
    await mkdir(agentDir, { recursive: true });
    const shared = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent');
    for (const file of ['auth.json', 'models.json', 'settings.json']) {
      if (existsSync(join(shared, file))) await cp(join(shared, file), join(agentDir, file));
    }

    // The workspace is copied into the unit, so a file written here is the
    // proof that the copy arrived.
    const workspace = join(dir, 'work');
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, 'probe.txt'), 'WORKCELL-READY\n');

    const config: PiConfig = {
      binaryPath: nodePath!,
      transport: 'sdk',
      sdkPath: sdkPath!,
      nodePath: nodePath!,
      hostScript: join(process.cwd(), 'bin', 'pi-host.mjs'),
      agentDir,
      workcell: { provider: provider!, cpu: 4, memoryGb: 8, ttlSeconds: 900, network: ['lan'] },
    };
    const adapter = new PiSdkAdapter({ config, systemPrompt: '只回复用户要求的内容，尽量短。', profileStateDir: dir, stopGraceMs: 2000 });
    adapters.push(adapter);

    const providerInfo = await liveProvider();
    const events = await collect((await adapter.prepareRun({
      runId: 'workcell-live',
      prompt: '用 read 工具读取当前目录下的 probe.txt，只回复文件内容（不要解释）。',
      cwd: workspace,
      host: { key: 'live-member' },
      model: providerInfo.model,
      modelProvider: providerInfo,
      reasoningEffort: 'low',
    })).start().events);

    const finalText = events.find((event) => event.type === 'final_text') as { content?: string } | undefined;
    expect(finalText?.content).toContain('WORKCELL-READY');
    expect(events.at(-1)).toMatchObject({ type: 'done', terminationReason: 'normal' });

    await adapter.shutdown();
  }, 20 * 60_000);
});
