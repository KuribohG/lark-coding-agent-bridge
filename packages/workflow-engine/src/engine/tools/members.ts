import { checkpoint, mailboxOperation, member, memberContext, saveCheckpoint, taskAgent } from '../durable-agents';
import { boardDigest } from '../board';
import { requiredText, requireState } from '../kernel-state';
import { nestedContext } from '../nested-workflow';
import { openAsksOf } from '../asks';
import { goalView, statusesFor } from '../steering';
import { memberTodos } from '../swarm-pump';
import { workContext } from '../work-queue';
import type { KernelContext } from '../kernel-context';
import { readText } from '../kernel-store';
import type { TaskView, WorkflowView } from '../types';
import type { ToolArgs, WorkflowToolPlugin } from './types';

/** An idempotent change by a persistent member's active turn, keyed by its operationId. */
export function memberOperation(ctx: KernelContext, state: WorkflowView, task: TaskView, method: string, args: ToolArgs,
  apply: (agent: NonNullable<ReturnType<typeof taskAgent>>) => unknown): unknown {
  const agent = taskAgent(state, task);
  if (!agent) throw new Error('This operation requires a persistent member');
  if (state.status !== 'active' || state.script?.status !== 'running' || ctx.now() >= state.deadlineAt) throw new Error('Workflow is inactive');
  const operationId = requiredText(args.operationId, 160);
  return mailboxOperation(state, 'worker:' + task.taskId + ':' + operationId, { method, args }, () => apply(agent));
}

/** A worker's own task context and a persistent member's checkpoint. */
export const memberContextTools: WorkflowToolPlugin = {
  id: 'member-context',
  memberInstructions: 'read_context returns how things stand for you now: your checkpoint and its version (checkpointVersion), the messages of this turn, the to-dos that wait on you (todos), your open asks (asked), '
    + 'the goal and the status notes in force, what the board holds and your claim. '
    + 'checkpoint({operationId,expectedCheckpointVersion,state}) saves your working state as JSON of at most 16000 characters. Save progress, decisions, the next step and references to what you produced whenever you finish an important step; '
    + 'this neither ends the turn nor makes changes to files reversible. On a version conflict call read_context again instead of guessing the version.',
  tools: [
    {
      name: 'read_context',
      worker: {
        call: (ctx, state, task) => {
          const agent = taskAgent(state, task);
          const statuses = statusesFor(state, agent?.key);
          const asked = agent ? openAsksOf(state, agent.agentId, ctx.now()) : [];
          return { request: state.goal, goal: goalView(state, task), ...(statuses.length ? { statuses } : {}), objective: readText(state, task.objective), inputRefs: task.inputRefs, member: memberContext(state, task),
            // The version checkpoint expects, which a member that has saved none yet has nowhere else to read.
            ...(agent ? { checkpointVersion: agent.checkpointVersion } : {}),
            ...(agent ? memberTodos(state, agent.key, ctx.now()) : {}), ...(asked.length ? { asked } : {}), board: boardDigest(state, task), workQueue: workContext(state, task),
            ...(task.workflowTool ? {workflows:nestedContext(ctx.store.descendants(state,task.taskId),task)} : {}) };
        },
      },
    },
    {
      name: 'checkpoint',
      worker: {
        verifiesRoot: true,
        call: (ctx, state, task, _caller, args) => memberOperation(ctx, state, task, 'checkpoint', args, agent => {
          if (args.expectedCheckpointVersion !== agent.checkpointVersion) throw new Error('checkpointVersion conflict; read_context before updating');
          const saved = saveCheckpoint(state, task, args.state, ctx.now());
          return { checkpointRef: saved.ref, checkpointVersion: saved.version };
        }),
      },
    },
    {
      name: 'read_checkpoint',
      main: { kind: 'read', doc: 'read_checkpoint(member)', read: (_ctx, state, args) => checkpoint(requireState(state), member(requireState(state), requiredText(args.member, 100))) ?? null },
    },
  ],
};
