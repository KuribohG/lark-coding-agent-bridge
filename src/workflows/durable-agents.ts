import { randomUUID } from 'node:crypto';
import { sessionIdFieldForAgent } from '../agent/backend-spec';
import { workflowDigest } from './digest';
import { SCRIPT_MAX_TASKS, scriptText, type ScriptAgentCall } from './script-contract';
import type { AgentCheckpoint, AgentMailbox, DurableAgent, MailboxReceipt, WorkerExecution, WorkflowState, WorkflowTask } from './types';

function mailbox(state: WorkflowState): AgentMailbox {
  return state.mailbox ??= { messages: [], receipts: [], operations: [] };
}

export function member(state: WorkflowState, key: string): DurableAgent {
  const found = state.agents?.find(agent => agent.key === key);
  if (!found) throw new Error('Unknown member: ' + key + '; create it with agent(..., {member}) first');
  return found;
}

export function taskAgent(state: WorkflowState, task: WorkflowTask): DurableAgent | undefined {
  return state.agents?.find(agent => agent.agentId === task.agentId);
}

export function checkpoint(state: WorkflowState, agent: DurableAgent): AgentCheckpoint | undefined {
  return state.checkpoints?.find(item => item.ref === agent.checkpointRef);
}

export function saveCheckpoint(state: WorkflowState, task: WorkflowTask, value: unknown, now: number, resultRef?: string): AgentCheckpoint {
  const agent = taskAgent(state, task);
  if (!agent || agent.activeTurnId !== task.taskId) throw new Error('Member turn is no longer active');
  const encoded = JSON.stringify(value ?? null);
  if (encoded.length > 16_000) throw new Error('Checkpoint state exceeds 16000 characters');
  const session = state.sessions.find(item => item.sessionRef === agent.sessionRef)!;
  const saved: AgentCheckpoint = { ref: randomUUID(), agentId: agent.agentId, version: agent.checkpointVersion + 1,
    turnId: task.taskId, attemptId: task.attempts.at(-1)?.attemptId, state: JSON.parse(encoded), createdAt: now,
    sessionGeneration: session.generation, nativeSessionId: session.nativeSessionId, resultRef };
  (state.checkpoints ??= []).push(saved);
  agent.checkpointRef = saved.ref;
  agent.checkpointVersion = saved.version;
  // Retain recent evidence without dropping another member's current recovery point.
  if (state.checkpoints.length > 256) {
    const oldest = state.checkpoints.findIndex(item => !state.agents?.some(a => a.checkpointRef === item.ref));
    if (oldest >= 0) state.checkpoints.splice(oldest, 1);
  }
  return saved;
}

function memberCursor(state: WorkflowState, agent: DurableAgent): string | undefined {
  return state.script!.calls.map(call => state.tasks.find(task => task.taskId === call.taskId))
    .filter(task => task?.agentId === agent.agentId).at(-1)?.taskId;
}

export function scheduleMemberTurn(state: WorkflowState, call: ScriptAgentCall, execution: WorkerExecution): { task: WorkflowTask; cached: boolean } {
  let agent = state.agents?.find(item => item.key === call.member);
  if (agent) {
    const session = state.sessions.find(item => item.sessionRef === agent!.sessionRef)!;
    if (workflowDigest(session.execution) !== workflowDigest(execution)) throw new Error('Member execution binding changed; use a new member name');
  }
  const previousTurnId = agent ? memberCursor(state, agent) : undefined;
  const digest = workflowDigest({ key: call.key, prompt: call.prompt, output: call.output, execution,
    member: call.member, previousTurnId, root: state.root, goal: state.goal, definition: state.definitionDigest });
  const existing = agent && state.tasks.find(task => task.agentId === agent!.agentId && task.requestDigest === digest);
  if (existing?.status === 'result_ready') return { task: existing, cached: true };
  if (existing) {
    if (agent!.activeTurnId !== existing.taskId || ['queued', 'starting', 'running', 'cancelling'].includes(existing.status)) {
      throw new Error('Member already has an active turn; await it before continuing');
    }
    // An explicit replay retries the same logical turn and the same native conversation.
    existing.status = 'queued'; existing.error = undefined; existing.scriptRunId = state.script!.runId;
    return { task: existing, cached: false };
  }
  if (agent?.activeTurnId) throw new Error('Member has an unfinished turn; replay its original input before adding another turn');
  if (agent && agent.lastTurnId !== previousTurnId) throw new Error('Cannot rewrite member history; replay earlier turns unchanged or use a new member name');
  if (agent?.wait && mailbox(state).receipts.find(receipt => receipt.id === agent!.wait!.receiptId)?.status === 'waiting') {
    throw new Error('Member is waiting for a message; await receive() before continuing');
  }
  if (state.tasks.length >= SCRIPT_MAX_TASKS) throw new Error('Script task history limit reached');
  if (!agent) {
    if ((state.agents?.length ?? 0) >= 32) throw new Error('Workflow member limit reached');
    agent = { agentId: randomUUID(), key: call.member!, sessionRef: randomUUID(), checkpointVersion: 0 };
    (state.agents ??= []).push(agent);
    state.sessions.push({ sessionRef: agent.sessionRef, actorId: agent.agentId, actorKey: agent.key, role: 'worker',
      nativeIdKind: sessionIdFieldForAgent(execution.agentKind), execution, generation: 1 });
  }
  const receipts = mailbox(state).receipts.filter(receipt => receipt.agentId === agent!.agentId && receipt.status === 'ready' && !receipt.turnId);
  const task: WorkflowTask = { taskId: randomUUID(), taskKey: call.key, sessionRef: agent.sessionRef, objective: call.prompt,
    requestDigest: digest, cacheKey: digest, status: 'queued', attempts: [], resultRefs: [], inputRefs: [],
    scriptRunId: state.script!.runId, scriptKey: call.key, scriptOutput: call.output, agentId: agent.agentId,
    previousTurnId, inputCheckpointVersion: agent.checkpointVersion, inputMessageIds: receipts.flatMap(receipt => receipt.messageIds) };
  task.cacheKey = workflowDigest({ request: digest, checkpointVersion: task.inputCheckpointVersion, messageIds: task.inputMessageIds });
  for (const receipt of receipts) receipt.turnId = task.taskId;
  agent.activeTurnId = task.taskId;
  agent.wait = undefined;
  state.tasks.push(task);
  return { task, cached: false };
}

export function completeMemberTurn(state: WorkflowState, task: WorkflowTask, resultRef: string, now: number): void {
  const agent = taskAgent(state, task);
  if (!agent) return;
  saveCheckpoint(state, task, checkpoint(state, agent)?.state ?? null, now, resultRef);
  const inbox = mailbox(state);
  for (const message of inbox.messages) if (task.inputMessageIds?.includes(message.id)) message.consumedByTurnId = task.taskId;
  for (const receipt of inbox.receipts) if (receipt.turnId === task.taskId) receipt.status = 'consumed';
  agent.lastTurnId = task.taskId;
  agent.activeTurnId = undefined;
}

export function mailboxOperation(state: WorkflowState, key: string, input: unknown, action: () => unknown): unknown {
  const box = mailbox(state);
  const digest = workflowDigest(input);
  const prior = box.operations.find(item => item.key === key);
  if (prior) {
    if (prior.digest !== digest) throw new Error('Mailbox operation ID conflict');
    return prior.response;
  }
  if (box.operations.length >= 512) throw new Error('Mailbox operation limit reached');
  const response = action();
  box.operations.push({ key, digest, response });
  return response;
}

function settleReceipt(state: WorkflowState, receipt: MailboxReceipt): void {
  if (receipt.status !== 'waiting') return;
  const messages = mailbox(state).messages.filter(message => message.to === receipt.agentId && !message.receiptId && !message.consumedByTurnId).slice(0, 16);
  if (!messages.length) return;
  for (const message of messages) message.receiptId = receipt.id;
  receipt.messageIds = messages.map(message => message.id);
  receipt.status = 'ready';
}

export function sendMessage(state: WorkflowState, target: string, text: unknown, now: number, from?: string): unknown {
  const agent = member(state, target);
  const message = { id: randomUUID(), to: agent.agentId, from, text: scriptText(text, 'message', 4000), createdAt: now };
  const box = mailbox(state);
  if (box.messages.length >= 256) throw new Error('Mailbox message limit reached');
  box.messages.push(message);
  for (const receipt of box.receipts) if (receipt.agentId === agent.agentId) settleReceipt(state, receipt);
  return { messageId: message.id };
}

export function receiveMessages(state: WorkflowState, target: string, key: string): MailboxReceipt {
  const agent = member(state, target);
  const box = mailbox(state);
  const previousTurnId = memberCursor(state, agent);
  const digest = workflowDigest({ target, previousTurnId });
  const prior = box.receipts.find(receipt => receipt.key === key);
  if (prior) {
    if (prior.digest !== digest) throw new Error('Receive key conflict; replay the original member history');
    return prior;
  }
  if (agent.activeTurnId || agent.lastTurnId !== previousTurnId) throw new Error('Await the member turn before receiving messages');
  if (agent.wait) throw new Error('Member already has a pending receive');
  if (box.receipts.length >= 128) throw new Error('Mailbox receive limit reached');
  const receipt: MailboxReceipt = { id: randomUUID(), key, digest, agentId: agent.agentId, status: 'waiting', messageIds: [] };
  box.receipts.push(receipt);
  agent.wait = { kind: 'message', receiptId: receipt.id };
  settleReceipt(state, receipt);
  return receipt;
}

export function receiptMessages(state: WorkflowState, receiptId: string): unknown[] | undefined {
  const box = mailbox(state);
  const receipt = box.receipts.find(item => item.id === receiptId);
  if (!receipt) throw new Error('Unknown mailbox receipt');
  if (receipt.status === 'waiting') return undefined;
  return receipt.messageIds.map(id => {
    const message = box.messages.find(item => item.id === id)!;
    return { id, from: state.agents?.find(agent => agent.agentId === message.from)?.key ?? 'main', text: message.text };
  });
}

export function memberContext(state: WorkflowState, task: WorkflowTask): unknown {
  const agent = taskAgent(state, task);
  if (!agent) return undefined;
  return { member: agent.key, turnId: task.taskId, checkpoint: checkpoint(state, agent),
    messages: mailbox(state).messages.filter(message => task.inputMessageIds?.includes(message.id))
      .map(message => ({ id: message.id, from: state.agents?.find(a => a.agentId === message.from)?.key ?? 'main', text: message.text })) };
}
