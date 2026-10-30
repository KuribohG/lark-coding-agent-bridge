import { randomUUID } from 'node:crypto';
import type { WorkflowKernel } from './kernel';

const WORKFLOW_HELP = [
  'Workflow 命令',
  '',
  '- `/workflow help` — 查看帮助。',
  '- `/workflow start <任务>` — 启动工作流，可在任务中指定各子 agent 的执行器、模型和思考强度。',
  '- `/workflow script <任务>` — `start` 的别名。',
  '- `/workflow plan` — 查看执行方案；结束后可查看最近一次方案。',
  '- `/workflow status` 或 `/workflow` — 查看当前工作流的状态、模型和进度。',
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
  if (!['plan', 'status', 'pause', 'resume', 'cancel'].includes(operation)) return '未知的工作流子命令。发送 /workflow help 查看用法。';
  if (operation === 'cancel') return kernel.cancel(scope) ? '已请求取消当前工作流。' : '当前没有工作流。';
  const state = kernel.state(scope) ?? (operation === 'plan' ? kernel.latest(scope) : undefined);
  if (!state) return '当前没有工作流。';
  if (operation === 'plan') return state.script ? kernel.plan(scope, state.workflowId) : '旧版工作流没有保存脚本执行方案。';
  await kernel.call({ kind: 'main', scopeId: scope }, operation,
    { workflowId: state.workflowId, operationId: randomUUID(), expectedStateVersion: state.stateVersion });
  if (operation === 'pause') return '已暂停工作流并请求取消在途任务；恢复时复用已完成结果。';
  if (operation === 'resume') return '已恢复工作流，正在从已完成结果重放。';
  return [`${state.script?.name ?? state.definition.id}：${state.status}`, `需求：${state.goal}`,
    `主 agent：${state.root.agentKind}，模型：${state.root.modelSettings.model ?? '默认'}${state.root.modelSettings.reasoningEffort ? `，思考强度：${state.root.modelSettings.reasoningEffort}` : ''}`,
    ...(state.script ? [`脚本：${state.script.status}${state.script.phase ? `，${state.script.phase}` : ''}，重放 ${state.script.revision} 次`] : []),
    ...(state.agents ?? []).map(agent => {
      const receipt = state.mailbox?.receipts.find(item => item.id === agent.wait?.receiptId);
      const phase = agent.activeTurnId ? '轮次未完成' : receipt?.status === 'waiting' ? '等待消息' : receipt?.status === 'ready' ? '消息已到' : '空闲';
      return `- 成员 ${agent.key}：${phase}，恢复点 ${agent.checkpointVersion}`;
    }),
    ...state.tasks.map(task => {
      const session = state.sessions.find(item => item.sessionRef === task.sessionRef)!;
      const settings = session.execution?.modelSettings;
      const model = settings?.model ?? session.observedModel ?? '默认';
      return `- ${task.scriptKey ?? session.role}：${task.status}，${session.execution?.agentKind ?? state.root.agentKind}，模型：${model}${settings?.reasoningEffort ? `，思考强度：${settings.reasoningEffort}` : ''}`;
    }), `待处理事件：${state.events.filter(event => !event.acknowledged).length}`].join('\n');
}
