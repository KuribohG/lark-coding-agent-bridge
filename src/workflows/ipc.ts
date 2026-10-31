import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { WorkflowCaller } from './types';

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
      env: { LARK_WORKFLOW_ENDPOINT: this.endpoint, LARK_WORKFLOW_TOKEN: token,
        ...(this.cliPath ? { LARK_WORKFLOW_CLI: this.cliPath } : {}) },
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
  const endpoint = env.LARK_WORKFLOW_ENDPOINT;
  const token = env.LARK_WORKFLOW_TOKEN;
  if (!endpoint || !token) throw new Error('This command requires a bridge-managed workflow run');
  const url = new URL(endpoint);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/workflow' || url.username || url.password) throw new Error('Invalid local workflow endpoint');
  const response = await fetch(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args }) });
  const body = await response.json() as { ok: boolean; result?: unknown; error?: string };
  if (!body.ok) throw new Error(body.error ?? 'Workflow request failed');
  return body.result;
}

export const WORKFLOW_TOOL_INSTRUCTIONS = `工作流工具通过 shell 调用：node "$LARK_WORKFLOW_CLI" workflow <operation> --input '<JSON>' --json，也可 --input-file <path>。环境里的 CLI 路径属于当前 bridge 版本。
工作流模式由 bridge 的 /workflow 命令路由决定，不根据自然语言或任务类型推断。仅 /workflow start 或 /workflow script 命令授权的启动轮可调用 run_script；内部完成事件只允许继续处理已绑定的工作流，不能新建。普通消息不进入工作流模式，也不会获得工作流调用凭据。
run_script 需要唯一 operationId；所有其他变更需要 workflowId、唯一 operationId、expectedStateVersion（从 status 返回）。冲突时重读 status，不自动重试不同内容。
操作：status；run_script(goal,script,plan,args?,name?,execution?,maxAgents?,maxConcurrent?,timeoutMs?)；replay_script(script?,plan?,args?,execution?)；read_artifact(ref)；read_checkpoint(member)；publish_artifact(kind=context|report,text)；ack_events(eventIds)；send_message(member,text)；enqueue_work(key,title,input,resources?,maxAttempts?)；retry_work(itemId,additionalAttempts?)；close_work_queue；work_status(itemId? 或 offset?,limit?)；cancel_task(taskId)；pause；resume；cancel；complete(reportRef,openIssues:[],verificationLimits)。
主 agent 沿用当前会话的 harness、model 和 reasoningEffort（飞书 /config run、/model、/effort 在开始前设置）。execution:{agentKind,model?,reasoningEffort?} 设置脚本 worker 默认值。agent(prompt,{key,member?,harness?,model?,reasoningEffort?,output?:"text"|"json"}) 可为每个 worker 覆盖 harness、模型和强度；同一 harness 可用不同模型。省略时使用对应目标的设置；跨 harness 不继承其它 harness 的模型。只接受当前已授权 profile，不接受其它 profile、凭据或环境变量。目标必须支持独立 final_text，模型必须由目标 harness/服务支持。
plan 是给用户看的具体执行方案（最多 12000 字符），必须说明阶段、每个 worker 的 harness/模型/任务、依赖和分支条件；bridge 在启动 worker 前自动展示，用户用 /workflow plan 可复查，不需要额外审批。修改 script、args 或 execution 重放时必须同时更新 plan，避免显示旧方案。原始脚本和方案分别保存在 sourceRef、planRef 指向的产物中。
script 是支持顶层 await/return 的 JS 函数体，无 import/process/require/文件接口。args 是 JSON；agent 返回 Promise，key 必须唯一且稳定。parallel 接收函数数组；pipeline(items,...stages) 并行处理各元素并顺序经过 stages(value,index)。phase/log 接收文本。所有 agent 调用必须 await，失败会抛错，output=json 严格解析。默认最多 32 次调用、4 个 worker、30 分钟。示例：return await agent(args.task,{key:"review",harness:"pi",model:args.reviewModel});
带 member 的调用使用稳定成员名，必须逐轮 await，同一成员的 harness/模型绑定不可变。send(member,text,{key}) 和 receive(member,{key}) 是脚本内 Promise：receive 等待持久化 inbox，不占 worker 进程；收到的消息在下一轮成员成功提交时确认。成员必须先通过 agent 创建。普通一次性 agent 不保存成员状态。所有脚本 key 在本次运行内唯一。成员重放须保持历史轮次输入不变，改写历史请用新成员名。
脚本可 await enqueueWork({key,title,input,resources?,maxAttempts?}) 创建工作项，await workStatus({itemId?,offset?,limit?}) 查询。enqueue key/输入在重放时不变；同名复用原项。resources 是共享 worktree/文件的显式互斥键，同键工作项串行领取，不创建文件沙箱。持久成员用 CLI 主动 claim_work，工作进展属于工作项，接手者能恢复。原子认领、租约及提交版本由 bridge 管理；租约到期会取消所属轮次并回收任务。脚本应捕获成员失败，让仍成功的成员继续消费；不能在同一次脚本里用新 key 跳过失败成员的原轮次。工作项未完成时，脚本返回会失败；暂停/重启后仍须显式 replay。
推荐 await consumeWork({key,members:[{name,harness?,model?,reasoningEffort?}],prompt,maxTurns?}) 让 bridge 按队列调度。一个工作流最多一个消费池、1–16 名专用成员，不能同时用 agent/receive 操作这些成员；定义和执行绑定在重放时不可变。无可领任务时持久等待，不占 worker 进程；新任务或回收的认领可触发新轮次，完成轮次复用原生会话。失败/取消的成员在本次运行停止，其余成员继续接管；显式重放才可重试其原轮次。maxTurns 默认不超过32，最多128，另受 maxAgents、总尝试次数和并发限制。consumeWork 必须 await；只有队列显式关闭、已有任务完成且成员退出后返回。任务失败、无进展或预算耗尽会报错供主会话处理。生产完毕调用 await closeWorkQueue({key})；并行生产时用 parallel 组织生产者和 consumeWork。主 CLI 可 close_work_queue，用户也可 /workflow enqueue <工作项JSON> 和 /workflow close。关闭后拒绝新项，重放仍可复用已入队项；暂停/重启后入队或关闭不自动恢复。空队列仍占一个有时限的脚本解释器，不占 worker。
重放只复用 key/输入/执行绑定（包括模型）匹配的成功任务；外部状态变化应写入输入或换 key。一次性任务失败后重放用新会话；带 member 的任务保持成员身份和原生会话，重试原逻辑轮次。副作用不保证 exactly-once。暂停会取消在途 worker，resume 从头重放并复用完成结果；重启后仅可显式 replay_script，不自动恢复。脚本结果是 workflow-result 产物，主 agent read_artifact、ack_events 后 complete；也可发布 report 后完成。
run_script/replay_script 后结束 turn，子任务由 bridge 管理。仅在整体结束或失败时唤醒主会话。内部事件不是用户消息或原生问题答案。不要读取或展示环境中的调用凭据。worker 仅可执行原始需求授权的任务；主、子运行沿用已授权 profile，角色说明不代表工具沙箱隔离。`;

export const WORKFLOW_MEMBER_INSTRUCTIONS = `你是 bridge 管理的持久工作流成员。遵守原始需求授权，只处理本轮输入，最终答复结束本轮并释放执行资源。角色说明不改变实际权限。不要发送外部消息或派生子 agent。
你可使用当前绑定的 CLI：node "$LARK_WORKFLOW_CLI" workflow <operation> --input '<JSON>' --json（也可 --input-file）。不要读取调用凭据。
read_context 返回自己的 checkpoint 和本轮消息；task_status 返回当前 checkpointVersion。checkpoint({operationId,expectedCheckpointVersion,state}) 保存最多 16000 字符的 JSON 工作状态。请在完成重要步骤时保存进展、决定、下一步和产物引用；这不结束本轮，也不代表文件副作用可回滚。冲突时重新 read_context，不猜测版本。
send_message({operationId,member,text}) 向同一工作流已创建的成员发送最多 4000 字符的消息。operationId 在这个逻辑轮次内唯一，相同内容重试时复用。消息不代表收件方已经处理。
工作队列：claim_work({operationId,leaseMs?}) 原子领取一个工作项（每个成员最多一个），返回 claimId、generation、leaseUntil、item；没有可领项返回 null，应结束本轮，不忙等。默认租约 120 秒，范围 1–300 秒。先读取 item.progress 核对已完成步骤；长任务及时 renew_claim({operationId,claimId,generation,leaseMs?})。checkpoint_work({operationId,claimId,generation,expectedProgressVersion,state}) 保存最多 16000 字符的 JSON 工作进展；complete_work({operationId,claimId,generation,result}) 提交 JSON 结果；fail_work({operationId,claimId,generation,error,retry?}) 报错；release_claim({operationId,claimId,generation,reason}) 交还工作。工作项 input/progress/result 各最多 16000 字符。work_status({itemId? 或 offset?,limit?}) 读取工作状态，默认每页 16 项、最多 64 项。队列变更 operationId 在当前执行 attempt 内唯一，同内容重试复用；恢复后的新 attempt 可重新领取，过期的旧 claimId/generation 不可提交。空 claim 的重试查询须用新 operationId。取消、退出或失去租约会回收未完成认领，保存的工作进展保留；外部副作用仍需核对和幂等处理。
脚本负责 receive 等待和下一轮调度。需要等待时，保存 checkpoint，再用最终答复说明等待原因；不要在 CLI 进程里轮询或睡眠。恢复时核对已经发生的副作用，接着保存的工作状态继续。`;
