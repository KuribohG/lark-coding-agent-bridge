import { WORKFLOW_SCHEDULING_INSTRUCTIONS } from './script-guide';
import type { WorkflowToolPlugin } from './types';

/** Child workflows started by workers that were explicitly granted the tool. */
export const nestedWorkflowTools: WorkflowToolPlugin = {
  id: 'nested-workflow',
  nestedInstructions: `当前 agent 已显式启用子 workflow 工具，只在 Workflow 模式内有效。
可通过 node "$AGENT_WORKFLOW_CLI" workflow run_workflow --input '<JSON>' --json（或 --input-file）调用完整的子 workflow。
输入：{operationId,key,goal,script,plan,args?,name?,execution?,maxAgents?,maxConcurrent?,timeoutMs?,checkpoint?,parentQueue?}。key 在当前父任务内稳定且唯一；同一 key 的输入不可变，同内容重试复用 operationId。script 是支持顶层 await/return 的 JS 函数体，使用 agent、parallel、pipeline、enqueueWork、consumeWork、closeWorkQueue、send、receive 等现有脚本接口。plan 必须说明子运行的步骤和每个 worker 的 harness/模型、分工、依赖和分支。只做根需求授权范围内的工作。
script 无 import/process/require/文件接口，args 是 JSON。所有 Promise 必须 await：parallel([()=>agent(...),...])；pipeline(items,...stages) 对元素并行、阶段顺序执行；phase/log(text) 保存进展。agent 的 output 默认 text，可选 json 严格解析。send(member,text,{key})、receive(member,{key}) 通过已创建的持久成员传递消息。enqueueWork({key,title,input,resources?,maxAttempts?}) 入队；workStatus({itemId?,offset?,limit?}) 查询；consumeWork({key,members:[{name,harness?,model?,reasoningEffort?,workflowTool?}],prompt,maxTurns?}) 调度专用成员领取任务；closeWorkQueue({key}) 显式关闭后消费池才会排空返回。每层队列和成员独立，所有 key 稳定且唯一。
${WORKFLOW_SCHEDULING_INSTRUCTIONS}
子脚本 agent(prompt,{key,member?,harness?,model?,reasoningEffort?,output?,workflowTool?,inputs?}) 可逐个决定是否给下一层植入此工具；workflowTool 默认 false，必须显式 true 才开启，consumeWork 的每个 members 配置也支持。不能通过修改当前调用参数给自己提权，不接受其它 profile、凭据或环境变量。
run_workflow 首次返回 status=waiting 和 workflowId；这是持久异步调用，请立即结束当前轮次，不要等待 shell、不轮询、不继续执行其它工作。最多30秒后 bridge 会停止未让出的执行。checkpoint 可保存最多16000字符的当前工作状态，恢复时连同子结果交回。未完成工作认领在让出时释放，恢复后须重新核对并领取，不能继续使用旧 claim。
bridge 等本轮退出后执行子脚本；成功或失败结果都会在原生会话的下一次执行中注入 workflows.call（ok/result/resultRef 或 error），read_context 同样可读。结束本轮的文字不会成为父任务的最终结果；恢复后完成原任务并给出最终答复。相同 key 的已完成子调用返回保存的成功或失败结果，不重复执行；要重试失败子调用须用新 key 和 operationId。根工作流暂停后需显式重放；重启时正在运行的根工作流会自动重放。
整棵树共享根并发、任务和尝试预算及截止时间，最多3层子 workflow、32个子运行。各层拥有自己的工作队列；显式 parentQueue:true 只授予子脚本 enqueueWork({queue:"parent",key,title,input,...}) 向直接父队列追加任务的能力，也可 enqueueWork({target:"parent",queue:"reviews",...}) 选择父命名队列，不授予关闭父队列或消费父队列的权限。子运行不直接向用户发送消息，结果交回调用者。`,
  tools: [
    { name: 'run_workflow', worker: { verifiesRoot: true, call: (ctx, state, task, _caller, args) => ctx.children.runChildWorkflow(state, task, args) } },
  ],
};
