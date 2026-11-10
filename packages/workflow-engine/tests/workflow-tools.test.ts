import { describe, expect, it } from 'vitest';
import { WORKFLOW_TOOL_INSTRUCTIONS, workflowWorkerInstructions } from '../src/engine/tools/instructions';
import { BUILTIN_WORKFLOW_TOOLS, WorkflowToolRegistry } from '../src/engine/tools/registry';
import type { WorkflowTask } from '../src/engine/types';

describe('workflow tool plugins', () => {
  it('documents every main operation in the main agent instructions', () => {
    const operations = WORKFLOW_TOOL_INSTRUCTIONS.match(/^操作：(.*)。$/m)?.[1]?.split('；').map(item => item.replace(/\(.*$/, ''));
    expect(operations).toEqual(BUILTIN_WORKFLOW_TOOLS.mainNames());
  });

  it('documents every worker operation in the instructions of the workers that can call it', () => {
    const member = workflowWorkerInstructions({ agentId: 'member', workflowTool: true } as WorkflowTask);
    // Workers learn read_artifact from the input references in their prompt.
    for (const name of BUILTIN_WORKFLOW_TOOLS.workerNames().filter(name => name !== 'read_artifact')) expect(member, name).toContain(name);
    expect(workflowWorkerInstructions({ agentId: 'member' } as WorkflowTask)).not.toContain('run_workflow');
  });

  it('rejects ambiguous registrations', () => {
    const tool = { name: 'x', worker: { call: () => null } };
    expect(() => new WorkflowToolRegistry([{ id: 'a', tools: [tool] }, { id: 'b', tools: [tool] }])).toThrow('Duplicate workflow tool: x');
    expect(() => new WorkflowToolRegistry([{ id: 'a', tools: [] }, { id: 'a', tools: [] }])).toThrow('Duplicate workflow tool plugin: a');
    expect(() => new WorkflowToolRegistry([{ id: 'a', tools: [{ name: 'y' }] }])).toThrow('has no caller');
    // The same name may serve both callers through one tool, as read_artifact does.
    expect(BUILTIN_WORKFLOW_TOOLS.main('read_artifact')).toBeDefined();
    expect(BUILTIN_WORKFLOW_TOOLS.worker('read_artifact')).toBeDefined();
  });
});
