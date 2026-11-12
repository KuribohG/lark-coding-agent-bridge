import type { AgentEntry } from '../../runtime/agent-entry';
import type { WorkflowRuntime } from '@kuribohg/agent-workflows';

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
