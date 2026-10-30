import { randomUUID } from 'node:crypto';
import type { WorkflowKernel } from './kernel';
import { renderWorkflowStatus, renderWorkStatus } from './status';

const WORKFLOW_HELP = [
  'Workflow 命令',
  '',
  '- `/workflow help` — 查看帮助。',
  '- `/workflow start <任务>` — 启动工作流，可在任务中指定各子 agent 的执行器、模型和思考强度。',
  '- `/workflow script <任务>` — `start` 的别名。',
  '- `/workflow plan` — 查看执行方案；结束后可查看最近一次方案。',
  '- `/workflow status [成员名]` 或 `/workflow` — 查看状态、恢复点和失败原因；结束后显示最近一次。',
  '- `/workflow work [工作项 key]` — 查看工作队列、认领、资源归属和进展版本。',
  '- `/workflow pause` — 暂停工作流并取消正在执行的子任务。',
  '- `/workflow resume` — 恢复已暂停的工作流，复用已完成结果。',
  '- `/workflow cancel` — 取消当前工作流。',
  '',
  '示例：`/workflow start 让两个子 agent 分别分析方案 A 和 B，再汇总差异。`',
  '',
  '启动前可用 `/config run`、`/model`、`/effort` 设置主 agent。执行方案会在子任务启动前展示。',
  '只有 `start` 或 `script` 命令会启动工作流；普通消息不会自动启用。',
].join('\n');

/** Lark command presentation; submit schedules a normal main-agent turn. */
export async function handleWorkflowCommand(kernel: WorkflowKernel, scope: string, args: string,
  submit: (content: string) => string | undefined): Promise<string | undefined> {
  const operation = args.trim().split(/\s+/)[0] || 'status';
  if (operation === 'help') return WORKFLOW_HELP;
  const goal = args.trim().slice(operation.length).trim();
  if (operation === 'start' || operation === 'script') {
    if (!goal) return '用法：/workflow start <任务及各 worker 的 harness、模型要求>';
    if (kernel.state(scope)) return '当前话题已绑定工作流，请先完成或取消。';
    return submit(`请编写并运行脚本工作流（run_script）完成以下需求。先编写具体执行方案（plan），说明阶段、各 worker 的 harness/模型/任务、依赖关系及条件分支；bridge 会在执行前向用户展示。遵守用户指定的各 worker 的 harness、model 和 reasoningEffort；主 agent 沿用当前会话的执行器与模型设置：\n${goal}`);
  }
  if (!['plan', 'status', 'work', 'pause', 'resume', 'cancel'].includes(operation)) return '未知的工作流子命令。发送 /workflow help 查看用法。';
  if (operation === 'cancel') return kernel.cancel(scope) ? '已请求取消当前工作流。' : '当前没有工作流。';
  const current = kernel.state(scope);
  const state = current ?? (['plan', 'status', 'work'].includes(operation) ? kernel.latest(scope) : undefined);
  if (!state) return '当前没有工作流。';
  if (operation === 'plan') return state.script ? kernel.plan(scope, state.workflowId) : '旧版工作流没有保存脚本执行方案。';
  if (operation === 'status') return renderWorkflowStatus(state, goal || undefined, !current);
  if (operation === 'work') return renderWorkStatus(state, goal || undefined);
  await kernel.call({ kind: 'main', scopeId: scope }, operation,
    { workflowId: state.workflowId, operationId: randomUUID(), expectedStateVersion: state.stateVersion });
  if (operation === 'pause') return '已暂停工作流并请求取消在途任务；恢复时复用已完成结果。';
  if (operation === 'resume') return '已恢复工作流，正在从已完成结果重放。';
}
