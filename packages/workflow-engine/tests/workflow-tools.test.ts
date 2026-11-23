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
    const lead = workflowWorkerInstructions({ agentId: 'member', workflowTool: true } as WorkflowTask, true);
    // Workers learn read_artifact from the input references in their prompt. What only a member that plans work may
    // call is told to those members alone, after everything the others are told.
    const planning = ['staff_swarm', 'swarm_finish', 'tell_worker', 'retry_work', 'settle_work', 'set_charter'];
    for (const name of BUILTIN_WORKFLOW_TOOLS.workerNames().filter(name => name !== 'read_artifact')) {
      expect(lead, name).toContain(name);
      if (!planning.includes(name)) expect(member, name).toContain(name);
      else { expect(lead, name).toContain(name + '('); expect(member, name).not.toContain(name + '('); }
    }
    for (const line of member.split('\n')) expect(lead, line.slice(0, 40)).toContain(line);
    // Whoever plans is told to name what an item waits for instead of holding it, and to replace items instead of re-issuing them.
    for (const text of ['Do not hold an item to make it wait: name what it waits for in dependsOn', 'gate:true', 'Revise a plan this way: do not add new keys and keep the old ones on hold']) expect(lead, text).toContain(text);
    // A member whose item others wait on fails it when it did not pass, so that they are not let out by a check that found a fault.
    expect(member).toContain('when yours is a check and it did not pass, end it with fail_work');
    expect(member.length).toBeLessThan(lead.length - 2500);
    expect(workflowWorkerInstructions({ agentId: 'member' } as WorkflowTask)).not.toContain('run_workflow');
    // A member is told what to do when a landing fails for a reason that is not its own.
    for (const text of ['Do not merge by hand a file that a command generates', 'If targetCommit fails by itself the landing branch is broken', 'do not repair the changes of other members']) expect(member, text).toContain(text);
    // The queue is told in the order a member meets it, and work found in a delivered item goes back to whoever delivered it.
    const order = ['Taking an item:', 'Doing it:', 'Landing code:', 'When a landing is turned back', 'Adding work:', 'Finding work:', 'Withdrawing work:', 'Repeats and restarts:'].map(text => member.indexOf(text));
    expect(order.every((at, index) => at > (order[index - 1] ?? -1))).toBe(true);
    for (const text of ['origin is the key of the item whose delivered result the new item is about', 'put the key of the item in the commit message']) expect(member, text).toContain(text);
  });

  it('tells the starting turn how to write a script and leaves the less common script functions to the guide', () => {
    for (const name of ['agent(', 'parallel', 'swarm(', 'enqueueWork', 'closeWorkQueue', 'post(', 'staff_swarm', 'set_charter(text)', 'workflow guide']) expect(WORKFLOW_TOOL_INSTRUCTIONS, name).toContain(name);
    const advanced = ['discuss(topic', 'reviewedAgent(prompt', 'freezeWorkspace', 'configureLanding(', 'raceTasks(', 'waitFor({'];
    for (const name of advanced) {
      expect(WORKFLOW_TOOL_INSTRUCTIONS, name).not.toContain(name);
      expect(WORKFLOW_GUIDE, name).toContain(name);
    }
    expect(WORKFLOW_GUIDE.startsWith(WORKFLOW_TOOL_INSTRUCTIONS)).toBe(true);
    // How a batch is staffed is told at the start; how the landing is configured for it, in the guide.
    for (const name of ['乐观交付', '质量队列', '不让成员直接改']) expect(WORKFLOW_TOOL_INSTRUCTIONS, name).toContain(name);
    expect(WORKFLOW_TOOL_INSTRUCTIONS).not.toContain('独立验证者');
    for (const name of ['乐观落地', '热点文件', '落地后的质量团队', 'git bisect']) {
      expect(WORKFLOW_TOOL_INSTRUCTIONS, name).not.toContain(name);
      expect(WORKFLOW_GUIDE, name).toContain(name);
    }
    // Paid for once per workflow. What running one takes is told at the wakes, so it is not counted here.
    expect(WORKFLOW_TOOL_INSTRUCTIONS).not.toContain('staff_swarm 不重放调整');
    expect(WORKFLOW_TOOL_INSTRUCTIONS.length).toBeLessThan(8400);
  });

  it('tells a wake how to run the workflow, without the script API', () => {
    for (const name of ['ack_events 后 complete', 'swarm_stalled', 'swarm_attention', 'landing_attention', 'staff_swarm 不重放调整', 'tell_worker(target,text)',
      'set_charter(text)', 'resolve_post 把', 'priority 为 -100..100', 'workflow guide', '不要读取或展示环境中的调用凭据']) expect(WORKFLOW_WAKE_INSTRUCTIONS, name).toContain(name);
    for (const name of ['agent(prompt', 'parallel', 'pipeline', 'swarm(task', 'enqueueWork(', 'closeWorkQueue', 'post(text', 'schema']) expect(WORKFLOW_WAKE_INSTRUCTIONS, name).not.toContain(name);
    // A long run wakes the main agent dozens of times, and every wake's instructions stay in its session.
    expect(WORKFLOW_WAKE_INSTRUCTIONS.length).toBeLessThan(4350);
    // Waiting is told as a dependency on an item or a gate, and a revision as a replacement, where the fields of an item are.
    for (const name of ['settle_work(itemId 或 key,result)', 'update_work(itemId 或 key,priority?,hold?,assignee?,dependsOn?,supersededBy?,cancel?,reason?)', 'gate:true 是条件项', '不用 hold', 'supersedes 是被本项取代的旧项']) {
      expect(WORKFLOW_WAKE_INSTRUCTIONS, name).toContain(name);
    }
    // An ask is told where posting is, and the event it raises with the other events.
    for (const name of ['post_board(text,to?,topic?,ask?,answers?)', 'ask_open', 'answers:帖号']) expect(WORKFLOW_WAKE_INSTRUCTIONS, name).toContain(name);
    // The guide leaves out nothing a wake is told, except the line that points to the guide. It lists the operations
    // with all their parameters, where a wake names the ones it cannot call or is told about in a line of their own.
    const lines = WORKFLOW_WAKE_INSTRUCTIONS.split('\n').slice(0, -1);
    expect(lines.filter(line => line.startsWith('操作：'))).toEqual([expect.stringMatching(/；run_script；.*；staff_swarm；.*；configure_landing。$/)]);
    for (const line of lines.filter(line => !line.startsWith('操作：'))) expect(WORKFLOW_GUIDE, line.slice(0, 40)).toContain(line.replace(/^replay_script 后结束 turn，子任务由 bridge 管理。/, ''));
    // Whom a post reaches and what the fields of a work item do is one text, told once to a wake and once in the guide.
    for (const text of ['发帖（脚本 post 与 post_board 相同）', '工作项字段（脚本 enqueueWork 与 enqueue_work 相同）', 'origin 是该项所针对的已交付工作项的 key']) {
      expect(WORKFLOW_WAKE_INSTRUCTIONS.split(text), text).toHaveLength(2);
      expect(WORKFLOW_GUIDE.split(text), text).toHaveLength(2);
    }
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
