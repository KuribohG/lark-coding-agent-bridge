import { randomUUID } from 'node:crypto';
import { workflowDigest } from '../digest';
import { consumerSummary } from '../consumer-pool';
import { workerSelection } from '../execution';
import { addArtifact, acknowledge, BUSY, findTask, readArtifact, requiredText, textArray } from '../kernel-state';
import { boundedInteger, scriptArgs, scriptText, SCRIPT_DEFINITION, SCRIPT_MAX_TASKS } from '../script-contract';
import { unfinishedWork, workStatus } from '../work-queue';
import { consumerPools } from '../work-routing';
import type { KernelContext } from '../kernel-context';
import { emit } from '../kernel-store';
import type { WorkflowView } from '../types';
import type { WorkflowToolPlugin } from './types';
import { versioned } from './versioned';

/** The main agent's view of a workflow, returned by `status` and embedded in its turn context. */
export function workflowSummary(ctx: KernelContext, state: WorkflowView): unknown {
  return {
    workflowId: state.workflowId, plugin: { id: state.definition.id, version: state.definition.version, digest: state.definitionDigest },
    stateVersion: state.stateVersion, status: state.status, goalRef: state.artifacts[0]?.ref,
    goalPreview: state.goal.slice(0, 500),
    deadlineAt: state.deadlineAt, root: state.root,
    sessions: state.sessions,
    agents: state.agents ?? [],
    workQueue: state.workQueue ? workStatus(state) : undefined,
    consumerPools: consumerPools(state).map(pool => consumerSummary(state, pool.key)),
    consumers: consumerSummary(state),
    waits: (state.waits ?? []).map(wait => ({ key: wait.key, status: wait.status, createdAt: wait.createdAt,
      kinds: wait.any.map(arm => arm.kind), selected: wait.result?.index })),
    parent: state.parent ? {workflowId:state.parent.workflowId,taskId:state.parent.taskId,depth:state.parent.depth,key:state.parent.key} : undefined,
    children: ctx.store.descendants(state).map(child=>({workflowId:child.workflowId,parentWorkflowId:child.parent!.workflowId,
      key:child.parent!.key,depth:child.parent!.depth,status:child.status,scriptStatus:child.script?.status,
      sourceRef:child.script?.sourceRef,planRef:child.script?.planRef,resultRef:child.script?.resultRef})),
    checkpoints: (state.checkpoints ?? []).filter(item => state.agents?.some(agent => agent.checkpointRef === item.ref))
      .map(({ state: _state, ...item }) => item),
    mailbox: state.mailbox ? {
      totalMessages: state.mailbox.messages.length,
      unacknowledgedMessages: state.mailbox.messages.filter(item => !item.consumedByTurnId).length,
      recentMessages: state.mailbox.messages.slice(-8).map(({ text, ...item }) => ({ ...item, preview: text.slice(0, 160) })),
      waits: state.mailbox.receipts.filter(item => item.status === 'waiting').map(({ id, agentId }) => ({ id, agentId })),
    } : undefined,
    tasks: state.tasks.map(({ taskId, taskKey, sessionRef, status, resultRefs, error, attempts, scriptKey, agentId, previousTurnId, inputCheckpointVersion, inputMessageIds }) =>
      ({ taskId, taskKey, sessionRef, status, resultRefs, error, scriptKey, attempts, agentId, previousTurnId, inputCheckpointVersion, inputMessageIds })),
    artifacts: state.artifacts.map(({ chars: _chars, ...artifact }) => artifact),
    events: state.events.filter(event => !event.acknowledged),
    ...(state.script ? { script: { ...state.script, args: undefined, argsDigest: workflowDigest(state.script.args) } } : {}),
    executionAccess: 'same authorized profile; worker instructions are not a sandbox',
  };
}

/** Starting, replaying, pausing, finishing and cancelling a script workflow, and handling its events. */
export const lifecycleTools: WorkflowToolPlugin = {
  id: 'lifecycle',
  tools: [
    {
      name: 'status',
      main: { kind: 'read', doc: 'status', read: (ctx, state) => state ? workflowSummary(ctx, state) : { status: 'unbound' } },
    },
    {
      name: 'run_script',
      main: {
        kind: 'start', doc: 'run_script(goal,script,plan,args?,name?,execution?,maxAgents?,maxConcurrent?,timeoutMs?)',
        start: (ctx, root, args) => {
          const definition = structuredClone(SCRIPT_DEFINITION);
          definition.maxConcurrentWorkers = boundedInteger(args.maxConcurrent, 4, 1, 16);
          definition.maxWallTimeMinutes = ctx.host.getTimeoutMinutes?.(root) ?? definition.maxWallTimeMinutes;
          definition.defaultWallTimeMinutes = definition.maxWallTimeMinutes;
          const timeoutMs = definition.maxWallTimeMinutes * 60_000;
          const goal = requiredText(args.goal);
          const created = ctx.store.create({
            workflowId: randomUUID(), root, definition, definitionDigest: workflowDigest(definition), goal,
            stateVersion: 0, status: 'active', createdAt: ctx.now(),
            deadlineAt: ctx.now() + boundedInteger(args.timeoutMs, timeoutMs, 1000, timeoutMs),
            sessions: [], tasks: [], artifacts: [], events: [],
          });
          addArtifact(created, 'requirements', goal, ctx.now);
          const source = addArtifact(created, 'workflow-script', scriptText(args.script, 'script'), ctx.now);
          const plan = addArtifact(created, 'workflow-plan', scriptText(args.plan, 'plan', 12_000), ctx.now);
          emit(created, { type: 'script_set', script: { name: scriptText(args.name ?? 'Script workflow', 'name', 100), sourceRef: source.ref, planRef: plan.ref,
            args: scriptArgs(args.args), defaults: workerSelection(args.execution, root, ctx.host), runId: randomUUID(), revision: 0,
            status: 'queued', maxCalls: boundedInteger(args.maxAgents, 32, 1, SCRIPT_MAX_TASKS), calls: [], logs: [] } });
          return created;
        },
      },
    },
    {
      name: 'replay_script',
      main: {
        kind: 'mutate', doc: 'replay_script(script?,plan?,args?,execution?)', resumesClock: true, allowInterrupted: true,
        // Root and descendant replay commit together, in the operation's transaction.
        apply: (ctx, state, args, commit) => {
          ctx.recovery.replayScript(state, args);
          return commit(() => ({ stateVersion: state.stateVersion, status: state.status }));
        },
      },
    },
    {
      name: 'ack_events',
      main: {
        doc: 'ack_events(eventIds)', ...versioned((ctx, state, args) => {
          const ids = textArray(args.eventIds);
          if (ids.some(id => !state.events.some(event => event.id === id))) throw new Error('Unknown event ID');
          acknowledge(state, state.events.filter(event => ids.includes(event.id)), ctx.now());
          return { acknowledged: ids };
        }, { allowAfterDeadline: true }),
      },
    },
    {
      name: 'cancel_task',
      main: {
        doc: 'cancel_task(taskId)', ...versioned((ctx, state, args) => {
          const task = findTask(state, requiredText(args.taskId));
          ctx.children.suspendChildren(state,true,task.taskId);
          ctx.scheduler.cancelTask(task, state);
          return { taskId: task.taskId, status: task.status };
        }, { allowAfterDeadline: true }),
      },
    },
    {
      name: 'pause',
      main: { doc: 'pause', ...versioned((ctx, state) => {
        ctx.lifecycle.pause(state);
        return undefined;
      }) },
    },
    {
      name: 'resume',
      main: {
        kind: 'mutate', doc: 'resume', resumesClock: true, allowInterrupted: true,
        apply: (ctx, state, args, commit) => {
          if (state.script.status !== 'paused' && state.status !== 'interrupted') throw new Error('Use replay_script to relaunch a completed or failed script');
          ctx.recovery.replayScript(state, args);
          return commit(() => ({ stateVersion: state.stateVersion, status: state.status }));
        },
      },
    },
    {
      name: 'cancel',
      main: {
        kind: 'mutate', doc: 'cancel', terminalCheckOnly: true,
        apply: (ctx, state, _args, commit) => {
          ctx.lifecycle.cancelState(state);
          return commit(() => workflowSummary(ctx, state));
        },
      },
    },
    {
      name: 'complete',
      main: {
        doc: 'complete(reportRef,openIssues:[],verificationLimits)', ...versioned((ctx, state, args) => {
          if (!['result_ready', 'failed'].includes(state.script.status)) throw new Error('Script has not finished');
          if (state.tasks.some(task => BUSY.has(task.status))) throw new Error('Workers are still active');
          if (ctx.store.descendants(state).some(child => child.tasks.some(task => BUSY.has(task.status)))) throw new Error('Child workers are still active');
          if (ctx.store.descendants(state).some(child=>!['completed','cancelled'].includes(child.status))) throw new Error('Child workflows are unfinished');
          if (unfinishedWork(state)) throw new Error('Work items are unfinished; finish them or cancel the workflow');
          if (state.events.some(event => !event.acknowledged)) throw new Error('Acknowledge pending events before completion');
          const report = readArtifact(state, requiredText(args.reportRef));
          if (!['report', 'workflow-result'].includes(report.kind)) throw new Error('Completion requires a report or script result artifact');
          // A successful worker answer does not establish verification coverage.
          const response = { reportRef: report.ref, openIssues: textArray(args.openIssues), verificationLimits: requiredText(args.verificationLimits) };
          emit(state, { type: 'workflow_completed' });
          return response;
        }, { allowAfterDeadline: true }),
      },
    },
  ],
};
