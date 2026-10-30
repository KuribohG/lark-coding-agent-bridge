import { sanitizeLogsForDoctor } from '../core/logger';
import type { DurableAgent, WorkflowState, WorkflowTask } from './types';

const TASK_STATUS: Record<WorkflowTask['status'], string> = {
  queued: '排队', starting: '启动中', running: '执行中', result_ready: '本轮已完成',
  waiting_input: '等待输入', failed: '失败', cancelling: '正在取消', cancelled: '已取消', interrupted: '已中断',
};
const ATTENTION = new Set<WorkflowTask['status']>(['failed', 'interrupted', 'waiting_input', 'running', 'starting', 'cancelling', 'queued']);
const compact = (value: string, limit: number) => {
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length > limit ? text.slice(0, limit - 1) + '…' : text;
};
const errorText = (error: string) => compact(sanitizeLogsForDoctor(error), 220);
const time = (timestamp: number) => new Date(timestamp).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
function bounded(lines: string[]): string {
  const result: string[] = [];
  let size = 0;
  for (const line of lines) {
    if (size + line.length > 7800) {
      result.push('…已省略其余条目。用 /workflow status <成员名> 查看单个成员。');
      break;
    }
    result.push(line);
    size += line.length + 1;
  }
  return result.join('\n');
}

function execution(state: WorkflowState, sessionRef: string): string {
  const session = state.sessions.find(item => item.sessionRef === sessionRef);
  const settings = session?.execution?.modelSettings;
  return `${session?.execution?.agentKind ?? state.root.agentKind}，模型：${compact(settings?.model ?? session?.observedModel ?? '默认', 100)}`
    + (settings?.reasoningEffort ? `，思考强度：${settings.reasoningEffort}` : '');
}

function currentTask(state: WorkflowState, member: DurableAgent): WorkflowTask | undefined {
  return state.tasks.find(task => task.taskId === (member.activeTurnId ?? member.lastTurnId));
}

function memberLines(state: WorkflowState, member: DurableAgent, detail: boolean): string[] {
  const task = currentTask(state, member);
  const receipt = state.mailbox?.receipts.find(item => item.id === member.wait?.receiptId);
  const checkpoint = state.checkpoints?.find(item => item.ref === member.checkpointRef);
  const phase = member.activeTurnId && task ? TASK_STATUS[task.status]
    : receipt?.status === 'waiting' ? '等待消息' : receipt?.status === 'ready' ? '消息已到，待开始下一轮'
      : task ? TASK_STATUS[task.status] : '尚未开始';
  const lines = [`- 成员 ${compact(member.key, 100)}：${phase}，${execution(state, member.sessionRef)}`];
  if (task) lines.push(`  任务：${compact(task.scriptKey ?? task.taskKey, 100)}，尝试 ${task.attempts.length} 次`);
  if (receipt && receipt.status !== 'consumed') {
    lines.push(`  收件批次：${compact(receipt.key, 100)}，${receipt.status === 'waiting' ? '等待消息到达' : `${receipt.messageIds.length} 条已保留，下一轮成功后确认消费`}`);
  }
  lines.push(checkpoint
    ? `  恢复点：#${checkpoint.version}，${time(checkpoint.createdAt)}（${checkpoint.resultRef ? '轮次完成' : '执行中保存'}）`
    : '  恢复点：尚未保存');
  if (task?.error) lines.push(`  原因：${errorText(task.error)}`);
  if (detail) {
    if (task) lines.push(`任务内容：${compact(task.objective, 600)}`);
    const pending = state.mailbox?.messages.filter(message => message.to === member.agentId && !message.consumedByTurnId).length ?? 0;
    lines.push(`未确认消费的消息：${pending}`);
    const turns = state.tasks.filter(item => item.agentId === member.agentId);
    lines.push(`最近轮次（${Math.min(turns.length, 6)}/${turns.length}）：`);
    for (const turn of turns.slice(-6)) lines.push(...taskLines(state, turn));
  }
  return lines;
}

function taskLines(state: WorkflowState, task: WorkflowTask): string[] {
  return [`- ${compact(task.scriptKey ?? task.taskKey, 100)}：${TASK_STATUS[task.status]}，尝试 ${task.attempts.length} 次，${execution(state, task.sessionRef)}`,
    ...(task.error ? [`  原因：${errorText(task.error)}`] : [])];
}

export function renderWorkflowStatus(state: WorkflowState, memberKey?: string, latest = false): string {
  const lines = [`${compact(state.script?.name ?? state.definition.id, 100)}：${state.status}${latest ? '（最近一次）' : ''}`,
    `需求：${compact(state.goal, 300)}`,
    `主 agent：${state.root.agentKind}，模型：${compact(state.root.modelSettings.model ?? '默认', 100)}${state.root.modelSettings.reasoningEffort ? `，思考强度：${state.root.modelSettings.reasoningEffort}` : ''}`];
  if (state.script) {
    lines.push(`脚本：${state.script.status}${state.script.phase ? `，${compact(state.script.phase, 200)}` : ''}，重放 ${state.script.revision} 次`);
    if (state.script.status === 'failed' && state.script.error) lines.push(`脚本失败：${errorText(state.script.error)}`);
  }
  if (state.status === 'paused' || state.status === 'interrupted') {
    lines.push('工作流未运行。排查后可用 /workflow resume 显式恢复；排队的消息不会自动恢复工作流。');
  } else if (state.status === 'binding_attention') {
    lines.push('执行绑定已变化，请核对主会话及执行配置；当前绑定不能继续执行。');
  } else if (state.script?.status === 'failed' && state.status === 'active') {
    lines.push('排查失败原因后，可用 /workflow resume 重放。');
  }
  if (memberKey) {
    const member = state.agents?.find(item => item.key === memberKey);
    if (!member) return bounded([...lines, `未找到成员：${compact(memberKey, 100)}。用 /workflow status 查看成员列表。`]);
    lines.push(...memberLines(state, member, true));
  } else {
    const members = [...state.agents ?? []].sort((a, b) =>
      Number(ATTENTION.has(currentTask(state, b)?.status ?? 'result_ready')) - Number(ATTENTION.has(currentTask(state, a)?.status ?? 'result_ready')));
    for (const member of members.slice(0, 8)) lines.push(...memberLines(state, member, false));
    if (members.length > 8) lines.push(`另有 ${members.length - 8} 个成员：${compact(members.slice(8).map(member => member.key).join('、'), 600)}。`);
    if (members.length) lines.push('用 /workflow status <成员名> 查看成员的任务内容、消息数量和最近轮次。');
    const tasks = state.tasks.filter(task => !task.agentId).sort((a, b) => Number(ATTENTION.has(b.status)) - Number(ATTENTION.has(a.status)));
    for (const task of tasks.slice(0, 12)) lines.push(...taskLines(state, task));
    if (tasks.length > 12) lines.push(`另有 ${tasks.length - 12} 个独立任务未展开。`);
  }
  lines.push(`轮次：${state.tasks.length}，已完成 ${state.tasks.filter(task => task.status === 'result_ready').length}，失败 ${state.tasks.filter(task => task.status === 'failed').length}`,
    `待处理事件：${state.events.filter(event => !event.acknowledged).length}`);
  return bounded(lines);
}
