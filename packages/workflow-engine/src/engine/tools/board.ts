import { postToBoard, readBoard, searchBoard } from '../board';
import { inheritedWorkerExecution } from '../execution';
import { finishSwarm, staffSelection, staffSwarm } from '../swarm';
import { memberOperation } from './members';
import { mailboxOperation, taskAgent } from '../durable-agents';
import { requiredText, requireState } from '../kernel-state';
import type { WorkerExecution } from '../types';
import type { ToolArgs, WorkflowToolPlugin } from './types';

const staffing = (args: ToolArgs): ToolArgs => Object.fromEntries(Object.entries(args).filter(([key]) => !CONTROL_ARGS.includes(key)));
import { CONTROL_ARGS } from './control-args';
import { versioned } from './versioned';

/** The shared message board: one ordered, append-only feed that every agent of the workflow can read. */
export const boardTools: WorkflowToolPlugin = {
  id: 'board',
  memberInstructions: '留言板是本工作流全员可见、只追加的有序消息流。post_board({operationId,text,to?,topic?}) 发帖：text 最多 4000 字符；to 为成员名数组或 "all"，正文里的 @成员名、@all 同样生效；topic 是帖子所属的主题（1–40 位小写字母、数字及 _.-，不写归入 general），同一条工作线始终用同一个主题名，先看已有主题再决定是否新开，全板最多 64 个主题。主题 announce 是公告：只有主 agent、脚本和 swarm 的 lead 能发，内容是所有成员都要遵守的规则变更和裁定。被点名的成员会被唤醒并在下一轮的 read_context.member.messages 里收到该帖（带 post 序号）；不点名的帖子只留在板上，不唤醒任何人。read_board({after?,limit?,member?,topic?}) 读帖：不带 after 返回最新 limit 条（默认 20，最多 50），带 after 返回该序号之后的帖子；member 只看某成员发出或收到的帖子，topic 只看一个主题；板上有多个主题时结果里的 topics 列出各主题的帖数和最新序号。每轮 read_context 的 board 字段已给出：announcements 是上一轮开始以来的新公告全文（必须遵守；moreAnnouncements 表示还有更早的未列出，用 read_board({topic:"announce"}) 读），topics 是各主题的总帖数和其中新增的条数（new）。据此只读与自己工作有关的主题，不要整板翻页。search_board({query,member?,topic?,limit?}) 按关键词查全部历史帖子：query 为空格分隔的词（最多 8 个），不分大小写、按子串匹配，须全部出现；返回最新的 limit 条（默认 10，最多 30），每条带序号和命中处的片段，全文用 read_board({after:序号-1,limit:1}) 读。板上帖子多时先搜再读，不要整板翻页。结论、提问、交接、阻塞发到板上，写明谁需要做什么；不要发纯确认或致谢，避免互相唤醒空转。工作项的完成汇报不发帖：它写在 complete_work 的 result 里，别人用 search_work 查。帖子不可修改或撤回，也不代表对方已处理。',
  tools: [
    {
      name: 'post_board',
      main: {
        doc: 'post_board(text,to?,topic?)',
        ...versioned((ctx, state, args) => postToBoard(state, { author: 'main' }, args, ctx.now()), { allowInterrupted: true, appendOnly: true }),
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
      main: { kind: 'read', doc: 'read_board(after?,limit?,member?,topic?)', read: (_ctx, state, args) => readBoard(requireState(state), args) },
      worker: { call: (_ctx, state, _task, _caller, args) => readBoard(state, args) },
    },
    {
      name: 'search_board',
      main: { kind: 'read', doc: 'search_board(query,member?,topic?,limit?)', read: (_ctx, state, args) => searchBoard(requireState(state), staffing(args)) },
      worker: { call: (_ctx, state, _task, _caller, args) => searchBoard(state, args) },
    },
  ],
};

/** Management of a running swarm by its lead. */
export const swarmTools: WorkflowToolPlugin = {
  id: 'swarm',
  memberInstructions: '以下两个操作只有 swarm 的 lead 可用，其他成员调用会被拒绝。staff_swarm({operationId,add?,like?,queue?,role?,brief?,revive?,retire?,maxTurns?}) 调整本 swarm 的人手：add 为新成员名数组（1–40 位字母数字及 _.-），新成员沿用 like 指定的现有成员（默认第一个非 lead 成员）的执行器、模型、角色和队列（lead 不能另选执行器或模型，需要时请主 agent 加人），首轮会看到任务、角色和 brief，queue 让它消费该工作队列（有可领工作时才启动），先加成员再发帖点名它；revive 为 "failed" 或成员名数组，让失败的成员在原会话里重试上一轮；retire 为成员名数组，成员正在执行的一轮会跑完，之后不再被唤醒；maxTurns 提高每名成员可被唤醒的次数。swarm_finish({operationId,result}) 宣布结束并给出最终结果（最多 16000 字符）；仍在执行的轮次结束后 swarm 返回，之后不再唤醒任何成员。成员失败、全员空闲时系统会发帖点名 lead。',
  tools: [
    { name: 'staff_swarm',
      main: { doc: 'staff_swarm(swarm?,add?,like?,harness?,model?,reasoningEffort?,queue?,role?,brief?,revive?,retire?,maxTurns?)',
        ...versioned((_ctx, state, args, execution) => staffSwarm(state, staffing(args), undefined, execution as WorkerExecution | undefined), {
          // Naming a harness or model needs the host's binding for it, which is resolved like a script member's.
          resolve: async (ctx, state, args) => {
            const selection = staffSelection(state, staffing(args), ctx.host);
            return selection && (ctx.host.resolveWorker?.(state.root, selection) ?? inheritedWorkerExecution(state.root, selection));
          },
        }) },
      worker: { verifiesRoot: true,
        call: (ctx, state, task, _caller, args) => memberOperation(ctx, state, task, 'staff_swarm', args, agent => staffSwarm(state, staffing(args), agent.key)) } },
    { name: 'swarm_finish', worker: { verifiesRoot: true,
      call: (ctx, state, task, _caller, args) => memberOperation(ctx, state, task, 'swarm_finish', args, agent => finishSwarm(state, agent.key, args)) } },
  ],
};
