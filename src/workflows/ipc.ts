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
只在用户要求多 agent 架构设计时 start；pluginId=architecture-review，goal 为完整需求契约。start 需要 operationId；所有其他变更需要 workflowId、唯一 operationId、expectedStateVersion（从 status 返回）。冲突时重读 status，不自动重试不同内容。
操作：status；start；delegate(role,actorKey,taskKey,objective,inputRefs,execution?)；send(taskId,inputId,text，仅空闲子会话)；read_artifact(ref)；publish_artifact(kind=context|architecture-decision,text)；ack_events(eventIds)；begin_revision_round；cancel_task(taskId)；pause；resume；cancel；complete(reportRef,openIssues:[],verificationLimits)。
delegate 可用 execution:{agentKind,model?,reasoningEffort?} 为 worker 选择 harness；省略时继承主会话。仅限当前已授权 profile，不接受其它 profile、凭据或环境变量。跨 harness 不继承主会话模型；指定目标支持的 model 可固定模型。send 始终沿用已绑定 harness 和原生会话。当前后端必须支持独立 final_text；角色说明不改变权限。
delegate 后结束 turn，子任务由 bridge 管理。内部事件是子任务通知，不是用户消息，不是原生问题答案。不要读取或展示环境中的调用凭据。
P0 只提供文本产物，未实现受控测试、需求版本修订或重启恢复。主、子运行沿用已授权 profile；角色只读说明不代表工具沙箱隔离。`;
