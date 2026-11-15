import type { WorkflowRuntime } from '@kuribohg/agent-workflows';

/** Selected by the bridge before preparing an agent turn, never inferred by the model. */
export type AgentEntry =
  | { kind: 'direct' }
  | { kind: 'workflow'; trigger: 'command' | 'event' };

/** What a workflow wake sends in place of user input; `instructions` are the entry binding's. */
export function workflowWakePrompt(instructions = ''): string {
  return `<workflow_events source="bridge">子任务通知，请读取产物并确认事件，继续原工作流。这不是用户输入。\n${instructions}</workflow_events>`;
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
      return { ...binding, onStarted: () => workflows.kernel.markNotified(scope, binding.eventIds) };
    }
    default: {
      const unsupported: never = entry;
      throw new Error(`Unsupported agent entry: ${String(unsupported)}`);
    }
  }
}
