import { describe, expect, it } from 'vitest';
import { WORKFLOW_GUIDE, WORKFLOW_MESSAGE_INSTRUCTIONS, WORKFLOW_TOOL_INSTRUCTIONS, WORKFLOW_WAKE_INSTRUCTIONS, workflowWorkerInstructions } from '../src/engine/tools/instructions';
import { BUILTIN_WORKFLOW_TOOLS, WorkflowToolRegistry } from '../src/engine/tools/registry';
import type { WorkflowTask } from '../src/engine/types';

describe('workflow tool plugins', () => {
  it('documents every main operation in the main agent instructions, whichever turn they are for', () => {
    for (const text of [WORKFLOW_TOOL_INSTRUCTIONS, WORKFLOW_WAKE_INSTRUCTIONS, WORKFLOW_MESSAGE_INSTRUCTIONS]) {
      const operations = text.match(/^操作：(.*)。$/m)?.[1]?.split('；').map(item => item.replace(/\(.*$/, ''));
      expect(operations).toEqual(BUILTIN_WORKFLOW_TOOLS.mainNames());
    }
  });

  it('documents every worker operation in the instructions of the workers that can call it', () => {
    const member = workflowWorkerInstructions({ agentId: 'member', workflowTool: true } as WorkflowTask);
    // Workers learn read_artifact from the input references in their prompt.
    for (const name of BUILTIN_WORKFLOW_TOOLS.workerNames().filter(name => name !== 'read_artifact')) expect(member, name).toContain(name);
    expect(workflowWorkerInstructions({ agentId: 'member' } as WorkflowTask)).not.toContain('run_workflow');
  });

  it('tells the starting turn how to write a script and leaves the less common script functions to the guide', () => {
    for (const name of ['agent(', 'parallel', 'swarm(', 'enqueueWork', 'closeWorkQueue', 'post(', 'staff_swarm', 'set_charter(text)', 'workflow guide']) expect(WORKFLOW_TOOL_INSTRUCTIONS, name).toContain(name);
    const advanced = ['discuss(topic', 'reviewedAgent(prompt', 'freezeWorkspace', 'configureLanding(', 'raceTasks(', 'waitFor({'];
    for (const name of advanced) {
      expect(WORKFLOW_TOOL_INSTRUCTIONS, name).not.toContain(name);
      expect(WORKFLOW_GUIDE, name).toContain(name);
    }
    expect(WORKFLOW_GUIDE.startsWith(WORKFLOW_TOOL_INSTRUCTIONS)).toBe(true);
    // Paid for once per workflow. What running one takes is told at the wakes, so it is not counted here.
    expect(WORKFLOW_TOOL_INSTRUCTIONS).not.toContain('staff_swarm 不重放调整');
    expect(WORKFLOW_TOOL_INSTRUCTIONS.length).toBeLessThan(8200);
  });

  it('tells a wake how to run the workflow, without the script API', () => {
    for (const name of ['ack_events 后 complete', 'swarm_stalled', 'swarm_attention', 'landing_attention', 'staff_swarm 不重放调整', 'tell_worker(target,text)',
      'set_charter(text)', 'resolve_post 把', 'priority 为 -100..100', 'workflow guide', '不要读取或展示环境中的调用凭据']) expect(WORKFLOW_WAKE_INSTRUCTIONS, name).toContain(name);
    for (const name of ['agent(prompt', 'parallel', 'pipeline', 'swarm(task', 'enqueueWork(', 'closeWorkQueue', 'post(text', 'schema']) expect(WORKFLOW_WAKE_INSTRUCTIONS, name).not.toContain(name);
    // A long run wakes the main agent dozens of times, and every wake's instructions stay in its session.
    expect(WORKFLOW_WAKE_INSTRUCTIONS.length).toBeLessThan(4000);
    // The guide leaves out nothing a wake is told, except the line that points to the guide.
    for (const line of WORKFLOW_WAKE_INSTRUCTIONS.split('\n').slice(0, -1)) expect(WORKFLOW_GUIDE, line.slice(0, 40)).toContain(line.replace(/^replay_script 后结束 turn，子任务由 bridge 管理。/, ''));
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

  it('keeps the earlier name of a renamed tool callable without listing it', () => {
    expect(BUILTIN_WORKFLOW_TOOLS.canonical('cancel')).toBe('cancel_workflow');
    expect(BUILTIN_WORKFLOW_TOOLS.canonical('cancel_task')).toBe('cancel_task');
    expect(BUILTIN_WORKFLOW_TOOLS.mainNames()).not.toContain('cancel');
    const tool = { name: 'x', worker: { call: () => null } };
    expect(() => new WorkflowToolRegistry([{ id: 'a', tools: [tool, { ...tool, name: 'y', aliases: ['x'] }] }])).toThrow('Duplicate workflow tool: x');
    expect(() => new WorkflowToolRegistry([{ id: 'a', tools: [{ ...tool, aliases: ['w'] }, { ...tool, name: 'y', aliases: ['w'] }] }])).toThrow('Duplicate workflow tool: w');
  });
});
