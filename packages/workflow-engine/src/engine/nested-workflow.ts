import { readArtifact } from './kernel-state';
import { MAX_CONCURRENT_WORKERS, SCRIPT_MAX_TASKS } from './limits';
import { boundedInteger, scriptArgs, scriptText } from './script-contract';
import type { Immutable, TaskView, WorkflowDefinition, WorkflowView } from './types';

export const MAX_WORKFLOW_DEPTH = 3;

export function nestedInput(args: Record<string, unknown>, definition: Immutable<WorkflowDefinition>) {
  if (Object.keys(args).some(key => !['operationId','key','goal','script','plan','args','name','execution','maxAgents','maxConcurrent','timeoutMs','checkpoint','parentQueue'].includes(key))) {
    throw new Error('Unsupported run_workflow option');
  }
  if (args.parentQueue !== undefined && typeof args.parentQueue !== 'boolean') throw new Error('parentQueue must be boolean');
  const checkpoint = scriptArgs(args.checkpoint);
  if (JSON.stringify(checkpoint).length > 16_000) throw new Error('Nested workflow checkpoint exceeds 16000 characters');
  const key = scriptText(args.key, 'nested workflow key', 160);
  if (key.trim() !== key) throw new Error('Nested workflow key must not contain surrounding whitespace');
  return {operationId:scriptText(args.operationId,'operationId',160),key,
    goal:scriptText(args.goal,'goal'),script:scriptText(args.script,'script'),plan:scriptText(args.plan,'plan',12_000),
    args:scriptArgs(args.args),name:scriptText(args.name ?? 'Child workflow','name',100),execution:args.execution,
    maxAgents:boundedInteger(args.maxAgents,32,1,SCRIPT_MAX_TASKS),maxConcurrent:boundedInteger(args.maxConcurrent,4,1,MAX_CONCURRENT_WORKERS),
    timeoutMs:boundedInteger(args.timeoutMs,(definition.defaultWallTimeMinutes ?? 30)*60_000,1000,definition.maxWallTimeMinutes*60_000),checkpoint,parentQueue:args.parentQueue===true};
}

export function nestedResponse(child: WorkflowView): unknown {
  if (child.script?.status === 'result_ready') {
    const result = readArtifact(child, child.script.resultRef!);
    return {workflowId:child.workflowId,key:child.parent!.key,status:'completed',ok:true,result:JSON.parse(result.text),resultRef:result.ref};
  }
  if (child.script?.status === 'failed' || child.status === 'cancelled') {
    return {workflowId:child.workflowId,key:child.parent!.key,status:'failed',ok:false,error:child.script?.error ?? 'Child workflow cancelled'};
  }
  return {workflowId:child.workflowId,key:child.parent!.key,status:'waiting',
    action:'End this agent turn now. The bridge will run the child and resume this same conversation with its result. Do not poll or block the shell.'};
}

export function nestedContext(children: readonly WorkflowView[], task: TaskView): unknown {
  const calls = children.filter(child => child.parent?.taskId === task.taskId);
  const current = calls.find(child => child.workflowId === (task.waitingWorkflowId ?? task.resumeWorkflowId));
  return {calls:calls.map(child=>({workflowId:child.workflowId,key:child.parent!.key,status:child.script?.status,resultRef:child.script?.resultRef})),
    ...(current ? {checkpoint:current.parent!.checkpoint,call:nestedResponse(current)} : {})};
}
