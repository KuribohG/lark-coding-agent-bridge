import { checkpoint, mailboxOperation, member, memberContext, saveCheckpoint, taskAgent } from '../durable-agents';
import { boardDigest } from '../board';
import { requiredText, requireState } from '../kernel-state';
import { nestedContext } from '../nested-workflow';
import { charterView } from '../steering';
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
  memberInstructions: 'read_context 返回自己的 checkpoint 和本轮消息；task_status 返回当前 checkpointVersion。checkpoint({operationId,expectedCheckpointVersion,state}) 保存最多 16000 字符的 JSON 工作状态。请在完成重要步骤时保存进展、决定、下一步和产物引用；这不结束本轮，也不代表文件副作用可回滚。冲突时重新 read_context，不猜测版本。',
  tools: [
    {
      name: 'task_status',
      worker: { call: (_ctx, state, task) => ({ taskId: task.taskId, status: task.status, checkpointVersion: taskAgent(state, task)?.checkpointVersion }) },
    },
    {
      name: 'read_context',
      worker: {
        call: (ctx, state, task) => ({ goal: state.goal, charter: charterView(state, task), objective: readText(state, task.objective), inputRefs: task.inputRefs, member: memberContext(state, task), board: boardDigest(state, task), workQueue: workContext(state, task),
          ...(task.workflowTool ? {workflows:nestedContext(ctx.store.descendants(state,task.taskId),task)} : {}) }),
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
