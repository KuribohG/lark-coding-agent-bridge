// What the Web channel sends this page. These mirror the server's own types
// (src/channels/web/transcript.ts, src/runtime/run-state.ts): the page is
// built apart from the server, so it keeps its copy of the wire format.

export interface ToolEntry {
  id: string;
  name: string;
  input: unknown;
  status: 'running' | 'done' | 'error';
  output?: string;
}

export type Block =
  | { kind: 'text'; content: string; streaming: boolean }
  | { kind: 'tool'; tool: ToolEntry };

export interface RunState {
  blocks: Block[];
  finalText?: string;
  reasoning: { content: string; active: boolean };
  footer: 'thinking' | 'tool_running' | 'streaming' | null;
  terminal: 'running' | 'done' | 'interrupted' | 'error' | 'idle_timeout';
  errorMsg?: string;
  retry?: { attempt: number; maxAttempts: number; delayMs: number; failureKind?: 'rate_limit' | 'transient' | 'authentication' };
  idleTimeoutMinutes?: number;
  detached?: boolean;
}

export interface Question {
  question: string;
  header?: string;
  options: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
}

interface ItemBase {
  key: string;
  ord: number;
  rev: number;
  at: number;
}

export type UserItem = ItemBase & {
  kind: 'user'; text: string; via: 'message' | 'input' | 'command';
  /** Shown before the server has it. */
  pending?: boolean;
  /** Why the server did not take it. */
  failed?: string;
};
export type RunItem = ItemBase & {
  kind: 'run'; runId: string; state: RunState; result?: string; error?: string; finishedAt?: number; lost?: boolean;
};
export type NoticeItem = ItemBase & { kind: 'notice'; text: string; source: 'workflow' | 'command' | 'bridge' };
export type QuestionItem = ItemBase & {
  kind: 'question'; id: string; runId: string; mode: 'async' | 'blocking'; questions: Question[]; status?: string; answers?: string[][];
};
export type TranscriptItem = UserItem | RunItem | NoticeItem | QuestionItem;

export interface Conversation {
  id: string;
  title: string;
  named?: boolean;
  pinned?: boolean;
  createdAt: number;
  updatedAt: number;
  preview: string;
  activeRunId?: string;
}

export type PageEvent =
  | { type: 'open'; epoch: string; reset: boolean }
  | { type: 'item'; item: TranscriptItem }
  | {
      type: 'run'; key: string; rev: number; base: number; from: number; blocks: Block[]; reasoningFrom: number;
      runId: string; at: number; state: Omit<RunState, 'blocks'>; result?: string; error?: string; finishedAt?: number; lost?: boolean;
    }
  | { type: 'ready'; rev: number; first?: number; more?: boolean }
  | { type: 'conversation'; conversation: Conversation }
  | { type: 'conversations'; conversations: Conversation[] }
  | { type: 'gone' }
  | { type: 'ping' };

export interface Meta {
  version: string;
  commit: string;
  workspace: string;
  agent: string;
  agents: Array<{ value: string; label: string }>;
  display: { show_tools: boolean; show_reasoning: boolean };
  workflows: boolean;
  commands: Array<{ name: string; aliases: string[]; help: string[] }>;
}

export interface ConversationState {
  agent: string;
  activeRunId?: string;
  cwd: string;
  model?: string;
  effort?: string;
}
