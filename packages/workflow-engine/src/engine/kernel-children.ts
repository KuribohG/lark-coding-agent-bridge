import { randomUUID } from 'node:crypto';
import { cancelWork } from './work-queue';
import { workflowDigest } from './digest';
import { MAX_WORKFLOW_DEPTH, nestedInput, nestedResponse } from './nested-workflow';
import { inheritedWorkerExecution, workerSelection } from './execution';
import { MAX_CHILD_WORKFLOWS, SCRIPT_MAX_TASKS } from './limits';
import { acknowledge, addArtifact, BUSY, taskById } from './kernel-state';
import { emit } from './kernel-store';
import type { KernelContext } from './kernel-context';
import type { TaskView, WorkflowData, WorkflowView } from './types';

/** Nested workflows: creation from a worker turn, the shared tree budget, and handing results back to the waiting parent turn. */
export class ChildWorkflows {
  constructor(private readonly ctx: KernelContext) {}

  executionAllowed(state: WorkflowView): boolean {
    if (!state.parent) return true;
    const parent = this.ctx.store.state(state.root.scopeId,state.parent.workflowId);
    const task = parent && taskById(parent, state.parent.taskId);
    return Boolean(parent?.status === 'active' && parent.script?.status === 'running' && task?.status === 'waiting_workflow'
      && task.waitingWorkflowId === state.workflowId && this.executionAllowed(parent));
  }

  remainingTreeTasks(state: WorkflowView): number {
    const tree = this.ctx.store.tree(state);
    const root = tree.find(item=>!item.parent) ?? state;
    // Existing non-nested scripts retain their per-run call budget.
    if (!state.parent && !tree.some(item=>item.parent)) return SCRIPT_MAX_TASKS - state.tasks.length;
    return root.script!.maxCalls - tree.reduce((total,item)=>total+item.tasks.length,0);
  }

  suspendChildren(state: WorkflowView, cancel: boolean, taskId?: string): void {
    for (const child of this.ctx.store.descendants(state, taskId).reverse()) {
      if (['completed','cancelled'].includes(child.status)) continue;
      emit(child, { type: cancel ? 'workflow_cancelled' : 'workflow_paused' });
      if (cancel) cancelWork(child,this.ctx.now());
      for (const task of child.tasks) if (BUSY.has(task.status) || task.status === 'waiting_workflow') this.ctx.scheduler.cancelTask(task,child);
    }
  }

  runChildWorkflow(state: WorkflowView, task: TaskView, args: Record<string, unknown>): unknown {
    const { store, host } = this.ctx;
    const now = this.ctx.now;
    if (!task.workflowTool) throw new Error('run_workflow is not enabled for this agent');
    if (state.status !== 'active' || state.script?.status !== 'running' || now() >= state.deadlineAt) throw new Error('Workflow is inactive');
    const session = state.sessions.find(session=>session.sessionRef===task.sessionRef)!;
    if (!session.nativeSessionId) throw new Error('Nested workflow requires a resumable native session');
    const input = nestedInput(args, state.definition);
    const { operationId, ...identity } = input;
    const digest = workflowDigest(identity);
    const calls = store.descendants(state,task.taskId).filter(child=>child.parent!.workflowId===state.workflowId);
    if (calls.some(child=>child.parent!.operationId===operationId && (child.parent!.key!==input.key || child.parent!.digest!==digest))) throw new Error('operationId conflict for nested workflow');
    const prior = calls.find(child=>child.parent!.key===input.key);
    if (prior) {
      if (prior.parent!.digest!==digest) throw new Error('Nested workflow key conflict: input is immutable');
      if (['paused','interrupted'].includes(prior.status)) throw new Error('Child workflow is suspended; explicitly replay the root workflow');
      return nestedResponse(prior);
    }
    if (task.waitingWorkflowId) throw new Error('Agent already has an outstanding child workflow; yield this turn');
    const depth = (state.parent?.depth ?? 0)+1;
    if (depth>MAX_WORKFLOW_DEPTH) throw new Error('Nested workflow depth limit reached');
    if (store.tree(state).filter(child=>child.parent).length>=MAX_CHILD_WORKFLOWS) throw new Error('Child workflow count limit reached');
    const execution = session.execution ?? inheritedWorkerExecution(state.root,{agentKind:state.root.agentKind});
    // The store copies the initial state, so sharing the parent's root and definition here is safe.
    const root = state.root as WorkflowData['root'];
    const definition = { ...state.definition as WorkflowData['definition'],
      maxConcurrentWorkers: Math.min(input.maxConcurrent,state.definition.maxConcurrentWorkers) };
    const child = store.create({
      workflowId:randomUUID(),root,definition,definitionDigest:workflowDigest(definition),
      parent:{workflowId:state.workflowId,taskId:task.taskId,rootWorkflowId:state.parent?.rootWorkflowId ?? state.workflowId,
        depth,key:input.key,digest,operationId,parentQueue:input.parentQueue,checkpoint:input.checkpoint},
      goal:state.goal+'\n\n子 workflow 目标（必须在原始授权范围内）：\n'+input.goal,
      stateVersion:0,status:'active',createdAt:now(),deadlineAt:Math.min(state.deadlineAt,now()+input.timeoutMs),
      sessions:[],tasks:[],artifacts:[],events:[],
    });
    addArtifact(child,'requirements',child.goal,now);
    const source = addArtifact(child,'workflow-script',input.script,now);
    const plan = addArtifact(child,'workflow-plan',input.plan,now);
    emit(child, { type: 'script_set', script: {name:input.name,sourceRef:source.ref,planRef:plan.ref,args:input.args,
      defaults:workerSelection(input.execution,{...root,agentKind:execution.agentKind,modelSettings:execution.modelSettings},host),
      runId:randomUUID(),revision:0,status:'queued',maxCalls:Math.min(input.maxAgents,state.script.maxCalls),calls:[],logs:[]} });
    emit(state, { type: 'task_child_requested', taskId: task.taskId, workflowId: child.workflowId, at: now() });
    return nestedResponse(child);
  }

  /** The child's result and the parent's continuation commit as one recovery boundary. */
  finishChild(state: WorkflowView): void {
    const { store } = this.ctx;
    if (!state.parent) return;
    emit(state, { type: 'workflow_completed' });
    acknowledge(state, state.events, this.ctx.now());
    const unnotified = state.events.filter(event => !event.notified).map(event => event.id);
    if (unnotified.length) emit(state, { type: 'notices_notified', ids: unnotified, at: this.ctx.now() });
    const parent=store.state(state.root.scopeId,state.parent.workflowId);
    const task=parent && taskById(parent, state.parent.taskId);
    if (parent?.status==='active' && parent.script?.status==='running' && task?.status==='waiting_workflow' && task.waitingWorkflowId===state.workflowId) {
      emit(parent, { type: 'task_child_finished', taskId: task.taskId });
    }
  }

  waitingForChild(scopeId: string, workflowId: string, taskId: string, attemptId: string): boolean {
    const state=this.ctx.store.state(scopeId,workflowId);
    const task=state && taskById(state, taskId);
    return Boolean(state?.status==='active' && task?.waitingWorkflowId && task.attempts.at(-1)?.attemptId===attemptId
      && ['starting','running'].includes(task.status));
  }
}
