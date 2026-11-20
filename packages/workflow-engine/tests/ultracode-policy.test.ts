import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkflowRuntime, type WorkerRunSpec, type WorkflowRoot } from '../src';
import { workflowToolDefinitions } from '../src/engine/host-tools';
import { hostToolInstructions, WORKFLOW_TOOL_INSTRUCTIONS } from '../src/engine/tools/instructions';
import type { ExecutionObservation } from '../src/engine/types';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

const root: WorkflowRoot = {
  scopeId: 'ultra',
  profile: 'default',
  agentKind: 'codex',
  cwdRealpath: '/workspace',
  policyFingerprint: 'policy',
  catalogBinding: 'root',
  modelSettings: {},
};

describe('ultracode native engine policy and metadata', () => {
  it('propagates roleLabel, readOnly, memberKey, scriptKey, and scriptOutput to WorkerRunSpec and workflowSummary', async () => {
    const specs: WorkerRunSpec[] = [];
    const runtime = new WorkflowRuntime({
      path: ':memory:',
      hostTools: true,
      resolveRoot: async () => root,
      wakeMain: async () => {},
      runner: {
        async start(spec) {
          specs.push(spec);
          await spec.validateBeforeRun();
          const text = JSON.stringify({ findings: [] });
          return {
            runId: 'run-' + specs.length,
            result: Promise.resolve('completed'),
            stop: async () => {},
            waitForExit: async () => true,
            stopReason: () => undefined,
            async *events() {
              yield { type: 'session', nativeSessionId: 'native-' + specs.length };
              yield { type: 'final_text', text };
              yield { type: 'done', normal: true };
            },
          };
        },
      },
    });
    await runtime.start();
    cleanup.push(() => runtime.close());

    const main = runtime.bindMain(root.scopeId, 'start');
    cleanup.push(async () => main.release());
    await main.call!('run_script', {
      operationId: randomUUID(),
      goal: 'audit module',
      plan: 'Run one-off specialist and swarm specialist.',
      readOnly: true,
      script: `
        const one = await agent("audit security", { key: "sec-1", role: "security-redteam", output: "json", onError: "throw" });
        const team = await swarm("cross-check", {
          key: "team-1",
          maxTurns: 1,
          members: [{ name: "alice", role: "concurrency-auditor" }]
        });
        return { one, stop: team.stop };
      `,
    });

    await vi.waitFor(async () => {
      await runtime.tick();
      expect(runtime.kernel.state(root.scopeId)?.script?.status).toBe('result_ready');
    });

    expect(specs).toHaveLength(2);
    expect(specs[0]).toMatchObject({
      taskId: expect.any(String),
      scriptKey: 'sec-1',
      roleLabel: 'security-redteam',
      readOnly: true,
      scriptOutput: 'json',
    });
    expect(specs[0]!.memberKey).toBeUndefined();
    expect(specs[1]).toMatchObject({
      taskId: expect.any(String),
      memberKey: 'alice',
      roleLabel: 'concurrency-auditor',
      readOnly: true,
      scriptOutput: 'text',
    });

    const summary = await main.call!('status', {}) as { tasks: Array<{ scriptKey?: string; roleLabel?: string; readOnly?: boolean }>; script?: { readOnly?: boolean } };
    expect(summary.script?.readOnly).toBe(true);
    expect(summary.tasks.find(t => t.scriptKey === 'sec-1')).toMatchObject({
      roleLabel: 'security-redteam',
      readOnly: true,
    });
    expect(summary.tasks.find(t => t.roleLabel === 'concurrency-auditor')).toMatchObject({
      roleLabel: 'concurrency-auditor',
      readOnly: true,
    });
  });

  it('blocks workspace creation, writable swarm members, staff_swarm workspaces, and submit_work when readOnly is true', async () => {
    const specs: WorkerRunSpec[] = [];
    const workspaceOps: unknown[] = [];
    const runtime = new WorkflowRuntime({
      path: ':memory:',
      hostTools: true,
      workspaceRoot: '/tmp/ws',
      authorizeWorkspace: async () => {},
      resolveRoot: async () => root,
      wakeMain: async () => {},
      runner: {
        async start(spec) {
          specs.push(spec);
          await spec.validateBeforeRun();
          return {
            runId: 'run-' + specs.length,
            result: Promise.resolve('completed'),
            stop: async () => {},
            waitForExit: async () => true,
            stopReason: () => undefined,
            async *events() {
              yield { type: 'session', nativeSessionId: 'native-' + specs.length };
              yield { type: 'final_text', text: 'done' };
              yield { type: 'done', normal: true };
            },
          };
        },
      },
    });
    await runtime.start();
    cleanup.push(() => runtime.close());
    const main = runtime.bindMain(root.scopeId, 'start');
    cleanup.push(async () => main.release());

    await main.call!('run_script', {
      operationId: randomUUID(),
      goal: 'read-only enforcement',
      plan: 'Verify workspace calls fail cleanly under readOnly:true.',
      readOnly: true,
      script: `
        const errors = [];
        try { await createWorkspace({ key: "ws1" }); } catch (e) { errors.push("create:" + e.message); }
        try { await agent("edit", { key: "w1", workspace: "ws1", onError: "throw" }); } catch (e) { errors.push("agentWs:" + e.message); }
        try { await agent("ro-ws", { key: "w2", readOnly: true, workspace: "ws1", onError: "throw" }); } catch (e) { errors.push("roAgentWs:" + e.message); }
        try {
          await swarm("t", { key: "sw1", members: [{ name: "m1", workspace: "ws1" }], onError: "throw" });
        } catch (e) { errors.push("swarmWs:" + e.message); }
        return errors;
      `,
    });

    await vi.waitFor(async () => {
      await runtime.tick();
      expect(runtime.kernel.state(root.scopeId)?.script?.status).toBe('result_ready');
    });

    const state = runtime.kernel.state(root.scopeId)!;
    const resultArtifact = state.artifacts.find(a => a.ref === state.script?.resultRef)!;
    const errors = JSON.parse(resultArtifact.text) as string[];
    expect(errors).toHaveLength(4);
    expect(errors[0]).toContain('read-only');
    expect(errors[1]).toContain('read-only');
    expect(errors[2]).toContain('Read-only agent cannot use a writable workspace');
    expect(errors[3]).toContain('read-only');
    expect(workspaceOps).toHaveLength(0);

    // Also verify staff_swarm({ workspace }) and worker submit_work are rejected on readOnly workflows.
    const runtime2 = new WorkflowRuntime({
      path: ':memory:',
      hostTools: true,
      workspaceRoot: '/tmp/ws2',
      authorizeWorkspace: async () => {},
      resolveRoot: async () => ({ ...root, scopeId: 'ultra-staff' }),
      wakeMain: async () => {},
      runner: {
        async start(spec) {
          await spec.validateBeforeRun();
          let submitError = '';
          try {
            await runtime2.call(
              { kind: 'worker', scopeId: 'ultra-staff', workflowId: runtime2.kernel.state('ultra-staff')!.workflowId, taskId: spec.taskId!, attemptId: spec.attemptId },
              'submit_work',
              { operationId: randomUUID() },
            );
          } catch (e) {
            submitError = e instanceof Error ? e.message : String(e);
          }
          return {
            runId: 'run-staff',
            result: Promise.resolve('completed'),
            stop: async () => {},
            waitForExit: async () => true,
            stopReason: () => undefined,
            async *events() {
              yield { type: 'session', nativeSessionId: 'native-staff' };
              yield { type: 'final_text', text: submitError };
              yield { type: 'done', normal: true };
            },
          };
        },
      },
    });
    await runtime2.start();
    cleanup.push(() => runtime2.close());
    const main2 = runtime2.bindMain('ultra-staff', 'start');
    cleanup.push(async () => main2.release());
    await main2.call!('run_script', {
      operationId: randomUUID(),
      goal: 'read-only swarm staff check',
      plan: 'Start swarm then verify staff_swarm workspace rejection.',
      readOnly: true,
      script: `
        return await swarm("inspect", {
          key: "s1",
          lead: { name: "lead", role: "coordinator" },
          members: [{ name: "scout", role: "scout" }],
          maxTurns: 2
        });
      `,
    });
    await vi.waitFor(async () => {
      await runtime2.tick();
      expect(runtime2.kernel.state('ultra-staff')?.swarms?.[0]?.turns.length).toBeGreaterThanOrEqual(2);
    });
    await expect(
      main2.call!('staff_swarm', { operationId: randomUUID(), swarm: 's1', add: ['extra'], workspace: true }),
    ).rejects.toThrow('read-only');
    await expect(
      main2.call!('configure_landing', { operationId: randomUUID(), branch: 'main' }),
    ).rejects.toThrow('read-only');

    const submitTexts = runtime2.kernel.state('ultra-staff')!.artifacts.map(a => a.text);
    expect(submitTexts.some(t => t.includes('disabled in read-only workflows'))).toBe(true);
  });

  it('auto-retries transient failures with fresh executionId on readOnly workflows under executionLedger, while keeping non-readOnly governed strictness', async () => {
    const receipts = new Map<string, ExecutionObservation>();
    const roExecutionIds: string[] = [];
    const runtimeRo = new WorkflowRuntime({
      path: ':memory:',
      hostTools: true,
      retryDelaysMs: [10],
      resolveRoot: async () => ({ ...root, scopeId: 'ro-retry' }),
      wakeMain: async () => {},
      executionLedger: { lookupExecution: async id => receipts.get(id) ?? { state: 'not-submitted', proof: 'fixture' } },
      runner: {
        async start(spec) {
          roExecutionIds.push(spec.executionId);
          await spec.validateBeforeRun();
          const attemptNum = roExecutionIds.length;
          const workerResult = attemptNum === 1
            ? { status: 'failed' as const, quiescence: 'quiescent' as const, error: 'HTTP 429 rate_limit exceeded' }
            : { status: 'completed' as const, quiescence: 'quiescent' as const, text: 'recovered after 429' };
          return {
            runId: 'run-ro-' + attemptNum,
            result: Promise.resolve(attemptNum === 1 ? 'failed' : 'completed'),
            stop: async () => {},
            waitForExit: async () => false,
            waitForQuiescence: async () => ({ state: 'quiescent' }),
            stopReason: () => undefined,
            async *events() {
              yield { type: 'session', nativeSessionId: spec.resume?.id ?? ('native-ro-' + attemptNum) };
              receipts.set(spec.executionId, { state: 'completed', result: workerResult });
              if (workerResult.text) yield { type: 'final_text', text: workerResult.text };
              if (workerResult.error) yield { type: 'error', message: workerResult.error };
              yield { type: 'done', normal: attemptNum > 1 };
            },
          };
        },
      },
    });
    await runtimeRo.start();
    cleanup.push(() => runtimeRo.close());
    const mainRo = runtimeRo.bindMain('ro-retry', 'start');
    cleanup.push(async () => mainRo.release());
    await mainRo.call!('run_script', {
      operationId: randomUUID(),
      goal: 'read-only transient retry',
      plan: 'Retry 429 cleanly in readOnly workflow.',
      readOnly: true,
      script: 'return await agent("check", { key: "c1", onError: "throw" });',
    });
    await vi.waitFor(async () => {
      await runtimeRo.tick();
      expect(runtimeRo.kernel.state('ro-retry')?.script?.status).toBe('result_ready');
    });
    expect(roExecutionIds).toHaveLength(2);
    expect(roExecutionIds[1]).not.toBe(roExecutionIds[0]);

    // Non-readOnly governed workflow must NOT auto-retry when receipt is already submitted/completed failed.
    const rwReceipts = new Map<string, ExecutionObservation>();
    const rwExecutionIds: string[] = [];
    const runtimeRw = new WorkflowRuntime({
      path: ':memory:',
      hostTools: true,
      retryDelaysMs: [10],
      resolveRoot: async () => ({ ...root, scopeId: 'rw-no-retry' }),
      wakeMain: async () => {},
      executionLedger: { lookupExecution: async id => rwReceipts.get(id) ?? { state: 'not-submitted', proof: 'fixture' } },
      runner: {
        async start(spec) {
          rwExecutionIds.push(spec.executionId);
          await spec.validateBeforeRun();
          return {
            runId: 'run-rw-1',
            result: Promise.resolve('failed'),
            stop: async () => {},
            waitForExit: async () => false,
            waitForQuiescence: async () => ({ state: 'quiescent' }),
            stopReason: () => undefined,
            async *events() {
              yield { type: 'session', nativeSessionId: 'native-rw-1' };
              rwReceipts.set(spec.executionId, { state: 'completed', result: { status: 'failed', quiescence: 'quiescent', error: 'HTTP 429 rate_limit' } });
              yield { type: 'error', message: 'HTTP 429 rate_limit' };
              yield { type: 'done', normal: false };
            },
          };
        },
      },
    });
    await runtimeRw.start();
    cleanup.push(() => runtimeRw.close());
    const mainRw = runtimeRw.bindMain('rw-no-retry', 'start');
    cleanup.push(async () => mainRw.release());
    await mainRw.call!('run_script', {
      operationId: randomUUID(),
      goal: 'non-readonly no unsafe retry',
      plan: 'Do not retry submitted governed failure.',
      readOnly: false,
      script: 'return await agent("mutate", { key: "m1", onError: "throw" });',
    });
    await vi.waitFor(async () => {
      await runtimeRw.tick();
      expect(runtimeRw.kernel.state('rw-no-retry')?.script?.status).toBe('failed');
    });
    expect(rwExecutionIds).toHaveLength(1);
  });

  it('uses workflow_call instructions in tell_worker under hostTools, filters workflowToolDefinitions, and strips /workflow start in hostToolInstructions', async () => {
    const received: string[] = [];
    let release!: () => void;
    const blocker = new Promise<void>(resolve => { release = resolve; });
    const runtime = new WorkflowRuntime({
      path: ':memory:',
      hostTools: true,
      resolveRoot: async () => ({ ...root, scopeId: 'tell-host' }),
      wakeMain: async () => {},
      runner: {
        async start(spec) {
          await spec.validateBeforeRun();
          return {
            runId: 'run-tell',
            result: blocker.then(() => 'completed' as const),
            stop: async () => release(),
            waitForExit: async () => true,
            stopReason: () => undefined,
            send: async text => { received.push(text); return 'accepted'; },
            async *events() {
              yield { type: 'session', nativeSessionId: 'native-tell' };
              await blocker;
              yield { type: 'final_text', text: 'done' };
              yield { type: 'done', normal: true };
            },
          };
        },
      },
    });
    await runtime.start();
    cleanup.push(async () => { release(); await runtime.close(); });
    const main = runtime.bindMain('tell-host', 'start');
    cleanup.push(async () => main.release());
    await main.call!('run_script', {
      operationId: randomUUID(),
      goal: 'tell host',
      plan: 'Test tell_worker host tools prompt.',
      script: 'return await agent("work", { key: "k1" });',
    });
    await vi.waitFor(async () => {
      await runtime.tick();
      expect(runtime.kernel.state('tell-host')?.tasks[0]?.status).toBe('running');
    });
    const res = await main.call!('tell_worker', { target: 'k1', text: 'Please focus on bounds checking.' }) as { status: string };
    expect(res.status).toBe('accepted');
    expect(received[0]).toContain('workflow_call({method:"reply_main"');
    expect(received[0]).not.toContain('AGENT_WORKFLOW_CLI');

    const transformed = hostToolInstructions(WORKFLOW_TOOL_INSTRUCTIONS);
    expect(transformed).not.toContain('/workflow start');
    expect(transformed).toContain('仅在当前宿主已授权启动工作流的回合可调用 run_script');

    const filtered = workflowToolDefinitions('main', ['status', 'complete']);
    expect(filtered[0]!.function.parameters.properties.method.enum).toEqual(['status', 'complete']);
    release();
  });

  it('allocates fresh executionId on autoRevive and staff_swarm revive after settled quiescent failure under executionLedger', async () => {
    const receipts = new Map<string, ExecutionObservation>();
    const flakyExecutionIds: string[] = [];
    const runtime = new WorkflowRuntime({
      path: ':memory:',
      hostTools: true,
      resolveRoot: async () => ({ ...root, scopeId: 'swarm-revive-execid' }),
      wakeMain: async () => {},
      executionLedger: { lookupExecution: async id => receipts.get(id) ?? { state: 'not-submitted', proof: 'fixture' } },
      runner: {
        async start(spec) {
          await spec.validateBeforeRun();
          if (spec.memberKey === 'flaky') {
            flakyExecutionIds.push(spec.executionId);
            const attemptNum = flakyExecutionIds.length;
            const workerResult = attemptNum <= 2
              ? { status: 'failed' as const, quiescence: 'quiescent' as const, error: `non-transient-fail-${attemptNum}` }
              : { status: 'completed' as const, quiescence: 'quiescent' as const, text: 'recovered on revive' };
            return {
              runId: 'run-flaky-' + attemptNum,
              result: Promise.resolve(attemptNum <= 2 ? 'failed' : 'completed'),
              stop: async () => {},
              waitForExit: async () => false,
              waitForQuiescence: async () => ({ state: 'quiescent' }),
              stopReason: () => undefined,
              async *events() {
                yield { type: 'session', nativeSessionId: spec.resume?.id ?? 'native-flaky' };
                if (attemptNum > 2) {
                  const st = runtime.kernel.state('swarm-revive-execid')!;
                  await runtime.call(
                    { kind: 'worker', scopeId: 'swarm-revive-execid', workflowId: st.workflowId, taskId: spec.taskId!, attemptId: spec.attemptId },
                    'post_board',
                    { operationId: randomUUID(), to: ['lead'], text: 'flaky recovered cleanly' },
                  );
                }
                receipts.set(spec.executionId, { state: 'completed', result: workerResult });
                if (workerResult.text) yield { type: 'final_text', text: workerResult.text };
                if (workerResult.error) yield { type: 'error', message: workerResult.error };
                yield { type: 'done', normal: attemptNum > 2 };
              },
            };
          }
          const isLead = spec.memberKey === 'lead';
          const leadPost = isLead && (runtime.kernel.state('swarm-revive-execid')?.board?.posts.some(p => p.text.includes('flaky recovered cleanly')) ?? false);
          return {
            runId: 'run-' + spec.attemptId,
            result: Promise.resolve('completed'),
            stop: async () => {},
            waitForExit: async () => false,
            waitForQuiescence: async () => ({ state: 'quiescent' }),
            stopReason: () => undefined,
            async *events() {
              yield { type: 'session', nativeSessionId: spec.resume?.id ?? ('native-' + spec.memberKey) };
              if (leadPost) {
                const state = runtime.kernel.state('swarm-revive-execid')!;
                await runtime.call(
                  { kind: 'worker', scopeId: 'swarm-revive-execid', workflowId: state.workflowId, taskId: spec.taskId!, attemptId: spec.attemptId },
                  'swarm_finish',
                  { operationId: randomUUID(), result: 'done after revive' },
                );
              }
              const text = spec.memberKey + '-ok';
              receipts.set(spec.executionId, { state: 'completed', result: { status: 'completed', quiescence: 'quiescent', text } });
              yield { type: 'final_text', text };
              yield { type: 'done', normal: true };
            },
          };
        },
      },
    });
    await runtime.start();
    cleanup.push(() => runtime.close());
    const main = runtime.bindMain('swarm-revive-execid', 'start');
    cleanup.push(async () => main.release());
    await main.call!('run_script', {
      operationId: randomUUID(),
      goal: 'swarm revive governed executionId test',
      plan: 'Verify autoRevive and staff_swarm revive allocate distinct executionIds.',
      readOnly: true,
      script: `
        return await swarm("coord", {
          key: "rev-swarm",
          maxTurns: 4,
          lead: { name: "lead", role: "team-lead" },
          members: [{ name: "flaky", role: "flaky-member" }]
        });
      `,
    });

    await vi.waitFor(async () => {
      await runtime.tick();
      expect(runtime.kernel.state('swarm-revive-execid')?.events.some(e => e.kind === 'swarm_attention')).toBe(true);
    });
    expect(flakyExecutionIds).toHaveLength(2);
    expect(new Set(flakyExecutionIds).size).toBe(2);

    const revived = await main.call!('staff_swarm', { operationId: randomUUID(), swarm: 'rev-swarm', revive: ['flaky'] }) as { revived?: string[] };
    expect(revived.revived).toEqual(['flaky']);

    await vi.waitFor(async () => {
      await runtime.tick();
      expect(runtime.kernel.state('swarm-revive-execid')?.script?.status).toBe('result_ready');
    });
    expect(flakyExecutionIds).toHaveLength(3);
    expect(new Set(flakyExecutionIds).size).toBe(3);

    const wfId = runtime.kernel.state('swarm-revive-execid')!.workflowId;
    for (const id of flakyExecutionIds) {
      await expect(runtime.kernel.notifyExecution('swarm-revive-execid', wfId, id)).resolves.toMatchObject({
        executionId: id,
        state: 'completed',
        accepted: true,
      });
    }
    receipts.set(flakyExecutionIds[0]!, { state: 'completed', result: { status: 'completed', quiescence: 'quiescent', text: 'tampered' } });
    await expect(runtime.kernel.notifyExecution('swarm-revive-execid', wfId, flakyExecutionIds[0]!)).rejects.toThrow('Host execution completion changed');
  });
});
