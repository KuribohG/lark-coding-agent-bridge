import { BUILTIN_WORKFLOW_TOOLS } from './registry';
import { WORKFLOW_ADVANCED_SCRIPT_GUIDE, WORKFLOW_SCHEDULING_INSTRUCTIONS } from './script-guide';
import type { WorkflowTask } from '../types';

const tools = BUILTIN_WORKFLOW_TOOLS;

export const WORKFLOW_TOOL_INSTRUCTIONS = `工作流工具通过 shell 调用：node "$AGENT_WORKFLOW_CLI" workflow <operation> --input '<JSON>' --json，也可 --input-file <path>。环境里的 CLI 路径属于当前 bridge 版本。
工作流模式由 bridge 的 /workflow 命令路由决定，不根据自然语言或任务类型推断。仅 /workflow start 或 /workflow script 命令授权的启动轮可调用 run_script；内部完成事件只允许继续处理已绑定的工作流，不能新建。普通消息不能新建工作流；话题里已有工作流时，普通消息轮可以查看和干预它。
run_script 需要唯一 operationId；所有其他变更需要 workflowId、唯一 operationId、expectedStateVersion（从 status 返回）。冲突时重读 status，不自动重试不同内容。
操作：${tools.mainOperations()}。
主 agent 沿用当前会话的 harness、model 和 reasoningEffort（飞书 /config run、/model、/effort 在开始前设置）。execution:{agentKind,model?,reasoningEffort?} 设置脚本 worker 默认值。agent(prompt,{key,member?,harness?,model?,reasoningEffort?,output?:"text"|"json",schema?,onError?:"null"|"throw",workflowTool?}) 可为每个 worker 覆盖 harness、模型和强度；同一 harness 可用不同模型。省略时使用对应目标的设置；跨 harness 不继承其它 harness 的模型。只接受当前已授权 profile，不接受其它 profile、凭据或环境变量。目标必须支持独立 final_text，模型必须由目标 harness/服务支持。
plan 是给用户看的具体执行方案（最多 12000 字符），必须说明阶段、每个 worker 的 harness/模型/任务、依赖和分支条件；bridge 在启动 worker 前自动展示，用户用 /workflow plan 可复查，不需要额外审批。修改 script、args 或 execution 重放时必须同时更新 plan，避免显示旧方案。原始脚本和方案分别保存在 sourceRef、planRef 指向的产物中。
script 是支持顶层 await/return 的 JS 函数体，无 import/process/require/文件接口。args 是 JSON；agent 返回 Promise，key 必须唯一且稳定。parallel 接收函数数组；pipeline(items,...stages) 并行处理各元素并顺序经过 stages(value,index)。phase/log 接收文本。所有 agent 调用必须 await。worker 自身失败（执行失败、JSON/schema 不合格等）时 agent() 默认返回 null 并记入日志，结果须 .filter(Boolean) 或判空；需要失败即中止时传 onError:"throw"。参数错误、重复 key、预算/调用上限仍直接抛错。parallel/pipeline 不会整体失败：抛错的函数或阶段对应 null，pipeline 中该项跳过后续阶段；discuss 同样支持 onError。schema 传 JSON Schema（根须为 {type:"object",properties}，支持 type/properties/required/additionalProperties/items/enum/const/anyOf/min*/max*），隐含 output:"json"，bridge 校验，不合格时在同一会话追问最多两次。agent/startAgent 可传 inputs:[前序 agent key]（1–16 个，须是本次运行中已 await 成功的调用），worker 的 prompt 只带每个结果的 ref 和开头预览，全文由 worker 用 read_artifact 读取；大段材料用 inputs 传递，不要拼进 prompt。默认最多 32 次调用、4 个 worker（maxAgents 可调到 2048，maxConcurrent 可调到 256；实际并发还受 bridge 的 max_concurrent_runs 约束）；总时限由 workflow_timeout_minutes 配置（内置 480 分钟），不传 timeoutMs 即使用配置值，显式值只能缩短时限。示例：return await agent(args.task,{key:"review",harness:"pi",model:args.reviewModel});
脚本可 await enqueueWork({key,title,input,resources?,maxAttempts?}) 创建工作项，await workStatus({itemId?,offset?,limit?}) 查询。enqueue key/输入在重放时不变；同名复用原项。resources 是共享 worktree/文件的显式互斥键，同键工作项串行领取，不创建文件沙箱。持久成员用 CLI 主动 claim_work，工作进展属于工作项，接手者能恢复。原子认领及提交版本由 bridge 管理；成员轮次运行期间认领由 bridge 自动续期，轮次结束、被取消或卡死被停止时认领被收回。工作项未完成时，脚本返回会失败；暂停后须显式 replay，重启时正在运行的会自动重放。
队列由 swarm 成员消费：在 swarm 的成员上写 queue:"队列名"，bridge 在该队列有可领工作时唤醒它（见下文 swarm）。无可领任务时持久等待，不占 worker 进程；新任务或回收的认领可触发新轮次，完成轮次复用原生会话。失败/取消的成员在本次运行停止，其余成员继续接管；显式重放才可重试其原轮次。生产完毕调用 await closeWorkQueue({key})；并行生产时先启动 swarm（不 await），生产并关闭队列后再 await 它。主 CLI 可 close_work_queue，用户也可 /workflow enqueue <工作项JSON> 和 /workflow close。关闭后拒绝新项，重放仍可复用已入队项；暂停后入队或关闭不会自动恢复执行。空队列仍占一个有时限的脚本解释器，不占 worker。
普通 agent() 重放只复用 key/输入/执行绑定（包括模型）匹配的成功任务；外部状态变化应写入输入或换 key。未启用子 workflow 的一次性任务失败后重放用新会话；带 member 的任务保持成员身份和原生会话，重试原逻辑轮次。副作用不保证 exactly-once。暂停会取消在途 worker，resume 从头重放并复用完成结果。Bridge 重启时正在运行的根工作流会自动重放续跑，停机时间不计入截止时间；暂停的或无法自动续跑的保持中断，需 replay_script 或用户 /workflow resume。脚本结果是 workflow-result 产物，主 agent read_artifact、ack_events 后 complete；也可发布 report 后完成。
${WORKFLOW_SCHEDULING_INSTRUCTIONS}
staff_swarm 在不重放的情况下调整运行中的 swarm（swarm 为它的 key，只有一个在跑时可省略）：add 为新成员名数组（1–64 个），沿用 like 指定成员（默认第一个非 lead 成员）的执行器、模型、角色和队列，queue/role 可另行指定；revive 为 "failed" 或成员名数组，让失败的成员在原会话里重试上一轮并恢复被唤醒；retire 为成员名数组，让成员跑完当前一轮后不再被唤醒；maxTurns 提高每名成员可被唤醒的次数（只增不减，最多 64）。成员失败后队列里的活没人领、或工作重心变了时用它，而不是重放脚本。
run_script/replay_script 后结束 turn，子任务由 bridge 管理。仅在整体结束、失败或 worker 回复主 agent（worker_reply 事件）时唤醒主会话。tell_worker(target,text) 把一段话作为用户消息插进正在运行的 worker 会话（target 为 taskId、成员名或脚本 key）；worker 可用 reply_main 答复一次，worker_messages 读取往来记录。内部事件不是用户消息或原生问题答案。不要读取或展示环境中的调用凭据。worker 仅可执行原始需求授权的任务；主、子运行沿用已授权 profile，角色说明不代表工具沙箱隔离。
以上是常用部分。讨论（discuss）、复核与推测执行（reviewedAgent、speculativeAgent）、成员间直接收发消息与事件等待（send、receive、waitFor、waitWork、sleep）、任务句柄（joinTask、cancelTask、raceTasks）、Git 工作树与落地（createWorkspace、configureLanding 等）、子工作流（workflowTool）不在本说明里：脚本要用到其中任何一项之前，先运行 node "$AGENT_WORKFLOW_CLI" workflow guide 读取完整说明，不要凭记忆猜参数。`;

/** Everything a script author may need: the per-turn instructions plus the less common script functions. Printed by `workflow guide`. */
export const WORKFLOW_GUIDE = `${WORKFLOW_TOOL_INSTRUCTIONS}

进阶脚本 API：
每个 agent 和 swarm 成员可独立设置 workflowTool:true，默认 false。不沿父层自动继承。仅显式开启的 worker 获得 run_workflow 工具，可编写完整子脚本并逐个控制下一层开关；不是主 agent 的操作。子调用先保存 checkpoint 并让出本轮，结果就绪后恢复原会话；只有整棵树最终结果唤醒主会话。并发、任务预算和截止时间受根约束，最多3层子 workflow、256个子运行。
带 member 的调用使用稳定成员名，必须逐轮 await，同一成员的 harness/模型绑定不可变。send(member,text,{key}) 和 receive(member,{key}) 是脚本内 Promise：receive 等待持久化 inbox，不占 worker 进程；收到的消息在下一轮成员成功提交时确认。成员必须先通过 agent 创建。普通一次性 agent 不保存成员状态。所有脚本 key 在本次运行内唯一。成员重放须保持历史轮次输入不变，改写历史请用新成员名。
${WORKFLOW_ADVANCED_SCRIPT_GUIDE}`;

/**
 * For an ordinary user turn in a scope that has a workflow: enough to inspect it and act on the user's request,
 * without the script guide, which `workflow guide` prints when a replay needs it.
 */
export const WORKFLOW_MESSAGE_INSTRUCTIONS = `本话题有一个 bridge 管理的工作流，本轮已获得它的调用凭据：用户询问进度或要求干预时直接操作，不需要用户再发 /workflow 命令；用户没有提到它时不要动它。
调用方式：node "$AGENT_WORKFLOW_CLI" workflow <operation> --input '<JSON>' --json，也可 --input-file <path>。status 返回完整状态；变更需要 workflowId、唯一 operationId、expectedStateVersion（取自 status），冲突时重读 status。
操作：${tools.mainOperations()}。
tell_worker(target,text) 把一段话作为用户消息插进正在运行的 worker 会话（target 为 taskId、成员名或脚本 key），用于中途纠偏或提问；返回 accepted 表示已送达会话，inactive 表示它没有在跑的轮次（持久成员改用 post_board 点名）。worker 用 reply_main 答复时你会被唤醒，worker_messages 读取往来记录。
staff_swarm 在不重放的情况下调整运行中的 swarm（swarm 为它的 key，只有一个在跑时可省略）：add 为新成员名数组（1–64 个），沿用 like 指定成员（默认第一个非 lead 成员）的执行器、模型、角色和队列，queue/role 可另行指定；revive 为 "failed" 或成员名数组，让失败的成员在原会话里重试上一轮并恢复被唤醒；retire 为成员名数组，让成员跑完当前一轮后不再被唤醒；maxTurns 提高每名成员可被唤醒的次数（只增不减，最多 64）。成员失败后队列里的活没人领、或工作重心变了时用它，而不是重放脚本。
本轮不能 run_script 新建工作流。改脚本重放（replay_script，须同时更新 plan）前，用 read_artifact 读取 status 里 script.sourceRef、script.planRef 指向的现行脚本和方案；脚本 API 的完整说明不在上下文里时运行 node "$AGENT_WORKFLOW_CLI" workflow guide。暂停、取消、重放等会中断在途 worker 的操作，只在用户明确要求或同意后执行。不要读取或展示环境中的调用凭据。`;

const MEMBER_PREAMBLE = `你是 bridge 管理的持久工作流成员。遵守原始需求授权，只处理本轮输入，最终答复结束本轮并释放执行资源。角色说明不改变实际权限。不要发送外部消息或派生子 agent。
你可使用当前绑定的 CLI：node "$AGENT_WORKFLOW_CLI" workflow <operation> --input '<JSON>' --json（也可 --input-file）。不要读取调用凭据。`;

const MEMBER_CLOSING = `脚本负责 receive 等待和下一轮调度。需要等待时，保存 checkpoint，再用最终答复说明等待原因；不要在 CLI 进程里轮询或睡眠。恢复时核对已经发生的副作用，接着保存的工作状态继续。`;

const WORKFLOW_MEMBER_INSTRUCTIONS = [MEMBER_PREAMBLE, ...tools.memberInstructions(), MEMBER_CLOSING].join('\n');
const NESTED_WORKFLOW_INSTRUCTIONS = tools.nestedInstructions().join('\n');

/** Only WorkflowRuntime calls this. Ordinary agent entries never receive this capability or binding. */
export function workflowWorkerInstructions(task: WorkflowTask): string {
  const base = task.agentId ? WORKFLOW_MEMBER_INSTRUCTIONS
    : '你是 bridge 管理的脚本工作流子 agent。只完成指定任务，遵守原始需求的授权范围，不要自行发送消息或派生子 agent。用最终答复返回结果。角色提示不改变实际执行权限。';
  if (!task.workflowTool) return base;
  return base.replace('不要发送外部消息或派生子 agent。','不要发送外部消息。')
    .replace('不要自行发送消息或派生子 agent。','不要自行发送外部消息。')+'\n\n'+NESTED_WORKFLOW_INSTRUCTIONS;
}
