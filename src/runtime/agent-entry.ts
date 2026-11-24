import type { WorkflowRuntime } from '@kuribohg/agent-workflows';

/** Selected by the bridge before preparing an agent turn, never inferred by the model. */
export type AgentEntry =
  | { kind: 'direct' }
  | { kind: 'workflow'; trigger: 'command' | 'event' };

/** What a workflow wake sends in place of user input; `instructions` are the entry binding's. */
export function workflowWakePrompt(instructions = ''): string {
  return `<workflow_events source="bridge">子任务通知，请读取产物并确认事件，继续原工作流。这不是用户输入。\n${instructions}</workflow_events>`;
}

/** The most notices one message into a running turn carries; the rest follow in the next. */
export const NOTICE_PROMPT_MAX = 8;

/**
 * What goes into the main agent's running turn for notices raised since that turn began: the counterpart of the wake
 * prompt for a main agent that is not idle. It carries the notices themselves, since the turn has no fresh status.
 */
export function workflowNoticePrompt(notices: ReadonlyArray<{ id: string; kind: string; summary: string }>): string {
  const lines = notices.slice(0, NOTICE_PROMPT_MAX).map(notice => `- [${notice.kind}] ${notice.summary.slice(0, 900)}（事件 ${notice.id}）`);
  return `<workflow_events source="bridge">工作流在本轮进行期间产生了 ${lines.length} 条通知。这不是用户输入，也不是新任务：把手头这一步做到可以停下的地方后处理它们，再继续原来的工作。\n`
    + `${lines.join('\n')}\n`
    + 'worker_reply 的全文用 worker_messages 读取，现状用 status 核对。worker_reply、review_due 送达即结，待办（todo、ask）在起因消失后自结（暂不处理用 defer_todo，该别人处理用 pass_todo），落地暂停在分支恢复后自结，其余处理后用 ack_events。</workflow_events>';
}

/** Entry-specific capabilities are prepared before the shared agent runner. */
export function bindAgentEntry(entry: AgentEntry, scope: string, workflows?: WorkflowRuntime) {
  switch (entry.kind) {
    case 'direct': {
      // A user who asks about the workflow of this scope, or wants it changed, is answered in an ordinary turn.
      const binding = workflows?.bindMessage(scope);
      return binding && { ...binding, onStarted: () => {} };
    }
    case 'workflow': {
      if (!workflows) throw new Error('Workflow entry is unavailable');
      const binding = workflows.bindMain(scope, entry.trigger === 'command' ? 'start' : 'continue');
      // The turn has started with these notices in its prompt: they are delivered.
      return { ...binding, onStarted: () => workflows.kernel.markNotified(scope, binding.eventIds, true) };
    }
    default: {
      const unsupported: never = entry;
      throw new Error(`Unsupported agent entry: ${String(unsupported)}`);
    }
  }
}
