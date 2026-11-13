import { CONTROL_ARGS } from './control-args';
import { requireState } from '../kernel-state';
import { closeWorkQueue, enqueueFromMember, enqueueWork, holdClaim, mutateWork, retryWork, workOperation, workStatus, WORK_MUTATIONS } from '../work-queue';
import { queueName } from '../work-routing';
import { scriptText } from '../script-contract';
import type { ToolArgs, WorkflowTool, WorkflowToolPlugin } from './types';
import type { WorkflowView } from '../types';
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
      active(ctx, state);
      return mutateWork(state, task, caller.attemptId, name, args, ctx.now());
    },
  },
}));

function active(ctx: { now(): number }, state: WorkflowView): void {
  if (state.status !== 'active' || state.script?.status !== 'running' || ctx.now() >= state.deadlineAt) throw new Error('Workflow is inactive');
}

const LAND_LEASE_MS = 120_000;

/**
 * Lands the commits of the member's worktree and, when it holds a claim, completes that work item with the landing.
 * A rejected landing leaves the claim with the member, who repairs the worktree and submits again.
 */
const submitWork: WorkflowTool = {
  name: 'submit_work',
  worker: {
    verifiesRoot: true,
    prepare: (ctx, state) => ctx.scheduler.expireClaims(state),
    call: () => { throw new Error('submit_work runs outside a transaction'); },
    run: async (ctx, caller, args, bound) => {
      if (Object.keys(args).some(key => !['operationId', 'claimId', 'generation', 'result'].includes(key))) throw new Error('Unsupported submit_work option');
      const operationId = scriptText(args.operationId, 'operationId', 160);
      const claim = args.claimId === undefined ? undefined : { claimId: args.claimId, generation: args.generation };
      if (!claim && args.result !== undefined) throw new Error('result belongs to a claimed work item; pass claimId and generation');
      const hold = () => bound((state, task) => {
        active(ctx, state);
        if (claim) holdClaim(state, task, caller.attemptId, claim, ctx.now(), LAND_LEASE_MS);
      });
      const start = bound((state, task) => {
        active(ctx, state);
        const prior = claim && workOperation(state, task, caller.attemptId, operationId);
        if (prior) return { prior: prior.response };
        if (!task.workspaceId) throw new Error('submit_work requires a member that runs in a managed worktree');
        if (!ctx.host.land) throw new Error('Landing is unavailable in this workflow');
        if (claim) holdClaim(state, task, caller.attemptId, claim, ctx.now(), LAND_LEASE_MS);
        return { workspace: task.workspaceId, state: ctx.store.public(state) };
      });
      if ('prior' in start) return { status: 'landed', item: start.prior };
      // Checks may outlast any lease: keep the claim while they run, and stop landing once the member's turn is gone.
      const controller = new AbortController();
      const timer = setInterval(() => { try { hold(); } catch (error) { controller.abort(error); } }, LAND_LEASE_MS / 4);
      timer.unref();
      let report;
      try { report = await ctx.host.land!(start.state, { workspace: start.workspace, taskId: caller.taskId }, controller.signal) as { status: string; headCommit?: string; commits?: number }; }
      finally { clearInterval(timer); }
      if (report.status !== 'landed' || !claim) return report;
      const item = bound((state, task) => mutateWork(state, task, caller.attemptId, 'complete_work',
        { operationId, ...claim, result: args.result ?? { headCommit: report.headCommit, commits: report.commits } }, ctx.now()));
      return { ...report, item };
    },
  },
};

/** Durable work queues: the main agent produces and inspects items; persistent members claim and finish them. */
export const workQueueTools: WorkflowToolPlugin = {
  id: 'work-queue',
  memberInstructions: '工作队列：claim_work({operationId,leaseMs?,queue?}) 原子领取一个工作项（每个成员最多一个），返回 claimId、generation、leaseUntil、item；没有可领项返回 null，应结束本轮，不忙等。在 swarm 里声明了 queue 的成员省略 queue 即使用该队列，不能领取其它队列；其他成员默认领取 default。认领在你这一轮运行期间由 bridge 自动续期，不需要也不能自己续租；本轮结束、被取消或因长时间无输出被停止时，未完成的认领会被收回给别人。先读取 item.progress 核对已完成步骤。checkpoint_work({operationId,claimId,generation,expectedProgressVersion,state}) 保存最多 16000 字符的 JSON 工作进展；complete_work({operationId,claimId,generation,result}) 提交 JSON 结果；fail_work({operationId,claimId,generation,error,retry?}) 报错；release_claim({operationId,claimId,generation,reason}) 交还工作。工作项 input/progress/result 各最多 16000 字符。work_status({itemId? 或 offset?,limit?}) 读取工作状态，默认每页 16 项、最多 64 项。队列变更 operationId 在当前执行 attempt 内唯一，同内容重试复用；恢复后的新 attempt 可重新领取，过期的旧 claimId/generation 不可提交。空 claim 的重试查询须用新 operationId。取消、退出或失去租约会回收未完成认领，保存的工作进展保留；外部副作用仍需核对和幂等处理。在托管 worktree 中运行且脚本已配置落地（系统提示里有 Landing branch）时，用 submit_work({operationId,claimId?,generation?,result?}) 提交代码：先把修改提交成 commit，它把你的 commit rebase 到落地分支最新位置、在你的 worktree 里跑统一检查、通过后推进落地分支，并在带 claimId 时以 result（省略则为落地 commit）完成该工作项，返回 {status:"landed",headCommit,commits,item}。返回 {status:"conflict",targetCommit,detail} 表示 rebase 冲突，worktree 已恢复到提交前；自行 git rebase 到 targetCommit 解决冲突后再提交。返回 {status:"check_failed",commands,reason?} 表示检查未过，worktree 已停在 rebase 之后；修复并提交后再提交。两种情况认领仍归你，租约在检查期间自动续期；确实做不了就 release_claim 或 fail_work。调用可能阻塞到检查跑完：命令超时被打断时用相同 operationId 重试会接回同一次落地，被拒后再次提交用新 operationId。领取下一项前先 rebase 到落地分支以带上别人已落地的修改。enqueue_work({key,title,input,queue?,priority?,dependsOn?,resources?,maxAttempts?}) 把你发现的、需要有人去做的工作加入队列，消费该队列的成员随即可以领取：用于拆分过大的工作项、登记排查中发现的新问题，或在队列变空而目标未达成时补充下一批工作。queue 省略为你消费的队列（没有则 default），只能加入已存在且未关闭的队列。key 取能标识问题本身的稳定名字（如 bug-<模块>-<现象>）：key 已存在时不新建，返回 {itemId,key,existing:true,status}，所以先据此去重再决定是否另报。title 一句话说明，input 写清现象、复现方法和已知线索，让领取者不必重查。',
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
      worker: {
        verifiesRoot: true,
        call: (ctx, state, task, _caller, args) => {
          active(ctx, state);
          ctx.scripts.checkWorkKey(state, args.key);
          return enqueueFromMember(state, task, args, ctx.now());
        },
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
    submitWork,
  ],
};
