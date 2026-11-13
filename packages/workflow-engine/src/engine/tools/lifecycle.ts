import { randomUUID } from 'node:crypto';
import { workflowDigest } from '../digest';
import { swarmSummary } from '../swarm';
import { workerSelection } from '../execution';
import { addArtifact, acknowledge, BUSY, findTask, readArtifact, requiredText, textArray } from '../kernel-state';
import { MAX_CONCURRENT_WORKERS, SCRIPT_MAX_TASKS } from '../limits';
import { boundedInteger, scriptArgs, scriptText, SCRIPT_DEFINITION } from '../script-contract';
import { unfinishedWork, workStatus } from '../work-queue';
import type { KernelContext } from '../kernel-context';
import { emit } from '../kernel-store';
import type { WorkflowView } from '../types';
import type { WorkflowToolPlugin } from './types';
import { versioned } from './versioned';

const MAX_REMAINING_MS = 14 * 24 * 3_600_000;

/**
 * JSON characters a summary may take. It is embedded in every workflow turn of the main agent, so it must stay a small
 * part of a context window however many tasks the workflow has run.
 */
const SUMMARY_MAX_CHARS = 40_000;
/** Entries of each growing list a summary shows when the budget allows. */
const SUMMARY_LIST_ENTRIES = 32;

const FINISHED = new Set<WorkflowView['tasks'][number]['status']>(['result_ready', 'failed', 'cancelled', 'interrupted']);

type Summary = Record<string, unknown>;
interface SummaryList { path: string; holder: Summary; field: string; items: unknown[] }

function fullSummary(ctx: KernelContext, state: WorkflowView): Summary {
  const taskCounts: Record<string, number> = {};
  for (const task of state.tasks) taskCounts[task.status] = (taskCounts[task.status] ?? 0) + 1;
  return {
    workflowId: state.workflowId, plugin: { id: state.definition.id, version: state.definition.version, digest: state.definitionDigest },
    stateVersion: state.stateVersion, status: state.status, goalRef: state.artifacts[0]?.ref,
    goalPreview: state.goal.slice(0, 500),
    deadlineAt: state.deadlineAt, root: state.root, taskCounts,
    sessions: state.sessions,
    agents: state.agents ?? [],
    workQueue: state.workQueue ? workStatus(state) : undefined,
    swarms: (state.swarms ?? []).map(swarm => swarmSummary(state, swarm)),
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

/** The lists of a summary that grow with the workflow, named by their path in it. */
function summaryLists(summary: Summary): SummaryList[] {
  const lists: SummaryList[] = [];
  const add = (path: string, holder: unknown, field: string) => {
    const items = (holder as Summary | undefined)?.[field];
    if (Array.isArray(items)) lists.push({ path, holder: holder as Summary, field, items });
  };
  for (const field of ['tasks', 'artifacts', 'sessions', 'agents', 'checkpoints', 'waits', 'children', 'events']) add(field, summary, field);
  for (const field of ['calls', 'workCalls', 'controlCalls', 'logs']) add(`script.${field}`, summary.script, field);
  add('mailbox.waits', summary.mailbox, 'waits');
  for (const swarm of summary.swarms as Summary[]) add(`swarms.${String(swarm.key)}.members`, swarm, 'members');
  return lists;
}

/**
 * The main agent's view of a workflow, returned by `status` and by every change, and embedded in its turn context.
 * Each growing list keeps only its latest entries, fewer of them until the whole fits the budget; `omitted` counts the
 * rest, which `status` pages through.
 */
export function workflowSummary(ctx: KernelContext, state: WorkflowView): unknown {
  const summary = fullSummary(ctx, state);
  const lists = summaryLists(summary);
  // Tasks in progress are what the reader acts on, so they are the last to be cut, after queued and then finished ones.
  const rank = (task: unknown) => { const { status } = task as WorkflowView['tasks'][number]; return FINISHED.has(status) ? 0 : status === 'queued' ? 1 : 2; };
  const latest = (list: SummaryList, keep: number) => {
    if (list.items.length <= keep) return list.items;
    if (list.path !== 'tasks') return list.items.slice(list.items.length - keep);
    const kept = new Set([0, 1, 2].flatMap(level => list.items.filter(task => rank(task) === level)).slice(list.items.length - keep));
    return list.items.filter(task => kept.has(task));
  };
  for (let keep = SUMMARY_LIST_ENTRIES; ; keep >>= 1) {
    const omitted: Record<string, number> = {};
    for (const list of lists) {
      list.holder[list.field] = latest(list, keep);
      if (list.items.length > keep) omitted[list.path] = list.items.length - keep;
    }
    if (Object.keys(omitted).length) summary.omitted = omitted;
    if (!keep || JSON.stringify(summary).length <= SUMMARY_MAX_CHARS) return summary;
  }
}

/** One page of a list of the summary, in the order the workflow recorded it. */
function summaryPage(ctx: KernelContext, state: WorkflowView, args: Record<string, unknown>): unknown {
  const lists = summaryLists(fullSummary(ctx, state));
  const list = lists.find(item => item.path === args.list);
  if (!list) throw new Error(`Unknown list; expected one of: ${lists.map(item => item.path).join(', ')}`);
  const offset = boundedInteger(args.offset, 0, 0, Number.MAX_SAFE_INTEGER);
  const limit = boundedInteger(args.limit, 16, 1, 64);
  return { list: list.path, stateVersion: state.stateVersion, total: list.items.length, offset,
    nextOffset: offset + limit < list.items.length ? offset + limit : null, items: list.items.slice(offset, offset + limit) };
}

/** Starting, replaying, pausing, finishing and cancelling a script workflow, and handling its events. */
export const lifecycleTools: WorkflowToolPlugin = {
  id: 'lifecycle',
  tools: [
    {
      name: 'status',
      main: {
        kind: 'read', doc: 'status(list?,offset?,limit?)',
        read: (ctx, state, args) => !state ? { status: 'unbound' } : args.list === undefined ? workflowSummary(ctx, state) : summaryPage(ctx, state, args),
      },
    },
    {
      name: 'run_script',
      main: {
        kind: 'start', doc: 'run_script(goal,script,plan,args?,name?,execution?,maxAgents?,maxConcurrent?,timeoutMs?)',
        start: (ctx, root, args) => {
          const definition = structuredClone(SCRIPT_DEFINITION);
          definition.maxConcurrentWorkers = boundedInteger(args.maxConcurrent, 4, 1, MAX_CONCURRENT_WORKERS);
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
      // The time limit set at the start is an estimate; a workflow that is making progress should not die of it.
      name: 'extend_deadline',
      main: { doc: 'extend_deadline(minutes)', ...versioned((ctx, state, args) => {
        if (state.parent) throw new Error('A child workflow ends with its parent; extend the root workflow');
        const deadlineAt = state.deadlineAt + boundedInteger(args.minutes, 0, 1, 10_080) * 60_000;
        if (deadlineAt - ctx.now() > MAX_REMAINING_MS) throw new Error('A workflow may have at most 14 days left');
        emit(state, { type: 'deadline_extended', deadlineAt });
        return { deadlineAt };
      }, { allowInterrupted: true }) },
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
