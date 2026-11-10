import type { AgentEvent, AgentTaskKind, AgentTaskMember, AgentTaskState } from '../types';

type RawEvent = Record<string, unknown>;
type TaskEvent = Extract<AgentEvent, { type: 'task' }>;

const object = (value: unknown): RawEvent => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RawEvent : {};
const text = (value: unknown, limit: number): string | undefined => {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const trimmed = value.trim();
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}…` : trimmed;
};
const count = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;

/** Claude Code's task types, grouped by what a host shows: a workflow, a subagent, a shell command or anything else. */
function kindOf(type: unknown): AgentTaskKind | undefined {
  if (typeof type !== 'string') return undefined;
  if (type === 'local_workflow') return 'workflow';
  if (/agent|teammate/.test(type)) return 'agent';
  if (type === 'local_bash') return 'shell';
  return 'other';
}

function stateOf(status: unknown): AgentTaskState | undefined {
  switch (status) {
    case 'pending':
    case 'running': return 'running';
    case 'paused': return 'paused';
    case 'completed': return 'completed';
    case 'failed': return 'failed';
    case 'killed':
    case 'stopped':
    case 'cancelled': return 'stopped';
    default: return undefined;
  }
}

/** Workflow members as Claude Code reports their progress; other progress entries are not members. */
function membersOf(value: unknown): AgentTaskMember[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const members: AgentTaskMember[] = [];
  for (const raw of value) {
    const entry = object(raw);
    if (entry.type !== 'workflow_agent' || typeof entry.index !== 'number') continue;
    const member: AgentTaskMember = { index: entry.index };
    const label = text(entry.label, 120); if (label) member.label = label;
    if (typeof entry.phaseIndex === 'number') member.phaseIndex = entry.phaseIndex;
    const phase = text(entry.phaseTitle, 120); if (phase) member.phase = phase;
    const state = text(entry.state, 40); if (state) member.state = state;
    const agentId = text(entry.agentId, 80); if (agentId) member.agentId = agentId;
    const model = text(entry.model, 80); if (model) member.model = model;
    const prompt = text(entry.promptPreview, 300); if (prompt) member.prompt = prompt;
    const result = text(entry.resultPreview, 300); if (result) member.result = result;
    const error = text(entry.error, 300); if (error) member.error = error;
    const startedAt = count(entry.startedAt ?? entry.queuedAt); if (startedAt !== undefined) member.startedAt = startedAt;
    const updatedAt = count(entry.lastProgressAt); if (updatedAt !== undefined) member.updatedAt = updatedAt;
    members.push(member);
  }
  return members;
}

/**
 * Claude Code reports its own background work (workflows, subagents, background shells) as task_* system events.
 * Each becomes a partial `task` event: fields an event does not carry are unchanged, so a host merges them by id.
 * Internal (ambient) tasks are left out.
 */
export function translateTaskEvent(raw: RawEvent): TaskEvent | undefined {
  const id = text(raw.task_id, 120);
  if (!id || raw.ambient === true) return undefined;
  const event: TaskEvent = { type: 'task', id };
  const set = <K extends keyof TaskEvent>(key: K, value: TaskEvent[K] | undefined) => { if (value !== undefined) event[key] = value; };
  const usage = object(raw.usage);
  switch (raw.subtype) {
    case 'task_started':
      event.state = 'running';
      set('kind', kindOf(raw.task_type));
      set('nativeType', text(raw.task_type, 60));
      set('parentId', text(raw.parent_task_id, 120));
      set('name', text(raw.workflow_name, 120));
      set('description', text(raw.description, 300));
      if (typeof raw.is_backgrounded === 'boolean') event.background = raw.is_backgrounded;
      break;
    case 'task_progress':
      event.state = 'running';
      set('description', text(raw.description, 300));
      set('summary', text(raw.summary, 500));
      set('lastTool', text(raw.last_tool_name, 80));
      if (Object.keys(usage).length) event.usage = { tokens: count(usage.total_tokens), toolUses: count(usage.tool_uses), durationMs: count(usage.duration_ms) };
      set('members', membersOf(raw.workflow_progress));
      break;
    case 'task_updated': {
      const patch = object(raw.patch);
      set('state', stateOf(patch.status));
      set('description', text(patch.description, 300));
      set('error', text(patch.error, 500));
      if (typeof patch.is_backgrounded === 'boolean') event.background = patch.is_backgrounded;
      break;
    }
    case 'task_notification':
      set('state', stateOf(raw.status) ?? 'completed');
      set('summary', text(raw.summary, 500));
      if (Object.keys(usage).length) event.usage = { tokens: count(usage.total_tokens), toolUses: count(usage.tool_uses), durationMs: count(usage.duration_ms) };
      set('members', membersOf(raw.workflow_progress));
      if (typeof raw.workflow_progress_omitted === 'number' && raw.workflow_progress_omitted > 0) event.membersOmitted = raw.workflow_progress_omitted;
      break;
    default:
      return undefined;
  }
  if (event.usage) for (const key of Object.keys(event.usage) as Array<keyof NonNullable<TaskEvent['usage']>>) if (event.usage[key] === undefined) delete event.usage[key];
  return event;
}
