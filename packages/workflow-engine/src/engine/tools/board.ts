import { postToBoard, readBoard } from '../board';
import { addSwarmMember, finishSwarm, retireSwarmMember } from '../swarm';
import { memberOperation } from './members';
import { mailboxOperation, taskAgent } from '../durable-agents';
import { requiredText, requireState } from '../kernel-state';
import type { WorkflowToolPlugin } from './types';
import { versioned } from './versioned';

/** The shared message board: one ordered, append-only feed that every agent of the workflow can read. */
export const boardTools: WorkflowToolPlugin = {
  id: 'board',
  memberInstructions: '留言板是本工作流全员可见、只追加的有序消息流。post_board({operationId,text,to?}) 发帖：text 最多 4000 字符；to 为成员名数组或 "all"，正文里的 @成员名、@all 同样生效。被点名的成员会被唤醒并在下一轮的 read_context.member.messages 里收到该帖（带 post 序号）；不点名的帖子只留在板上，不唤醒任何人。read_board({after?,limit?,member?}) 读帖：不带 after 返回最新 limit 条（默认 20，最多 50），带 after 返回该序号之后的帖子；member 只看某成员发出或收到的帖子。进展、结论、提问、交接都发到板上，写明谁需要做什么；不要发纯确认或致谢，避免互相唤醒空转。帖子不可修改或撤回，也不代表对方已处理。',
  tools: [
    {
      name: 'post_board',
      main: {
        doc: 'post_board(text,to?)',
        ...versioned((ctx, state, args) => postToBoard(state, { author: 'main' }, args, ctx.now()), { allowInterrupted: true }),
      },
      worker: {
        verifiesRoot: true,
        call: (ctx, state, task, _caller, args) => {
          const agent = taskAgent(state, task);
          if (!agent) throw new Error('Posting requires a persistent member; one-off workers can only read the board');
          if (state.status !== 'active' || state.script?.status !== 'running' || ctx.now() >= state.deadlineAt) throw new Error('Workflow is inactive');
          return mailboxOperation(state, 'worker:' + task.taskId + ':' + requiredText(args.operationId, 160), { method: 'post_board', args },
            () => postToBoard(state, { agentId: agent.agentId }, args, ctx.now()));
        },
      },
    },
    {
      name: 'read_board',
      main: { kind: 'read', doc: 'read_board(after?,limit?,member?)', read: (_ctx, state, args) => readBoard(requireState(state), args) },
      worker: { call: (_ctx, state, _task, _caller, args) => readBoard(state, args) },
    },
  ],
};

/** Management of a running swarm by its lead. */
export const swarmTools: WorkflowToolPlugin = {
  id: 'swarm',
  memberInstructions: '以下三个操作只有 swarm 的 lead 可用，其他成员调用会被拒绝。swarm_add_member({operationId,name,role?,brief?,like?}) 在运行中增加成员：name 为 1–40 位字母数字及 _.-；新成员沿用 like 指定的现有成员（默认第一个非 lead 成员）的执行器和模型，首轮会看到任务、角色和 brief；先加成员再发帖点名它。swarm_retire_member({operationId,name}) 让成员退出，它正在执行的一轮会跑完，之后不再被唤醒。swarm_finish({operationId,result}) 宣布结束并给出最终结果（最多 16000 字符）；仍在执行的轮次结束后 swarm 返回，之后不再唤醒任何成员。成员失败、全员空闲时系统会发帖点名 lead。',
  tools: [
    { name: 'swarm_add_member', worker: { verifiesRoot: true,
      call: (ctx, state, task, _caller, args) => memberOperation(ctx, state, task, 'swarm_add_member', args, agent => addSwarmMember(state, agent.key, args)) } },
    { name: 'swarm_retire_member', worker: { verifiesRoot: true,
      call: (ctx, state, task, _caller, args) => memberOperation(ctx, state, task, 'swarm_retire_member', args, agent => retireSwarmMember(state, agent.key, args)) } },
    { name: 'swarm_finish', worker: { verifiesRoot: true,
      call: (ctx, state, task, _caller, args) => memberOperation(ctx, state, task, 'swarm_finish', args, agent => finishSwarm(state, agent.key, args)) } },
  ],
};
