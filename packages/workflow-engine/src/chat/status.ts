import { consumerPools, memberPool, queueControl, queueNames } from '../engine/work-routing';
import type { DurableAgent, WorkflowState, WorkflowTask, WorkflowWorkItem } from '../engine/types';

const TASK_STATUS: Record<WorkflowTask['status'], string> = {
  queued: '排队', starting: '启动中', running: '执行中', result_ready: '本轮已完成',
  waiting_input: '等待输入', waiting_workflow:'等待子 workflow', failed: '失败', cancelling: '正在取消', cancelled: '已取消', interrupted: '已中断',
};
const ATTENTION = new Set<WorkflowTask['status']>(['failed', 'interrupted', 'waiting_input', 'waiting_workflow', 'running', 'starting', 'cancelling', 'queued']);
const compact = (value: string, limit: number) => {
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length > limit ? text.slice(0, limit - 1) + '…' : text;
};
const errorText = (error: string) => compact(error, 220);
const duration = (ms: number) => ms < 60_000 ? `${Math.max(0, Math.round(ms / 1000))} 秒` : ms < 3_600_000 ? `${Math.round(ms / 60_000)} 分钟` : `${(ms / 3_600_000).toFixed(1)} 小时`;
/** A started attempt without host admission is queued for an execution slot, not starting. */
const taskStatus = (task: WorkflowTask) => task.status === 'starting' && !task.attempts.at(-1)?.admittedAt ? '等待执行槽位' : TASK_STATUS[task.status];
function attemptTiming(task: WorkflowTask, now: number): string | undefined {
  const attempt = task.attempts.at(-1);
  if (!attempt || !['starting', 'running'].includes(task.status) && attempt.endedAt === undefined) return undefined;
  const end = attempt.endedAt ?? now;
  if (!attempt.admittedAt) return attempt.endedAt === undefined ? `  耗时：已等待执行槽位 ${duration(end - attempt.startedAt)}` : undefined;
  const queued = attempt.admittedAt - attempt.startedAt;
  return `  耗时：${queued >= 1000 ? `等待执行槽位 ${duration(queued)}，` : ''}${attempt.endedAt === undefined ? '已执行' : '执行'} ${duration(end - attempt.admittedAt)}`;
}
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

function memberLines(state: WorkflowState, member: DurableAgent, detail: boolean, now: number): string[] {
  const task = currentTask(state, member);
  const receipt = state.mailbox?.receipts.find(item => item.id === member.wait?.receiptId);
  const checkpoint = state.checkpoints?.find(item => item.ref === member.checkpointRef);
  const pool = memberPool(state, member.key);
  const phase = member.activeTurnId && task ? taskStatus(task)
    : pool?.status === 'waiting' ? '等待队列任务（不占 worker 进程）'
    : member.wait?.kind === 'event' ? '等待消息或其它事件（不占 worker 进程）'
    : receipt?.status === 'waiting' ? '等待消息' : receipt?.status === 'ready' ? '消息已到，待开始下一轮'
      : task ? taskStatus(task) : '尚未开始';
  const lines = [`- 成员 ${compact(member.key, 100)}：${phase}，${execution(state, member.sessionRef)}`];
  if (task) lines.push(`  任务：${compact(task.scriptKey ?? task.taskKey, 100)}，尝试 ${task.attempts.length} 次`);
  const timing = task && member.activeTurnId ? attemptTiming(task, now) : undefined;
  if (timing) lines.push(timing);
  if (task?.waitingWorkflowId) lines.push(`  子 workflow：${task.waitingWorkflowId}（等待结果，不占 worker 进程）`);
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
    for (const turn of turns.slice(-6)) lines.push(...taskLines(state, turn, now));
  }
  return lines;
}

function taskLines(state: WorkflowState, task: WorkflowTask, now: number): string[] {
  const timing = attemptTiming(task, now);
  return [`- ${compact(task.scriptKey ?? task.taskKey, 100)}：${taskStatus(task)}，尝试 ${task.attempts.length} 次，${execution(state, task.sessionRef)}`,
    ...(timing ? [timing] : []),
    ...(task.workflowTool ? [`  子 workflow 工具：已启用${task.waitingWorkflowId ? `，等待 ${task.waitingWorkflowId}（不占 worker 进程）` : ''}`] : []),
    ...(task.error ? [`  原因：${errorText(task.error)}`] : [])];
}

function workLines(state: WorkflowState, item: WorkflowWorkItem): string[] {
  const claim = state.workQueue?.claims.find(claim => claim.id === item.claimId);
  const owner = claim && state.agents?.find(agent => agent.agentId === claim.agentId)?.key;
  return [`- 工作项 ${compact(item.key, 100)}：${item.status}，认领 ${item.generation}/${item.maxAttempts} 次，进展 #${item.progress.version}`,
    `  内容：${compact(item.title, 200)}`,
    ...(item.queue || item.priority || item.dependsOn?.length ? [`  队列：${compact(item.queue ?? 'default', 64)}，优先级 ${item.priority ?? 0}，依赖 ${compact(item.dependsOn?.join('、') || '无', 240)}`] : []),
    ...(claim ? [`  负责成员：${compact(owner ?? claim.agentId, 100)}，认领版本 ${claim.generation}，租约至 ${time(claim.leaseUntil)}`] : []),
    ...(item.progress.updatedAt ? [`  进展保存于：${time(item.progress.updatedAt)}`] : []),
    ...(item.resources.length ? [`  资源归属：${compact(item.resources.join('、'), 240)}`] : []),
    ...(item.error ? [`  原因：${errorText(item.error)}`] : [])];
}

function queueLines(state: WorkflowState, limit: number, member?: DurableAgent): string[] {
  const items = state.workQueue?.items ?? [];
  if (!state.workQueue) return [];
  const counts = (status: WorkflowWorkItem['status']) => items.filter(item => item.status === status).length;
  const lines = [`工作队列：${items.length} 项，待领取 ${counts('pending')}，已认领 ${counts('claimed')}，完成 ${counts('completed')}，失败 ${counts('failed')}，取消 ${counts('cancelled')}`];
  lines.push(state.workQueue.closedAt === undefined ? '默认队列开放：可继续追加任务。' : '默认队列已关闭：不再接收新任务，已有任务继续排空。');
  for (const name of queueNames(state).filter(name => name !== 'default')) {
    lines.push(`队列 ${compact(name, 64)}：${queueControl(state, name)?.closedAt === undefined ? '开放' : '已关闭'}`);
  }
  for (const pool of consumerPools(state)) {
    const names = {waiting:'等待队列变化（不占 worker 进程）',running:'消费中',drained:'已排空',failed:'需要处理',suspended:'已暂停',cancelled:'已取消'};
    lines.push(`消费者池 ${compact(pool.key, 100)}：${names[pool.status]}，队列 ${compact(pool.queue ?? 'default', 64)}，轮次 ${pool.turns.length}/${pool.maxTurns}`);
    if (pool.reason) lines.push(`  状态说明：${errorText(pool.reason)}`);
    lines.push(`  成员：${pool.members.slice(0, 8).map(consumer => compact(consumer.name, 50) + (consumer.disabled ? '（停止，需显式重放）' : consumer.retryPending ? '（待恢复）' : '')).join('、')}`);
  }
  const order = { claimed: 0, failed: 1, pending: 2, completed: 3, cancelled: 4 };
  const selected = items.filter(item => !member || state.workQueue?.claims.some(claim => claim.id === item.claimId && claim.agentId === member.agentId))
    .sort((a, b) => order[a.status] - order[b.status]);
  for (const item of selected.slice(0, limit)) lines.push(...workLines(state, item));
  if (selected.length > limit) lines.push(`另有 ${selected.length - limit} 项未展开。`);
  lines.push('用 /workflow work <工作项 key> 查看某项的认领、资源归属和进展版本。');
  return lines;
}

function pendingEvents(state: WorkflowState, now: number): string {
  const pending = state.events.filter(event => !event.acknowledged);
  const oldest = Math.min(...pending.map(event => event.createdAt ?? now));
  return `待处理事件：${pending.length}${pending.length && now - oldest >= 60_000 ? `，最早一条已等待 ${duration(now - oldest)}` : ''}`;
}

/** The board feed for chat: the latest posts, a chosen number of them, or those from or to one member. */
export function renderBoard(state: WorkflowState, filter?: string): string {
  const posts = state.board?.posts ?? [];
  if (!posts.length) return '这个工作流的留言板还没有帖子。';
  const name = (agentId: string) => state.agents?.find(member => member.agentId === agentId)?.key ?? agentId;
  const member = filter && !/^\d+$/.test(filter) ? state.agents?.find(item => item.key === filter.replace(/^@/, '')) : undefined;
  if (filter && !/^\d+$/.test(filter) && !member) return `未找到成员：${compact(filter, 100)}。用 /workflow status 查看成员列表。`;
  const matching = member ? posts.filter(post => post.from === member.agentId || post.to.includes(member.agentId)) : posts;
  const shown = matching.slice(-(filter && !member ? Math.min(30, Math.max(1, Number(filter))) : 10));
  const lines = [`留言板：共 ${posts.length} 帖${member ? `，与 ${compact(member.key, 100)} 相关 ${matching.length} 帖` : ''}，显示最近 ${shown.length} 帖。`];
  for (const post of shown) {
    const to = post.all ? '全体' : post.to.length ? post.to.map(id => '@' + compact(name(id), 50)).join(' ') : '未点名';
    lines.push(`#${post.seq} ${post.from ? compact(name(post.from), 50) : post.author === 'script' ? '脚本' : '主会话'} → ${to} · ${time(post.createdAt)}`, '  ' + compact(post.text, 600));
  }
  return bounded(lines);
}

export function renderWorkStatus(state: WorkflowState, key?: string): string {
  if (!state.workQueue) return '这个工作流还没有工作项。';
  if (!key) return bounded(queueLines(state, 12));
  const item = state.workQueue.items.find(item => item.key === key);
  if (!item) return `未找到工作项：${compact(key, 100)}`;
  const history = state.workQueue.claims.filter(claim => claim.itemId === item.id);
  return bounded([...workLines(state, item), '最近认领：', ...history.slice(-6).map(claim =>
    `- 版本 ${claim.generation}：${claim.status}，成员 ${compact(state.agents?.find(member => member.agentId === claim.agentId)?.key ?? claim.agentId, 100)}${claim.reason ? `，${errorText(claim.reason)}` : ''}`)]);
}

/** Slot queueing across all attempts; the wait happens in the host process pool, outside engine concurrency. */
function slotLines(state: WorkflowState, now: number): string[] {
  const attempts = state.tasks.flatMap(task => task.attempts.map(attempt => ({ task, attempt })));
  const waiting = attempts.filter(({ task, attempt }) => task.status === 'starting' && task.attempts.at(-1) === attempt && !attempt.admittedAt);
  const waits = attempts.map(({ attempt }) => attempt.admittedAt ? attempt.admittedAt - attempt.startedAt : undefined)
    .filter((wait): wait is number => wait !== undefined);
  const total = waits.reduce((sum, wait) => sum + wait, 0) + waiting.reduce((sum, { attempt }) => sum + now - attempt.startedAt, 0);
  if (!waiting.length && total < 60_000) return [];
  return [`执行槽位：${waiting.length} 个任务等待中，累计等待 ${duration(total)}${waits.length ? `，单次最长 ${duration(Math.max(...waits))}` : ''}`];
}

export interface WorkflowProgress {
  title: string;
  status: string;
  tone: 'running' | 'attention' | 'failed' | 'done' | 'cancelled';
  /** The workflow can no longer change; hosts stop following it. */
  settled: boolean;
  markdown: string;
}

const ACTIVE_TASKS = new Set<WorkflowTask['status']>(['running', 'starting', 'waiting_input', 'waiting_workflow', 'cancelling', 'queued']);
/** Progress text is interpolated into host markdown; keep names and logs from opening tags. */
const plain = (value: string, limit: number) => compact(value, limit).replace(/</g, '&lt;').replace(/>/g, '&gt;');

function progressStatus(state: WorkflowState, now: number): Pick<WorkflowProgress, 'status' | 'tone'> {
  if (state.status === 'completed') return { status: '已完成', tone: 'done' };
  if (state.status === 'cancelled') return { status: '已取消', tone: 'cancelled' };
  if (state.status === 'binding_attention') return { status: '执行绑定已变化', tone: 'failed' };
  if (state.status === 'paused') return { status: '已暂停', tone: 'attention' };
  if (state.status === 'interrupted') return { status: '已中断', tone: 'attention' };
  if (state.script?.status === 'failed') return { status: '脚本失败', tone: 'failed' };
  if (now >= state.deadlineAt) return { status: '已到截止时间', tone: 'attention' };
  if (state.script?.status === 'result_ready') return { status: '脚本已完成，主 agent 汇总中', tone: 'running' };
  return { status: state.script?.status === 'queued' ? '等待启动' : '运行中', tone: 'running' };
}

/** A bounded, self-updating summary for a progress card; /workflow status keeps the full diagnostics. */
export function renderWorkflowProgress(state: WorkflowState, now = Date.now()): WorkflowProgress {
  const { status, tone } = progressStatus(state, now);
  const label = (task: WorkflowTask) => plain(state.agents?.find(member => member.agentId === task.agentId)?.key ?? task.scriptKey ?? task.taskKey, 80);
  const count = (statuses: Array<WorkflowTask['status']>) => state.tasks.filter(task => statuses.includes(task.status)).length;
  const slotWaiting = state.tasks.filter(task => task.status === 'starting' && !task.attempts.at(-1)?.admittedAt).length;
  const settled = state.status === 'completed' || state.status === 'cancelled';
  // The status itself is a separate field for the host's title.
  const lines = [...state.script?.phase ? [`**阶段**：${plain(state.script.phase, 200)}`] : [],
    `**需求**：${plain(state.goal, 200)}`,
    `**轮次**：共 ${state.tasks.length}，完成 ${count(['result_ready'])}，执行中 ${count(['running', 'starting']) - slotWaiting}`
      + `${slotWaiting ? `，等待执行槽位 ${slotWaiting}` : ''}，排队 ${count(['queued'])}，失败 ${count(['failed'])}`];
  // Only running workflows show clocks, so periodic refreshes leave a stopped card unchanged.
  if (tone === 'running' || settled) lines.push(`**已用时**：${duration(now - state.createdAt)}${tone === 'running' ? `，距截止 ${duration(state.deadlineAt - now)}` : ''}`);
  const items = state.workQueue?.items;
  if (items?.length) {
    const done = items.filter(item => item.status === 'completed').length;
    lines.push(`**工作队列**：${done}/${items.length} 完成，已认领 ${items.filter(item => item.status === 'claimed').length}，失败 ${items.filter(item => item.status === 'failed').length}`);
  }
  const latest = state.board?.posts.at(-1);
  if (latest) {
    lines.push(`**留言板**：${state.board!.posts.length} 帖，最新 #${latest.seq} ${latest.from ? plain(state.agents?.find(member => member.agentId === latest.from)?.key ?? latest.from, 50) : latest.author === 'script' ? '脚本' : '主会话'}：${plain(latest.text.replace(/\s+/g, ' '), 120)}`);
  }
  const active = state.tasks.filter(task => ACTIVE_TASKS.has(task.status));
  if (active.length) {
    lines.push('', '**进行中**');
    for (const task of active.slice(0, 8)) {
      const timing = tone === 'running' ? attemptTiming(task, now)?.replace(/^\s*耗时：/, '') : undefined;
      lines.push(`- ${label(task)}：${timing?.startsWith('已等待执行槽位') ? timing.slice(1) : `${taskStatus(task)}${timing ? `，${timing}` : ''}`}`);
    }
    if (active.length > 8) lines.push(`- 另有 ${active.length - 8} 项`);
  }
  const failed = state.tasks.filter(task => task.status === 'failed');
  if (failed.length) {
    lines.push('', '**失败**');
    for (const task of failed.slice(-3)) lines.push(`- ${label(task)}${task.error ? `：${plain(task.error, 160)}` : ''}`);
  }
  if (state.script?.status === 'failed' && state.script.error) lines.push('', `**脚本错误**：${plain(state.script.error, 300)}`);
  const logs = state.script?.logs.slice(-3) ?? [];
  if (logs.length) lines.push('', '**最近日志**', ...logs.map(text => `- ${plain(text, 200)}`));
  return { title: compact(state.script?.name ?? state.definition.id, 100), status, tone, settled, markdown: lines.join('\n') };
}

export function renderWorkflowStatus(state: WorkflowState, memberKey?: string, latest = false, now = Date.now()): string {
  const lines = [`${compact(state.script?.name ?? state.definition.id, 100)}：${state.status}${latest ? '（最近一次）' : ''}`,
    `需求：${compact(state.goal, 300)}`,
    `主 agent：${state.root.agentKind}，模型：${compact(state.root.modelSettings.model ?? '默认', 100)}${state.root.modelSettings.reasoningEffort ? `，思考强度：${state.root.modelSettings.reasoningEffort}` : ''}`];
  if (state.script) {
    lines.push(`脚本：${state.script.status}${state.script.phase ? `，${compact(state.script.phase, 200)}` : ''}，重放 ${state.script.revision} 次`);
    for (const wait of (state.waits ?? []).filter(wait => wait.runId === state.script!.runId && wait.status === 'waiting').slice(0, 4)) {
      lines.push(`等待 ${compact(wait.key, 100)}：${wait.any.map(arm => arm.kind).join(' / ')}（不占 worker 进程）`);
    }
    if (state.script.status === 'failed' && state.script.error) lines.push(`脚本失败：${errorText(state.script.error)}`);
  }
  // Interrupted time is credited back on replay, so only paused or failed runs can be stuck past the deadline.
  const expired = state.status !== 'interrupted' && now >= state.deadlineAt;
  if (expired && (state.status === 'paused' || (state.status === 'active' && state.script?.status === 'failed'))) {
    lines.push('已到截止时间，无法恢复或重放；可用 /workflow cancel 释放当前话题后重新 start。');
  } else if (state.status === 'paused' || state.status === 'interrupted') {
    lines.push('工作流未运行。排查后可用 /workflow resume 显式恢复；排队的消息不会自动恢复工作流。');
  } else if (state.status === 'binding_attention') {
    lines.push('执行绑定已变化，请核对主会话及执行配置；当前绑定不能继续执行。');
  } else if (state.script?.status === 'failed' && state.status === 'active') {
    lines.push('排查失败原因后，可用 /workflow resume 重放。');
  }
  if (memberKey) {
    const member = state.agents?.find(item => item.key === memberKey);
    if (!member && memberPool(state, memberKey)) return bounded([...lines, ...queueLines(state, 0), `成员 ${compact(memberKey, 100)} 等待首次队列任务，尚未启动 worker。`]);
    if (!member) return bounded([...lines, `未找到成员：${compact(memberKey, 100)}。用 /workflow status 查看成员列表。`]);
    lines.push(...memberLines(state, member, true, now));
    lines.push(...queueLines(state, 1, member));
  } else {
    lines.push(...queueLines(state, 5));
    const members = [...state.agents ?? []].sort((a, b) =>
      Number(ATTENTION.has(currentTask(state, b)?.status ?? 'result_ready')) - Number(ATTENTION.has(currentTask(state, a)?.status ?? 'result_ready')));
    for (const member of members.slice(0, 8)) lines.push(...memberLines(state, member, false, now));
    if (members.length > 8) lines.push(`另有 ${members.length - 8} 个成员：${compact(members.slice(8).map(member => member.key).join('、'), 600)}。`);
    if (members.length) lines.push('用 /workflow status <成员名> 查看成员的任务内容、消息数量和最近轮次。');
    const tasks = state.tasks.filter(task => !task.agentId).sort((a, b) => Number(ATTENTION.has(b.status)) - Number(ATTENTION.has(a.status)));
    for (const task of tasks.slice(0, 12)) lines.push(...taskLines(state, task, now));
    if (tasks.length > 12) lines.push(`另有 ${tasks.length - 12} 个独立任务未展开。`);
  }
  lines.push(`轮次：${state.tasks.length}，已完成 ${state.tasks.filter(task => task.status === 'result_ready').length}，失败 ${state.tasks.filter(task => task.status === 'failed').length}`,
    ...slotLines(state, now), pendingEvents(state, now));
  return bounded(lines);
}
