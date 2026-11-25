// The parts of the workflow dashboard's views (packages/workflow-engine/src/dashboard/views.ts) the panel shows.

export type Tone = 'running' | 'attention' | 'failed' | 'done' | 'cancelled';
export type WorkStatus = 'pending' | 'claimed' | 'completed' | 'failed' | 'cancelled';

export interface WorkflowSummary {
  id: string;
  rootId: string;
  parentId?: string;
  name: string;
  goal: string;
  status: string;
  stage: 'done' | 'cancelled' | 'binding' | 'paused' | 'interrupted' | 'script_failed' | 'summarizing' | 'queued' | 'running';
  tone: Tone;
  phase?: string;
  agent: string;
  model?: string;
  effort?: string;
  createdAt: number;
  updatedAt?: number;
  deadlineAt: number;
  members: { total: number; running: number; stopped: number };
  turns: { total: number; running: number; slot: number; waiting: number; queued: number; failed: number; done: number };
  work?: Record<WorkStatus, number> & { total: number };
  todos: number;
  asks: number;
  notices: number;
  /** Set instead of the rest when this build cannot read the workflow. */
  unreadable?: string;
}

export interface QueueView {
  name: string;
  open: boolean;
  lead?: string;
  consumers: string[];
  staffed: number;
  counts: Record<WorkStatus, number>;
  held: number;
  blocked: number;
}

export interface OverviewView {
  summary: WorkflowSummary;
  goal: string;
  statuses: Array<{ lead: string; text: string; at: number; version: number }>;
  script?: { name: string; status: string; phase?: string; error?: string; logs: string[] };
  queues: QueueView[];
  todos: Array<{ id: number; kind: string; subject: string; since: number; holder?: string }>;
  asks: Array<{ seq: number; from: string; to: string; at: number; excerpt: string }>;
}

export interface MemberView {
  name: string;
  role: 'lead' | 'queue-lead' | 'worker' | 'member' | 'agent';
  queue?: string;
  agent: string;
  model?: string;
  phase: string;
  task?: { status: string; startedAt?: number; error?: string };
  item?: { key: string; title: string };
  turns: number;
  itemsDone: number;
  itemsFailed: number;
  detail?: string;
  activeAt?: number;
}

export interface WorkItemView {
  id: string;
  key: string;
  title: string;
  queue: string;
  status: WorkStatus;
  hold?: boolean;
  assignee?: string;
  doneBy?: string;
  updatedAt: number;
  error?: string;
}

export interface WorkView {
  total: number;
  items: WorkItemView[];
}

export interface PostView {
  seq: number;
  from: string;
  to: string[];
  all?: boolean;
  topic?: string;
  text: string;
  truncated?: boolean;
  createdAt: number;
  ask?: { within: number; open: boolean };
}

export interface BoardView {
  total: number;
  posts: PostView[];
}
