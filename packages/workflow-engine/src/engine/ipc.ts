import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { WorkflowCaller, WorkflowTask } from './types';

const MAX_BODY = 512_000;

/** Tokens are per run, carried in environment only, and never accepted from request parameters. */
export class WorkflowIpc {
  private readonly bindings = new Map<string, { caller: WorkflowCaller; expiresAt: number }>();
  private readonly server: Server;
  private endpoint = '';

  constructor(call: (caller: WorkflowCaller, method: string, args: Record<string, unknown>) => Promise<unknown>, private readonly cliPath?: string) {
    this.server = createServer(async (request, response) => {
      response.setHeader('Content-Type', 'application/json');
      try {
        if (request.method !== 'POST' || request.url !== '/workflow') throw new Error('Invalid workflow endpoint');
        const token = request.headers.authorization?.replace(/^Bearer /, '') ?? '';
        const binding = this.bindings.get(token);
        if (!binding || binding.expiresAt <= Date.now()) {
          response.statusCode = 403;
          throw new Error('Workflow run binding is missing, expired or revoked');
        }
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of request) {
          size += chunk.length;
          if (size > MAX_BODY) throw new Error('Workflow request exceeds size limit');
          chunks.push(Buffer.from(chunk));
        }
        if (this.bindings.get(token) !== binding) throw new Error('Workflow binding revoked');
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { method?: unknown; args?: unknown };
        if (typeof body.method !== 'string' || !body.args || typeof body.args !== 'object' || Array.isArray(body.args)) throw new Error('Expected method and args object');
        const result = await call(binding.caller, body.method, body.args as Record<string, unknown>);
        response.end(JSON.stringify({ ok: true, result }));
      } catch (error) {
        if (response.statusCode === 200) response.statusCode = 400;
        response.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
      }
    });
    this.server.requestTimeout = 15_000;
    this.server.headersTimeout = 10_000;
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => { this.server.off('error', reject); resolve(); });
    });
    this.endpoint = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/workflow`;
  }

  bind(caller: WorkflowCaller, expiresAt: number): { env: Record<string, string>; release(): void } {
    if (!this.endpoint) throw new Error('Workflow IPC is not listening');
    const token = randomBytes(32).toString('hex');
    this.bindings.set(token, { caller, expiresAt });
    return {
      env: { AGENT_WORKFLOW_ENDPOINT: this.endpoint, AGENT_WORKFLOW_TOKEN: token,
        ...(this.cliPath ? { AGENT_WORKFLOW_CLI: this.cliPath } : {}) },
      release: () => { this.bindings.delete(token); },
    };
  }

  async close(): Promise<void> {
    this.bindings.clear();
    this.server.closeIdleConnections();
    await new Promise<void>((resolve, reject) => this.server.close(error => error ? reject(error) : resolve()));
  }
}

export async function callWorkflow(method: string, args: unknown, env = process.env): Promise<unknown> {
  const endpoint = env.AGENT_WORKFLOW_ENDPOINT;
  const token = env.AGENT_WORKFLOW_TOKEN;
  if (!endpoint || !token) throw new Error('This command requires a bridge-managed workflow run');
  const url = new URL(endpoint);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/workflow' || url.username || url.password) throw new Error('Invalid local workflow endpoint');
  const response = await fetch(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args }) });
  const body = await response.json() as { ok: boolean; result?: unknown; error?: string };
  if (!body.ok) throw new Error(body.error ?? 'Workflow request failed');
  return body.result;
}

const WORKFLOW_SCHEDULING_INSTRUCTIONS = `先判断任务形态：可拆成证据独立的子任务时分段执行（parallel/pipeline，再独立复核）；方案取舍、互相挑错、需要多方观点交锋才能收敛的问题用 discuss 多 agent 讨论；两者可组合，例如先分段取证再讨论结论。在 plan 中说明选择理由。
按任务的信息流选择编排：固定独立任务可 parallel/pipeline；动态批量任务用命名队列和 consumeWork；需要反馈的持久成员用 mailbox；局部探索用显式授权的子 workflow。说明生产结束条件、资源归属和失败处理。
discuss(topic,{key,members:[{name,role?,harness?,model?,reasoningEffort?,workflowTool?}],maxTurns?,summary?}) 让 2–6 名持久成员经 mailbox 讨论：先各自独立给出开场观点，之后每轮有新消息的成员并行发言，回复 JSON {message,to?,agree}，to 由成员决定发给谁（省略为全体，[] 为不发）。全员 agree、无人有新消息或 maxTurns（默认12，最多32，不含开场）用尽时停止；返回 {stop,turns,rounds,transcript,summary}。summary 默认 true，用独立 agent 总结共识与分歧，返回对象 {conclusion:string,agreements:string[],disagreements:string[],openQuestions:string[]}（拼成字符串时为可读文本；关闭时为 null），也可传 {harness,model,reasoningEffort} 或 false。成员名为1–40位字母数字及 _.-，在本 workflow 内专用于该讨论；key 最多80字符、不能以@开头。每次发言计入 maxAgents。成员 × (成员−1) + maxTurns × 成员 不得超过120。成员收到的消息以真实发言成员为发送者；脚本 send 不能指定发送者。
目标是正确率与有效结果的完成速度：独立子任务可并行，关键结论用独立证据复核；不同假设可定向交流反证，避免重复调查。简单任务无需强制多 agent 或复核；并行写文件须有独立归属或资源认领。耗时很长且通常会通过的确定性检查（全量模型检查、长测试）不要串行卡住下游：先跑快速检查，再用 speculativeAgent 让下游与长检查同时进行。
consumeWork 可显式 wakeOnMessages:true：已创建成员的待收消息自动送到其下一轮；空闲成员可立即处理反馈，活跃成员先结束当前轮，不并发双 turn。消息在成功轮次后确认，失败/中断须重放原轮次。反馈轮次仍受 maxTurns/任务/并发/截止时间限制；不要互发无信息确认形成循环。队列排空前会处理已到消息，但 drain 后的新消息不重启池。反馈不重开已完成工作项，也不授予文件写权限；需要修改时创建有资源归属的新工作。
reviewedAgent(prompt,{key,criteria,worker?,reviewer?,maxRounds?}) 组合实现→独立复核→反馈返工，只在复核通过后返回 {value,review,rounds}。criteria 必须是具体可验证的标准，最多16000字符；maxRounds 默认2、范围1–4，每轮2次 agent 调用。worker 支持 harness/model/reasoningEffort/workflowTool/member/output/schema/workspace；默认持久成员 <key>/worker。reviewer 支持 harness/model/reasoningEffort/workflowTool，每轮用独立上下文、JSON 输出 {ok:boolean,reason:string,evidence:string[]}，证据条数不设上限；通过必须有具体检查证据，格式错误或执行失败不会放行。候选结果和复核结论都以 inputs 引用传递，prompt 只内联摘要。达到轮数上限仍不通过或执行失败时默认返回 null（onError:"throw" 改为抛错）。key 最多80字符、不能以@开头，保留 key/work/轮数 与 key/review/轮数。重放复用既有调用，外部状态变化须更新输入或 key。它只校验 helper 返回值，不拦截任意 complete_work，也不提供 reviewer 文件沙箱；避免在复核通过前发布或提前标记工作已验收。
speculativeAgent(prompt,{key,gate,worker?,repair?,maxRounds?}) 让下游工作与耗时的独立 gate 同时开始，只在同一轮 gate 通过时返回 {value,gate,rounds}。gate 需 prompt（前提及要跑的检查），支持 harness/model/reasoningEffort/workflowTool，每轮独立上下文，输出与 reviewedAgent 复核相同的 JSON，格式错误或执行失败不会放行。worker 选项同 reviewedAgent，默认持久成员 <key>/worker，prompt 会注明推测执行：只做本地可回退的改动，gate 通过前不发布、push、合并或发外部消息。gate 不通过时 repair（需 prompt，支持 member/harness/model/reasoningEffort/workflowTool，默认成员 <key>/repairer，须与 worker 不同）带 gate 报告修复前提，与 worker 正在进行的一轮并行；该轮不能取消，结束后下一轮用新 gate 检查修复后的前提，并让 worker 按报告和修复返工。maxRounds 1–4，有 repair 默认2，否则默认1且不能大于1。worker 失败时取消仍在运行的 gate。保留 key/gate|work|repair|cancel/轮数；取消的 gate 重放时仍为取消，worker 失败后重试须换 key。只校验返回值，不是沙箱；推测改动放独立 workspace，返回后再集成或发布。
queue 默认为 default。enqueueWork({key,title,input,queue?,priority?,dependsOn?,resources?,maxAttempts?}) 的 priority 为 -100..100，越大越先领取；dependsOn 是已入队工作项的 key，全部成功才可领取。输入/依赖/路由在重放时不可变；资源键跨本 workflow 的所有队列互斥。consumeWork 增加 queue、maxConcurrent，每个池有独立 prompt/模型/成员和并发上限；成员只领取本池队列，根并发与预算仍生效。closeWorkQueue({key,queue?}) 分别关闭入口。
send/receive 可用 topic、correlationId 筛选；receive(member,{key,topic?,correlationId?,timeoutMs?}) 超时返回 []，不消费未匹配或迟到消息。waitFor({key,any:[{kind:"message",member,topic?,correlationId?},{kind:"work",itemId},{kind:"task",taskId},{kind:"timer",afterMs}]}) 返回 {index,kind,value}。最早就绪者胜出，同时间按数组顺序；只有选中的 mailbox 分支保留消息，下一轮成功才确认消费。定时器截止时刻和已选结果在重放时保留；原工作流 deadline 不延长。waitWork(itemId,{key}) 等单项终态，sleep(ms,{key}) 持久等待。等待不占 worker，不忙轮询。
startAgent(prompt,{key,harness?,model?,reasoningEffort?,output?,workflowTool?,workspace?,inputs?}) 返回独立任务句柄，不能带 member；joinTask(handle) 等结果，cancelTask(handle,{key}) 等目标及其子 worker 退出。raceTasks(handles,{key}) 返回 {index,value} 并取消/等待其它分支；是先终态者胜出，失败会抛错，不代表先成功者或自动质量判定。startAgent 的成功、失败和显式取消是持久结果；重放复用同一句柄，重试终态失败须换 key。暂停/重启导致的中断仍恢复原任务。普通 agent() 保持原重试语义。所有调用须 await，未结束的句柄必须 join 或 cancel 后才能返回。
并行改代码可显式 createWorkspace({key,base?}) 创建独立 Git worktree，base 为完整 commit ID，省略则固定当前 HEAD；要求干净仓库根目录和已授权 full 模式。agent/startAgent 的 workspace 为返回的 id；同一 member 不能换 workspace，同一目录不能并发任务或检查。worker 返回前提交修改。reviewedAgent 的 worker.workspace 自动 freeze→独立快照复核→approve，通过后额外返回 {change,approval}；复核不得修改快照。不支持 workspace 与 workflowTool 同用，consumer pool 暂不切换 workspace。
手动链路：freezeWorkspace({key,workspace}) 返回固定候选；createWorkspace({key,change:候选id}) 创建复核快照；startAgent 在快照中返回 JSON {ok:true,reason,evidence:[...]} 并 joinTask 后，approveChange({key,change,taskId}) 记录实际任务的通过结果。integrateChanges({key,approvals:[approval.id],base?,target?}) 返回 {workspace,status,headCommit,remaining,...}，只准备私有集成目录。status=conflict 时在该目录修复/提交并独立复核，再用新 key 将修复 approval 与 remaining 集成；不能直接 accept。checkWorkspace({key,workspace,commands:[{argv:[命令,参数],timeoutMs?}]}) 返回检查 id/passed；1–4条前台命令，单条100ms–30min，默认5min且不超过总截止时间。acceptIntegration({key,workspace,checks:检查id}) 仅在检查通过且版本未变时推进 workflow 私有分支；不会更新原 checkout 或远端。合入后由主会话按授权发布返回的 commit。cleanupWorkspace({key,workspace}) 只移除干净且无未集成修改的空闲目录。每 workflow 最多32个目录。重放使用原记录，外部依赖/环境变化须新 key 重检。异常退出后占用无法确认时保留目录并阻止复用，使用新目录从已冻结版本恢复。worktree 共用 Git 元数据，不是权限沙箱。`;


export const WORKFLOW_TOOL_INSTRUCTIONS = `工作流工具通过 shell 调用：node "$AGENT_WORKFLOW_CLI" workflow <operation> --input '<JSON>' --json，也可 --input-file <path>。环境里的 CLI 路径属于当前 bridge 版本。
工作流模式由 bridge 的 /workflow 命令路由决定，不根据自然语言或任务类型推断。仅 /workflow start 或 /workflow script 命令授权的启动轮可调用 run_script；内部完成事件只允许继续处理已绑定的工作流，不能新建。普通消息不进入工作流模式，也不会获得工作流调用凭据。
run_script 需要唯一 operationId；所有其他变更需要 workflowId、唯一 operationId、expectedStateVersion（从 status 返回）。冲突时重读 status，不自动重试不同内容。
操作：status；run_script(goal,script,plan,args?,name?,execution?,maxAgents?,maxConcurrent?,timeoutMs?)；replay_script(script?,plan?,args?,execution?)；read_artifact(ref)；read_checkpoint(member)；publish_artifact(kind=context|report,text)；ack_events(eventIds)；send_message(member,text,topic?,correlationId?)；enqueue_work(key,title,input,queue?,priority?,dependsOn?,resources?,maxAttempts?)；retry_work(itemId,additionalAttempts?)；close_work_queue(queue?)；work_status(itemId? 或 queue?,offset?,limit?)；cancel_task(taskId)；pause；resume；cancel；complete(reportRef,openIssues:[],verificationLimits)。
主 agent 沿用当前会话的 harness、model 和 reasoningEffort（飞书 /config run、/model、/effort 在开始前设置）。execution:{agentKind,model?,reasoningEffort?} 设置脚本 worker 默认值。agent(prompt,{key,member?,harness?,model?,reasoningEffort?,output?:"text"|"json",schema?,onError?:"null"|"throw",workflowTool?}) 可为每个 worker 覆盖 harness、模型和强度；同一 harness 可用不同模型。省略时使用对应目标的设置；跨 harness 不继承其它 harness 的模型。只接受当前已授权 profile，不接受其它 profile、凭据或环境变量。目标必须支持独立 final_text，模型必须由目标 harness/服务支持。
每个 agent 和 consumeWork 成员可独立设置 workflowTool:true，默认 false。不沿父层自动继承。仅显式开启的 worker 获得 run_workflow 工具，可编写完整子脚本并逐个控制下一层开关；不是主 agent 的操作。子调用先保存 checkpoint 并让出本轮，结果就绪后恢复原会话；只有整棵树最终结果唤醒主会话。并发、任务预算和截止时间受根约束，最多3层子 workflow、32个子运行。
plan 是给用户看的具体执行方案（最多 12000 字符），必须说明阶段、每个 worker 的 harness/模型/任务、依赖和分支条件；bridge 在启动 worker 前自动展示，用户用 /workflow plan 可复查，不需要额外审批。修改 script、args 或 execution 重放时必须同时更新 plan，避免显示旧方案。原始脚本和方案分别保存在 sourceRef、planRef 指向的产物中。
script 是支持顶层 await/return 的 JS 函数体，无 import/process/require/文件接口。args 是 JSON；agent 返回 Promise，key 必须唯一且稳定。parallel 接收函数数组；pipeline(items,...stages) 并行处理各元素并顺序经过 stages(value,index)。phase/log 接收文本。所有 agent 调用必须 await。worker 自身失败（执行失败、JSON/schema 不合格等）时 agent() 默认返回 null 并记入日志，结果须 .filter(Boolean) 或判空；需要失败即中止时传 onError:"throw"。参数错误、重复 key、预算/调用上限仍直接抛错。parallel/pipeline 不会整体失败：抛错的函数或阶段对应 null，pipeline 中该项跳过后续阶段；discuss 同样支持 onError。schema 传 JSON Schema（根须为 {type:"object",properties}，支持 type/properties/required/additionalProperties/items/enum/const/anyOf/min*/max*），隐含 output:"json"，bridge 校验，不合格时在同一会话追问最多两次。agent/startAgent 可传 inputs:[前序 agent key]（1–16 个，须是本次运行中已 await 成功的调用），worker 的 prompt 只带每个结果的 ref 和开头预览，全文由 worker 用 read_artifact 读取；大段材料用 inputs 传递，不要拼进 prompt。默认最多 32 次调用、4 个 worker；总时限由 workflow_timeout_minutes 配置（内置 480 分钟），不传 timeoutMs 即使用配置值，显式值只能缩短时限。示例：return await agent(args.task,{key:"review",harness:"pi",model:args.reviewModel});
带 member 的调用使用稳定成员名，必须逐轮 await，同一成员的 harness/模型绑定不可变。send(member,text,{key}) 和 receive(member,{key}) 是脚本内 Promise：receive 等待持久化 inbox，不占 worker 进程；收到的消息在下一轮成员成功提交时确认。成员必须先通过 agent 创建。普通一次性 agent 不保存成员状态。所有脚本 key 在本次运行内唯一。成员重放须保持历史轮次输入不变，改写历史请用新成员名。
脚本可 await enqueueWork({key,title,input,resources?,maxAttempts?}) 创建工作项，await workStatus({itemId?,offset?,limit?}) 查询。enqueue key/输入在重放时不变；同名复用原项。resources 是共享 worktree/文件的显式互斥键，同键工作项串行领取，不创建文件沙箱。持久成员用 CLI 主动 claim_work，工作进展属于工作项，接手者能恢复。原子认领、租约及提交版本由 bridge 管理；租约到期会取消所属轮次并回收任务。脚本应捕获成员失败，让仍成功的成员继续消费；不能在同一次脚本里用新 key 跳过失败成员的原轮次。工作项未完成时，脚本返回会失败；暂停后须显式 replay，重启时正在运行的会自动重放。
推荐 await consumeWork({key,members:[{name,harness?,model?,reasoningEffort?,workflowTool?}],prompt,maxTurns?}) 让 bridge 按队列调度。一个工作流最多16个命名队列/消费池，每池1–16名专用成员、合计最多32名成员，不能同时用 agent/receive 操作这些成员；定义和执行绑定在重放时不可变。无可领任务时持久等待，不占 worker 进程；新任务或回收的认领可触发新轮次，完成轮次复用原生会话。失败/取消的成员在本次运行停止，其余成员继续接管；显式重放才可重试其原轮次。maxTurns 默认不超过32，最多128，另受 maxAgents、总尝试次数和并发限制。consumeWork 必须 await；只有队列显式关闭、已有任务完成且成员退出后返回。任务失败、无进展或预算耗尽会报错供主会话处理。生产完毕调用 await closeWorkQueue({key})；并行生产时用 parallel 组织生产者和 consumeWork。主 CLI 可 close_work_queue，用户也可 /workflow enqueue <工作项JSON> 和 /workflow close。关闭后拒绝新项，重放仍可复用已入队项；暂停后入队或关闭不会自动恢复执行。空队列仍占一个有时限的脚本解释器，不占 worker。
普通 agent() 重放只复用 key/输入/执行绑定（包括模型）匹配的成功任务；外部状态变化应写入输入或换 key。未启用子 workflow 的一次性任务失败后重放用新会话；带 member 的任务保持成员身份和原生会话，重试原逻辑轮次。副作用不保证 exactly-once。暂停会取消在途 worker，resume 从头重放并复用完成结果。Bridge 重启时正在运行的根工作流会自动重放续跑，停机时间不计入截止时间；暂停的或无法自动续跑的保持中断，需 replay_script 或用户 /workflow resume。脚本结果是 workflow-result 产物，主 agent read_artifact、ack_events 后 complete；也可发布 report 后完成。
${WORKFLOW_SCHEDULING_INSTRUCTIONS}
run_script/replay_script 后结束 turn，子任务由 bridge 管理。仅在整体结束或失败时唤醒主会话。内部事件不是用户消息或原生问题答案。不要读取或展示环境中的调用凭据。worker 仅可执行原始需求授权的任务；主、子运行沿用已授权 profile，角色说明不代表工具沙箱隔离。`;

const WORKFLOW_MEMBER_INSTRUCTIONS = `你是 bridge 管理的持久工作流成员。遵守原始需求授权，只处理本轮输入，最终答复结束本轮并释放执行资源。角色说明不改变实际权限。不要发送外部消息或派生子 agent。
你可使用当前绑定的 CLI：node "$AGENT_WORKFLOW_CLI" workflow <operation> --input '<JSON>' --json（也可 --input-file）。不要读取调用凭据。
read_context 返回自己的 checkpoint 和本轮消息；task_status 返回当前 checkpointVersion。checkpoint({operationId,expectedCheckpointVersion,state}) 保存最多 16000 字符的 JSON 工作状态。请在完成重要步骤时保存进展、决定、下一步和产物引用；这不结束本轮，也不代表文件副作用可回滚。冲突时重新 read_context，不猜测版本。
send_message({operationId,member,text,topic?,correlationId?}) 向同一工作流已创建的成员发送最多 4000 字符的消息。operationId 在这个逻辑轮次内唯一，相同内容重试时复用。消息不代表收件方已经处理。
工作队列：claim_work({operationId,leaseMs?,queue?}) 原子领取一个工作项（每个成员最多一个），返回 claimId、generation、leaseUntil、item；没有可领项返回 null，应结束本轮，不忙等。消费池成员省略 queue 即使用池绑定，不能领取其它队列；手动成员默认领取 default。默认租约 120 秒，范围 1–300 秒。先读取 item.progress 核对已完成步骤；长任务及时 renew_claim({operationId,claimId,generation,leaseMs?})。checkpoint_work({operationId,claimId,generation,expectedProgressVersion,state}) 保存最多 16000 字符的 JSON 工作进展；complete_work({operationId,claimId,generation,result}) 提交 JSON 结果；fail_work({operationId,claimId,generation,error,retry?}) 报错；release_claim({operationId,claimId,generation,reason}) 交还工作。工作项 input/progress/result 各最多 16000 字符。work_status({itemId? 或 offset?,limit?}) 读取工作状态，默认每页 16 项、最多 64 项。队列变更 operationId 在当前执行 attempt 内唯一，同内容重试复用；恢复后的新 attempt 可重新领取，过期的旧 claimId/generation 不可提交。空 claim 的重试查询须用新 operationId。取消、退出或失去租约会回收未完成认领，保存的工作进展保留；外部副作用仍需核对和幂等处理。
脚本负责 receive 等待和下一轮调度。需要等待时，保存 checkpoint，再用最终答复说明等待原因；不要在 CLI 进程里轮询或睡眠。恢复时核对已经发生的副作用，接着保存的工作状态继续。`;

const NESTED_WORKFLOW_INSTRUCTIONS = `当前 agent 已显式启用子 workflow 工具，只在 Workflow 模式内有效。
可通过 node "$AGENT_WORKFLOW_CLI" workflow run_workflow --input '<JSON>' --json（或 --input-file）调用完整的子 workflow。
输入：{operationId,key,goal,script,plan,args?,name?,execution?,maxAgents?,maxConcurrent?,timeoutMs?,checkpoint?,parentQueue?}。key 在当前父任务内稳定且唯一；同一 key 的输入不可变，同内容重试复用 operationId。script 是支持顶层 await/return 的 JS 函数体，使用 agent、parallel、pipeline、enqueueWork、consumeWork、closeWorkQueue、send、receive 等现有脚本接口。plan 必须说明子运行的步骤和每个 worker 的 harness/模型、分工、依赖和分支。只做根需求授权范围内的工作。
script 无 import/process/require/文件接口，args 是 JSON。所有 Promise 必须 await：parallel([()=>agent(...),...])；pipeline(items,...stages) 对元素并行、阶段顺序执行；phase/log(text) 保存进展。agent 的 output 默认 text，可选 json 严格解析。send(member,text,{key})、receive(member,{key}) 通过已创建的持久成员传递消息。enqueueWork({key,title,input,resources?,maxAttempts?}) 入队；workStatus({itemId?,offset?,limit?}) 查询；consumeWork({key,members:[{name,harness?,model?,reasoningEffort?,workflowTool?}],prompt,maxTurns?}) 调度专用成员领取任务；closeWorkQueue({key}) 显式关闭后消费池才会排空返回。每层队列和成员独立，所有 key 稳定且唯一。
${WORKFLOW_SCHEDULING_INSTRUCTIONS}
子脚本 agent(prompt,{key,member?,harness?,model?,reasoningEffort?,output?,workflowTool?,inputs?}) 可逐个决定是否给下一层植入此工具；workflowTool 默认 false，必须显式 true 才开启，consumeWork 的每个 members 配置也支持。不能通过修改当前调用参数给自己提权，不接受其它 profile、凭据或环境变量。
run_workflow 首次返回 status=waiting 和 workflowId；这是持久异步调用，请立即结束当前轮次，不要等待 shell、不轮询、不继续执行其它工作。最多30秒后 bridge 会停止未让出的执行。checkpoint 可保存最多16000字符的当前工作状态，恢复时连同子结果交回。未完成工作认领在让出时释放，恢复后须重新核对并领取，不能继续使用旧 claim。
bridge 等本轮退出后执行子脚本；成功或失败结果都会在原生会话的下一次执行中注入 workflows.call（ok/result/resultRef 或 error），read_context 同样可读。结束本轮的文字不会成为父任务的最终结果；恢复后完成原任务并给出最终答复。相同 key 的已完成子调用返回保存的成功或失败结果，不重复执行；要重试失败子调用须用新 key 和 operationId。根工作流暂停后需显式重放；重启时正在运行的根工作流会自动重放。
整棵树共享根并发、任务和尝试预算及截止时间，最多3层子 workflow、32个子运行。各层拥有自己的工作队列；显式 parentQueue:true 只授予子脚本 enqueueWork({queue:"parent",key,title,input,...}) 向直接父队列追加任务的能力，也可 enqueueWork({target:"parent",queue:"reviews",...}) 选择父命名队列，不授予关闭父队列或消费父队列的权限。子运行不直接向用户发送消息，结果交回调用者。`;

/** Only WorkflowRuntime calls this. Ordinary agent entries never receive this capability or binding. */
export function workflowWorkerInstructions(task: WorkflowTask): string {
  const base = task.agentId ? WORKFLOW_MEMBER_INSTRUCTIONS
    : '你是 bridge 管理的脚本工作流子 agent。只完成指定任务，遵守原始需求的授权范围，不要自行发送消息或派生子 agent。用最终答复返回结果。角色提示不改变实际执行权限。';
  if (!task.workflowTool) return base;
  return base.replace('不要发送外部消息或派生子 agent。','不要发送外部消息。')
    .replace('不要自行发送消息或派生子 agent。','不要自行发送外部消息。')+'\n\n'+NESTED_WORKFLOW_INSTRUCTIONS;
}
