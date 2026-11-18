import { postToBoard, readBoard, resolvePosts, searchBoard } from '../board';
import { workflowDigest } from '../digest';
import { inheritedWorkerExecution } from '../execution';
import { finishSwarm, staffCleanups, staffSelection, staffSwarm, staffWorkspaces } from '../swarm';
import { memberOperation } from './members';
import { mailboxOperation, taskAgent } from '../durable-agents';
import { mailboxOperationByKey, requiredText, requireState } from '../kernel-state';
import type { WorkerExecution, WorkflowView } from '../types';
import type { ToolArgs, WorkflowToolPlugin } from './types';

const staffing = (args: ToolArgs): ToolArgs => Object.fromEntries(Object.entries(args).filter(([key]) => !CONTROL_ARGS.includes(key)));
import { CONTROL_ARGS } from './control-args';
import { versioned } from './versioned';

/** The shared message board: one ordered, append-only feed that every agent of the workflow can read, and whose posts can be marked resolved. */
export const boardTools: WorkflowToolPlugin = {
  id: 'board',
  memberInstructions: '留言板是本工作流全员可见、只追加的有序消息流。post_board({operationId,text,to?,topic?}) 发帖：text 最多 4000 字符；to 为成员名数组或 "all"，正文里的 @成员名、@all 同样生效；topic 是帖子所属的主题（1–40 位小写字母、数字及 _.-，不写归入 general），同一条工作线始终用同一个主题名，先看已有主题再决定是否新开，全板最多 64 个主题。主题 announce 是公告：只有主 agent、脚本和 swarm 的 lead 能发，内容是所有成员都要遵守的规则变更和裁定。被点名的成员会被唤醒并在下一轮的 read_context.member.messages 里收到该帖（带 post 序号）；不点名的帖子只留在板上，不唤醒任何人。read_board({after?,limit?,member?,topic?}) 读帖：不带 after 返回最新 limit 条（默认 20，最多 50），带 after 返回该序号之后的帖子；member 只看某成员发出或收到的帖子，topic 只看一个主题；已解决的帖子默认跳过（resolvedSkipped 是被跳过的条数），加 resolved:true 一并返回；板上有多个主题时结果里的 topics 列出各主题的帖数（posts）、其中已解决的条数（resolved）和最新序号。每轮 read_context 的 board 字段已给出：announcements 是上一轮开始以来的新公告全文（必须遵守；moreAnnouncements 表示还有更早的未列出，用 read_board({topic:"announce"}) 读），topics 是各主题的总帖数、已解决条数和其中新增的未解决条数（new）。据此只读与自己工作有关的主题，不要整板翻页。search_board({query,member?,topic?,limit?}) 按关键词查全部历史帖子：query 为空格分隔的词（最多 8 个），不分大小写、按子串匹配，须全部出现；返回最新的 limit 条（默认 10，最多 30），每条带序号和命中处的片段，全文用 read_board({after:序号-1,limit:1,resolved:true}) 读；已解决的帖子也能搜到，排在未解决的之后并带 resolved（by 谁、note 怎么解决的、see 答复或取代它的帖子序号），发帖提问或上报前先搜，已有结论就不要重复。板上帖子多时先搜再读，不要整板翻页。结论、提问、交接、阻塞发到板上，写明谁需要做什么；不要发纯确认或致谢，避免互相唤醒空转。工作项的完成汇报不发帖：它写在 complete_work 的 result 里，别人用 search_work 查；swarm 有 lead 时系统会把它汇总转给规划该项的 lead（主题 handoff），多项一起回传时每项只引用开头一两行，所以 result 先写结论，再写做了什么、发现了什么、与工作项要求的偏差和遗留的顾虑。帖子不可修改或撤回，也不代表对方已处理。resolve_post({operationId,seq,note?,see?,reopen?}) 把不再需要任何人处理的帖子标为已解决：提问已得到答复、请求已办完、结论已被新帖取代。seq 是帖子序号或序号数组（最多 32 个）；note 用一句话写明怎么解决的（最多 500 字符），see 是答复或取代它的帖子序号，两者至少给一个；reopen:true 撤销标记。自己发的帖、点名给自己的帖可以标，lead 和主 agent 可以标任何帖，公告只有 lead 和主 agent 能标。已解决的帖子仍留在板上、仍能搜到，只是默认不再出现在 read_board 里；收到的点名帖若带 resolved，说明已有人处理，不必再办。自己的提问得到答复、点名给自己的事办完后就标记，免得别人再读、再答。',
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
      name: 'resolve_post',
      main: {
        doc: 'resolve_post(seq,note?,see?,reopen?)',
        ...versioned((ctx, state, args) => resolvePosts(state, { author: 'main' }, args, ctx.now()), { allowInterrupted: true, appendOnly: true }),
      },
      worker: {
        verifiesRoot: true,
        call: (ctx, state, task, _caller, args) => memberOperation(ctx, state, task, 'resolve_post', args, agent => resolvePosts(state, { agentId: agent.agentId }, args, ctx.now())),
      },
    },
    {
      name: 'read_board',
      main: { kind: 'read', doc: 'read_board(after?,limit?,member?,topic?,resolved?)', read: (_ctx, state, args) => readBoard(requireState(state), args) },
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
  memberInstructions: '以下两个操作只有 swarm 的 lead 可用，其他成员调用会被拒绝。staff_swarm({operationId,add?,like?,workspace?,queue?,role?,brief?,revive?,retire?,cleanup?,maxTurns?}) 调整本 swarm 的人手：add 为新成员名数组（1–40 位字母数字及 _.-），新成员沿用 like 指定的现有成员（默认第一个非 lead 成员）的执行器、模型、角色和队列（lead 不能另选执行器或模型，需要时请主 agent 加人），首轮会看到任务、角色和 brief，queue 让它消费该工作队列（有可领工作时才启动），先加成员再发帖点名它；workspace 为 true 或 {base?,repo?,isolation?}，给 add 的每名新成员各建一个独立 Git worktree（省略 repo 时以工作流 cwd 为仓库、当前 HEAD 为基线；isolation:"clone" 改为每人一个独立仓库，不共用 .git），不加则新成员在根目录运行、与别人并行改代码会互相覆盖、也不能用 submit_work；revive 为 "failed" 或成员名数组，让失败的成员在原会话里重试上一轮；retire 为成员名数组，成员正在执行的一轮会跑完，之后不再被唤醒；cleanup 为 "retired" 或已停用成员名数组，释放其空闲、无未集成修改的 worktree（failed 成员不能清理，需先 revive 再 retire）；maxTurns 提高每名成员可被唤醒的次数；给队列设子领域 lead（leads）只有主 agent 能做。swarm_finish({operationId,result}) 宣布结束并给出最终结果（最多 16000 字符）；仍在执行的轮次结束后 swarm 返回，之后不再唤醒任何成员。成员失败、全员空闲时系统会发帖点名 lead；成员完成的和最终失败的工作项，系统在规划该项的 lead 下一轮开始时汇总发帖（主题 handoff）：一项时引用结果全文的开头，多项时每项一两行，全文用 work_status({key}) 读。',
  tools: [
    { name: 'staff_swarm',
      main: { doc: 'staff_swarm(swarm?,add?,like?,workspace?,harness?,model?,reasoningEffort?,queue?,leads?,role?,brief?,revive?,retire?,cleanup?,maxTurns?,maxConcurrent?)',
        ...versioned((_ctx, state, args, resolved) => {
          const staffed = resolved as { execution?: WorkerExecution; workspaces?: Record<string, string>; cleanedUp?: Array<{ name: string; workspace: string }> } | undefined;
          return staffSwarm(state, staffing(args), undefined, staffed?.execution, staffed?.workspaces, staffed?.cleanedUp, _ctx.now());
        }, {
          // Staffing is checked against the swarm as it is when the change commits, and no worker commit changes
          // what it checks: a swarm of a hundred members advances the version faster than a status can be read.
          appendOnly: true,
          // Naming a harness, a model or worktrees needs the host: the execution it binds for them is resolved like a
          // script member's, and the worktrees are made or released under the same authorization the change commits under.
          resolve: async (ctx, state, args) => {
            const input = staffing(args);
            const selection = staffSelection(state, input, ctx.host);
            const execution = selection ? await (ctx.host.resolveWorker?.(state.root, selection) ?? inheritedWorkerExecution(state.root, selection)) : undefined;
            const workspaces = await staffWorkspaces(ctx, state, input);
            const cleanedUp = await staffCleanups(ctx, state, input);
            return execution || workspaces || cleanedUp ? { execution, workspaces, cleanedUp } : undefined;
          },
        }) },
      worker: { verifiesRoot: true,
        call: () => { throw new Error('staff_swarm runs outside a transaction'); },
        run: async (ctx, caller, args, bound) => {
          const input = staffing(args);
          // A lead names neither harness nor model and cannot change concurrency; refuse before making worktrees that a
          // rejected change would strand.
          const forbidden = ['harness', 'model', 'reasoningEffort', 'maxConcurrent'].find(option => input[option] !== undefined);
          if (forbidden) throw new Error(forbidden === 'maxConcurrent' ? 'Only the main agent can change maxConcurrent' : 'Only the main agent can choose the harness or model of new members; a lead adds members like an existing one');
          const operationId = requiredText(args.operationId, 160);
          const key = 'worker:' + caller.taskId + ':' + operationId;
          const active = (state: WorkflowView) => {
            if (state.status !== 'active' || state.script?.status !== 'running' || ctx.now() >= state.deadlineAt) throw new Error('Workflow is inactive');
          };
          const digest = workflowDigest({ method: 'staff_swarm', args });
          const first = bound((state, task) => {
            if (!taskAgent(state, task)) throw new Error('This operation requires a persistent member');
            active(state);
            const prior = mailboxOperationByKey(state, key);
            if (prior) {
              if (prior.digest !== digest) throw new Error('Mailbox operation ID conflict');
              return { prior: prior.response } as const;
            }
            return { state } as const;
          });
          if ('prior' in first) return first.prior;
          const workspaces = await staffWorkspaces(ctx, first.state, input);
          const cleanedUp = await staffCleanups(ctx, first.state, input);
          return bound((state, task) => {
            const agent = taskAgent(state, task);
            if (!agent) throw new Error('This operation requires a persistent member');
            active(state);
            return mailboxOperation(state, key, { method: 'staff_swarm', args }, () => staffSwarm(state, input, agent.key, undefined, workspaces, cleanedUp, ctx.now()));
          });
        } } },
    { name: 'swarm_finish', worker: { verifiesRoot: true,
      call: (ctx, state, task, _caller, args) => memberOperation(ctx, state, task, 'swarm_finish', args, agent => finishSwarm(state, agent.key, args)) } },
  ],
};
