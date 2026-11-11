import { artifactTools } from './artifacts';
import { boardTools } from './board';
import { lifecycleTools } from './lifecycle';
import { mailboxTools, memberContextTools } from './members';
import { nestedWorkflowTools } from './nested-workflow';
import type { MainTool, WorkerTool, WorkflowToolPlugin } from './types';
import { workQueueTools } from './work-queue';

/** Resolves operation names to their plugin implementations and assembles the matching agent instructions. */
export class WorkflowToolRegistry {
  private readonly mainTools = new Map<string, MainTool & { doc: string }>();
  private readonly workerTools = new Map<string, WorkerTool>();

  constructor(private readonly plugins: readonly WorkflowToolPlugin[]) {
    const ids = new Set<string>();
    for (const plugin of plugins) {
      if (ids.has(plugin.id)) throw new Error(`Duplicate workflow tool plugin: ${plugin.id}`);
      ids.add(plugin.id);
      for (const tool of plugin.tools) {
        if (!tool.main && !tool.worker) throw new Error(`Workflow tool ${tool.name} has no caller`);
        if ((tool.main && this.mainTools.has(tool.name)) || (tool.worker && this.workerTools.has(tool.name))) {
          throw new Error(`Duplicate workflow tool: ${tool.name}`);
        }
        if (tool.main) this.mainTools.set(tool.name, tool.main);
        if (tool.worker) this.workerTools.set(tool.name, tool.worker);
      }
    }
  }

  main(name: string): (MainTool & { doc: string }) | undefined { return this.mainTools.get(name); }
  worker(name: string): WorkerTool | undefined { return this.workerTools.get(name); }
  mainNames(): string[] { return [...this.mainTools.keys()]; }
  workerNames(): string[] { return [...this.workerTools.keys()]; }

  /** The main agent's operation list, one signature per tool. */
  mainOperations(): string {
    return [...this.mainTools.values()].map(tool => tool.doc).join('；');
  }

  memberInstructions(): string[] {
    return this.plugins.flatMap(plugin => plugin.memberInstructions ? [plugin.memberInstructions] : []);
  }

  nestedInstructions(): string[] {
    return this.plugins.flatMap(plugin => plugin.nestedInstructions ? [plugin.nestedInstructions] : []);
  }
}

export const BUILTIN_WORKFLOW_TOOLS = new WorkflowToolRegistry([
  lifecycleTools, artifactTools, memberContextTools, mailboxTools, boardTools, workQueueTools, nestedWorkflowTools,
]);
