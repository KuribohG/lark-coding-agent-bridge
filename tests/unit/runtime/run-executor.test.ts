import { describe, expect, it } from 'vitest';
import { ActiveRuns } from '../../../src/bot/active-runs';
import { ProcessPool } from '../../../src/bot/process-pool';
import type { RunPolicyAllow } from '../../../src/policy/run-policy';
import { RunExecutor } from '../../../src/runtime/run-executor';
import { FakeAgentAdapter } from '../../helpers/fake-agent';

describe('RunExecutor policy runtime options', () => {
  it('passes policy sandbox and permission mode into each agent run', async () => {
    const agent = new FakeAgentAdapter({
      events: [{ type: 'done', terminationReason: 'normal' }],
    });
    const executor = new RunExecutor({
      agent,
      pool: new ProcessPool(() => 1),
      activeRuns: new ActiveRuns(),
      createRunId: () => 'run-policy',
      now: () => 1000,
      postDoneExitGraceMs: 10,
    });

    const execution = await executor.submit({
      scopeId: 'scope-policy',
      policy: policy({
        sandbox: 'workspace-write',
        permissionMode: 'acceptEdits',
      }),
    });

    expect(agent.runOptions[0]).toMatchObject({
      runId: 'run-policy',
      sandbox: 'workspace-write',
      permissionMode: 'acceptEdits',
    });

    await collect(execution.subscribe());
  });

  it('resolves provider-qualified models before the agent adapter sees them', async () => {
    const agent = new FakeAgentAdapter({
      events: [{ type: 'done', terminationReason: 'normal' }],
    });
    const provider = {
      id: 'deepseek',
      displayName: 'DeepSeek',
      model: 'lark_deepseek_123/deepseek-flash',
      env: { LARK_MODEL_PROVIDER_KEY_123: 'private' },
      pi: {
        providerId: 'lark_deepseek_123',
        name: 'DeepSeek',
        baseUrl: 'https://gateway.example/v1',
        api: 'openai-responses' as const,
        apiKeyEnv: 'LARK_MODEL_PROVIDER_KEY_123',
        model: {
          id: 'deepseek-flash',
          name: 'DeepSeek-Flash',
          api: 'openai-responses' as const,
          reasoning: true,
          input: ['text'] as Array<'text' | 'image'>,
          contextWindow: 1000,
          maxTokens: 100,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
      },
    };
    const executor = new RunExecutor({
      agent,
      resolveModelProvider: async (_kind, model) => model === 'deepseek/deepseek-flash' ? provider : undefined,
      pool: new ProcessPool(() => 1),
      activeRuns: new ActiveRuns(),
      createRunId: () => 'run-provider',
      now: () => 1000,
      postDoneExitGraceMs: 10,
    });

    const execution = await executor.submit({
      scopeId: 'scope-provider',
      policy: policy(),
      model: 'deepseek/deepseek-flash',
    });

    expect(agent.runOptions[0]).toMatchObject({
      model: 'lark_deepseek_123/deepseek-flash',
      modelProvider: provider,
    });
    await collect(execution.subscribe());
  });
});

function policy(overrides: Partial<RunPolicyAllow> = {}): RunPolicyAllow {
  return {
    ok: true,
    prompt: 'hello',
    requestedCwd: '/tmp/repo',
    cwdRealpath: '/tmp/repo',
    accessMode: 'workspace',
    sandbox: 'workspace-write',
    permissionMode: 'acceptEdits',
    access: { ok: true, reason: 'allowed-user' },
    attachments: [],
    policyFingerprint: 'fp',
    expiresAt: 2000,
    ...overrides,
  };
}

async function collect(events: AsyncIterable<unknown>): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const event of events) out.push(event);
  return out;
}
