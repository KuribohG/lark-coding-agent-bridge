import type { AgentEntry } from '../../runtime/agent-entry';
import type { WorkflowRuntime } from '../../workflows/runtime';

/** Entry-specific capabilities are prepared before the shared agent runner. */
export function bindAgentEntry(entry: AgentEntry, scope: string, workflows?: WorkflowRuntime) {
  switch (entry.kind) {
    case 'direct': return undefined;
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
