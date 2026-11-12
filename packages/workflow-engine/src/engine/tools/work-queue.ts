import { CONTROL_ARGS } from './control-args';
import { requireState } from '../kernel-state';
import { closeWorkQueue, enqueueWork, mutateWork, retryWork, workStatus, WORK_MUTATIONS } from '../work-queue';
import { queueName } from '../work-routing';
import type { ToolArgs, WorkflowTool, WorkflowToolPlugin } from './types';
import { versioned } from './versioned';

function operationInput(args: ToolArgs): ToolArgs {
  return Object.fromEntries(Object.entries(args).filter(([key]) => !CONTROL_ARGS.includes(key)));
}

/** Claims, leases and progress of a persistent member's work item. */
const claimTools: WorkflowTool[] = WORK_MUTATIONS.map(name => ({
  name,
  worker: {
    verifiesRoot: true,
    prepare: (ctx, state) => ctx.scheduler.expireClaims(state),
    call: (ctx, state, task, caller, args) => {
      if (state.status !== 'active' || state.script?.status !== 'running' || ctx.now() >= state.deadlineAt) throw new Error('Workflow is inactive');
      return mutateWork(state, task, caller.attemptId, name, args, ctx.now());
    },
  },
}));

/** Durable work queues: the main agent produces and inspects items; persistent members claim and finish them. */
export const workQueueTools: WorkflowToolPlugin = {
  id: 'work-queue',
  memberInstructions: '工作队列：claim_work({operationId,leaseMs?,queue?}) 原子领取一个工作项（每个成员最多一个），返回 claimId、generation、leaseUntil、item；没有可领项返回 null，应结束本轮，不忙等。在 swarm 里声明了 queue 的成员省略 queue 即使用该队列，不能领取其它队列；其他成员默认领取 default。默认租约 120 秒，范围 1–300 秒。先读取 item.progress 核对已完成步骤；长任务及时 renew_claim({operationId,claimId,generation,leaseMs?})。checkpoint_work({operationId,claimId,generation,expectedProgressVersion,state}) 保存最多 16000 字符的 JSON 工作进展；complete_work({operationId,claimId,generation,result}) 提交 JSON 结果；fail_work({operationId,claimId,generation,error,retry?}) 报错；release_claim({operationId,claimId,generation,reason}) 交还工作。工作项 input/progress/result 各最多 16000 字符。work_status({itemId? 或 offset?,limit?}) 读取工作状态，默认每页 16 项、最多 64 项。队列变更 operationId 在当前执行 attempt 内唯一，同内容重试复用；恢复后的新 attempt 可重新领取，过期的旧 claimId/generation 不可提交。空 claim 的重试查询须用新 operationId。取消、退出或失去租约会回收未完成认领，保存的工作进展保留；外部副作用仍需核对和幂等处理。',
  tools: [
    {
      name: 'enqueue_work',
      main: {
        doc: 'enqueue_work(key,title,input,queue?,priority?,dependsOn?,resources?,maxAttempts?)',
        ...versioned((ctx, state, args) => {
          ctx.scripts.checkWorkKey(state, args.key);
          return enqueueWork(state, operationInput(args), ctx.now());
        }, { allowInterrupted: true }),
      },
    },
    {
      name: 'retry_work',
      main: { doc: 'retry_work(itemId,additionalAttempts?)', ...versioned((ctx, state, args) => retryWork(state, operationInput(args), ctx.now()), { allowInterrupted: true }) },
    },
    {
      name: 'close_work_queue',
      main: {
        doc: 'close_work_queue(queue?)',
        ...versioned((ctx, state, args) => {
          if (Object.keys(args).some(key => ![...CONTROL_ARGS, 'queue'].includes(key))) throw new Error('Unsupported close_work_queue option');
          return closeWorkQueue(state, ctx.now(), queueName(args.queue));
        }, { allowInterrupted: true }),
      },
    },
    {
      name: 'work_status',
      main: { kind: 'read', doc: 'work_status(itemId? 或 queue?,offset?,limit?)',
        read: (_ctx, state, args) => workStatus(requireState(state), { itemId: args.itemId, offset: args.offset, limit: args.limit }) },
      worker: { call: (_ctx, state, _task, _caller, args) => workStatus(state, args) },
    },
    ...claimTools,
  ],
};
