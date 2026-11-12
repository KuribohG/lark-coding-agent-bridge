import type { ModelSettings } from '../../agent/model-settings';
import { sendRunInput } from '../../agent/execution';
import type { RunStopReason } from '../../agent/types';
import { newRunHostKey, probeRunHost, runHostAgent, runHostsSupported, terminateRunHost } from '../../agent/run-host';
import { log } from '../../core/logger';
import { spawnProcess } from '../../platform/spawn';
import { terminateChild } from '../../platform/terminate';
import type { RunPolicyAllow } from '../../policy/run-policy';
import { RunStopped } from '../../runtime/errors';
import type { RunExecutor } from '../../runtime/run-executor';
import { workflowDigest } from '@kuribohg/agent-workflows';
import { inheritedWorkerExecution } from '@kuribohg/agent-workflows';
import { stopReasonOf, type WorkerHosting, type WorkerRun, type WorkerRunner, type WorkerRunSpec } from '@kuribohg/agent-workflows';
import { WorkflowRuntime, type WorkflowRuntimeDeps } from '@kuribohg/agent-workflows';
import type { WorkerExecution, WorkerExecutionSelection, WorkflowRoot, WorkflowStopReason } from '@kuribohg/agent-workflows';
import { bridgeAgentKind, bridgeWorkerPolicy } from './execution';

type BridgeGrant = { execution: WorkerExecution; policy: RunPolicyAllow };

export interface BridgeWorkflowRuntimeDeps extends Pick<WorkflowRuntimeDeps,
  'path' | 'workspaceRoot' | 'getTimeoutMinutes' | 'stallMs' | 'wakeMain' | 'showPlan' | 'notify' | 'cliPath'> {
  executor: RunExecutor;
  resolve(scopeId: string): Promise<{ root: WorkflowRoot; policy: RunPolicyAllow } | undefined>;
  resolveWorker?(root: WorkflowRoot, selection: WorkerExecutionSelection, policy: RunPolicyAllow): Promise<BridgeGrant>;
}

// The engine and the bridge share one stop vocabulary; keep them aligned.
const sameStopReasons: [WorkflowStopReason, RunStopReason] extends [RunStopReason, WorkflowStopReason] ? true : never = true;
void sameStopReasons;

/** Workers run under bin/run-host.mjs like conversation turns, so a bridge restart reattaches instead of rerunning them. */
const runHosting: WorkerHosting = {
  newKey: newRunHostKey,
  attachable: async (key, agentKind) => runHostAgent(key) === agentKind && await probeRunHost(key) !== 'missing',
  release: key => terminateRunHost(key),
};

/** Workflow runtime whose workers run through the bridge executor under the main session's run policy. */
export function createBridgeWorkflowRuntime(deps: BridgeWorkflowRuntimeDeps): WorkflowRuntime {
  const grant = async (root: WorkflowRoot, selection: WorkerExecutionSelection): Promise<BridgeGrant> => {
    const current = await deps.resolve(root.scopeId);
    if (!current || workflowDigest(current.root) !== workflowDigest(root)) throw new Error('Worker root authorization changed');
    const resolved = deps.resolveWorker
      ? await deps.resolveWorker(root, selection, current.policy)
      : { execution: inheritedWorkerExecution(root, selection), policy: current.policy };
    if (resolved.policy.cwdRealpath !== root.cwdRealpath) throw new Error('Worker resolver changed authorized scope');
    return resolved;
  };
  const workerGrant = (root: WorkflowRoot, execution: WorkerExecution) =>
    grant(root, { agentKind: execution.agentKind, ...execution.modelSettings });

  const runner: WorkerRunner = {
    async start(spec: WorkerRunSpec): Promise<WorkerRun> {
      const { root, execution, workspace } = spec;
      const current = await workerGrant(root, execution);
      if (workflowDigest(current.execution) !== workflowDigest(execution)) throw new Error('Worker execution binding changed');
      const agentKind = bridgeAgentKind(execution.agentKind);
      const idField = spec.resume?.kind ?? bridgeWorkerPolicy.nativeIdKind(agentKind);
      // The executor reads stop reasons from its own abort type.
      const controller = new AbortController();
      const forward = () => controller.abort(new RunStopped(stopReasonOf(spec.signal)));
      spec.signal.addEventListener('abort', forward, { once: true });
      if (spec.signal.aborted) forward();
      let submitted;
      try {
        submitted = await deps.executor.submit({
          scopeId: spec.sessionKey, agentScopeId: root.scopeId, agentKind, requireFinalAnswer: true,
          priority: 'background', env: spec.env, systemPrompt: spec.systemPrompt,
          validateBeforeRun: async () => {
            const admitted = await workerGrant(root, execution);
            if (workflowDigest(admitted.execution) !== workflowDigest(execution)) throw new Error('Worker binding changed while queued');
            await spec.validateBeforeRun();
          },
          policy: { ...current.policy, ...(workspace ? { requestedCwd: workspace.path, cwdRealpath: workspace.path,
            policyFingerprint: workflowDigest({ policy: current.policy.policyFingerprint, workspace: workspace.id, root: workspace.rootDigest }) } : {}), prompt: spec.prompt },
          ...(spec.resume ? { [spec.resume.kind]: spec.resume.id } : {}),
          ...(spec.host ? { host: spec.host } : {}),
          // Efforts were validated by bridgeWorkerPolicy when the selection was parsed.
          ...execution.modelSettings as ModelSettings,
          deadlineAt: spec.deadlineAt, signal: controller.signal,
          observability: { profile: execution.profile, agent: agentKind, source: 'workflow', stage: spec.role },
        });
      } catch (error) {
        spec.signal.removeEventListener('abort', forward);
        throw error;
      }
      const result = submitted.result.then(value => value === 'completed' || value === 'stopped' ? value : 'failed' as const);
      void result.finally(() => spec.signal.removeEventListener('abort', forward)).catch(() => {});
      return {
        runId: submitted.runId,
        result,
        send: async (text, messageId) => (await sendRunInput(submitted.run, { text, messageId })).status,
        stop: reason => submitted.stop(reason),
        waitForExit: timeoutMs => submitted.run.waitForExit(timeoutMs),
        stopReason: () => submitted.handle.stopReason,
        async *events() {
          // Liveness for the kernel's stall watchdog: any output counts, and a tool in flight explains silence.
          // The engine only needs the transitions, so repeated chatter is coalesced to one event per interval.
          let tool = false;
          // The turn ended with background tasks still running and the run is held for them: silence until one
          // finishes is expected, exactly as with a tool in flight.
          let held = false;
          let busy = false;
          let sentAt = 0;
          const activity = () => {
            const now = Date.now();
            const next = tool || held;
            if (next === busy && now - sentAt < 5_000) return undefined;
            busy = next; sentAt = now;
            return { type: 'activity' as const, busy };
          };
          for await (const event of submitted.subscribe()) {
            if (event.type === 'system') {
              const id = event[idField];
              if (id) yield { type: 'session', nativeSessionId: id, ...(event.model ? { model: event.model } : {}) };
            } else if (event.type === 'retry') yield { type: 'retry' };
            else if (event.type === 'tool_use' || event.type === 'tool_result' || event.type === 'text'
              || event.type === 'thinking' || event.type === 'usage' || event.type === 'status') {
              if (event.type === 'tool_use') tool = true;
              else if (event.type === 'tool_result') tool = false;
              held = event.type === 'status' && event.code === 'background_tasks';
              const signal = activity(); if (signal) yield signal;
            } else if (event.type === 'final_text') yield { type: 'final_text', text: event.content };
            else if (event.type === 'error') yield { type: 'error', message: event.message };
            else if (event.type === 'done') yield { type: 'done', normal: event.terminationReason === 'normal' };
            else if (event.type === 'user_input') yield { type: 'user_input', question: event.questions.map(item => item.question).join('\n') };
          }
        },
      };
    },
    ...(runHostsSupported() ? { hosting: runHosting } : {}),
  };

  return new WorkflowRuntime({
    path: deps.path, workspaceRoot: deps.workspaceRoot, getTimeoutMinutes: deps.getTimeoutMinutes,
    ...(deps.stallMs === undefined ? {} : { stallMs: deps.stallMs }),
    wakeMain: deps.wakeMain, showPlan: deps.showPlan, notify: deps.notify, cliPath: deps.cliPath,
    ...bridgeWorkerPolicy,
    runner,
    resolveRoot: async scope => (await deps.resolve(scope))?.root,
    resolveWorker: async (root, selection) => (await grant(root, selection)).execution,
    authorizeWorkspace: async (root, worker) => {
      const current = await deps.resolve(root.scopeId);
      if (!current) throw new Error('Workspace root authorization changed');
      const policies = [current.policy, worker ? (await workerGrant(root, worker)).policy : current.policy];
      for (const policy of policies) {
        if (policy.cwdRealpath !== root.cwdRealpath || policy.accessMode !== 'full'
          || policy.sandbox !== 'danger-full-access' || policy.permissionMode !== 'bypassPermissions') throw new Error('Workspaces require an already authorized full-access profile');
      }
    },
    log: {
      info: (event, fields) => log.info('workflow', event, fields),
      warn: (event, fields) => log.warn('workflow', event, fields),
    },
    processes: { spawn: spawnProcess, killTree: child => { terminateChild(child, 'SIGKILL'); } },
  });
}
