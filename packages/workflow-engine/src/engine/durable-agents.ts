import { randomUUID } from 'node:crypto';
import { workflowDigest } from './digest';
import { availableMessages } from './evolve';
import { archivedRecord, artifactOf, findTask, mailboxOperationByKey, postBySeq, readArtifact, receiptByKey, taskById } from './kernel-state';
import { archiveOf, emit, putText } from './kernel-store';
import { MAILBOX_MAX_MESSAGES, MAILBOX_MAX_OPERATIONS, MAILBOX_MAX_RECEIPTS, MAX_WORKFLOW_MEMBERS } from './limits';
import { scriptText, type ScriptAgentCall } from './script-contract';
import type { AgentCheckpoint, AgentView, DurableAgent, Immutable, MailboxMessage, MailboxReceipt, NativeIdKind, StoredTask, TaskView, WorkerExecution, WorkflowView } from './types';

export { availableMessages };

export function member(state: WorkflowView, key: string): AgentView {
  const found = state.agents?.find(agent => agent.key === key);
  if (!found) throw new Error('Unknown member: ' + key + '; create it with agent(..., {member}) first');
  return found;
}

export function taskAgent(state: WorkflowView, task: TaskView): AgentView | undefined {
  return state.agents?.find(agent => agent.agentId === task.agentId);
}

export function checkpoint(state: WorkflowView, agent: AgentView): Immutable<AgentCheckpoint> | undefined {
  return state.checkpoints?.find(item => item.ref === agent.checkpointRef);
}

export function saveCheckpoint(state: WorkflowView, task: TaskView, value: unknown, now: number, resultRef?: string): AgentCheckpoint {
  const agent = taskAgent(state, task);
  if (!agent || agent.activeTurnId !== task.taskId) throw new Error('Member turn is no longer active');
  const encoded = JSON.stringify(value ?? null);
  if (encoded.length > 16_000) throw new Error('Checkpoint state exceeds 16000 characters');
  const session = state.sessions.find(item => item.sessionRef === agent.sessionRef)!;
  const saved: AgentCheckpoint = { ref: randomUUID(), agentId: agent.agentId, version: agent.checkpointVersion + 1,
    turnId: task.taskId, attemptId: task.attempts.at(-1)?.attemptId, state: JSON.parse(encoded), createdAt: now,
    sessionGeneration: session.generation, nativeSessionId: session.nativeSessionId, resultRef };
  emit(state, { type: 'checkpoint_saved', checkpoint: saved });
  return saved;
}

/** The member's latest turn among the calls the current script run has made. */
export function memberCursor(state: WorkflowView, agent: AgentView): string | undefined {
  const { calls, archivedCalls, runId } = state.script!;
  for (let index = calls.length - 1; index >= 0; index--) {
    const task = taskById(state, calls[index]!.taskId);
    if (task?.agentId === agent.agentId) return task.taskId;
  }
  // A member's turns run in order and the oldest are archived first, so its archived calls all precede the ones above.
  return archivedCalls ? archiveOf(state)?.lastTurn(runId, agent.agentId) : undefined;
}

export function scheduleMemberTurn(state: WorkflowView, call: ScriptAgentCall, execution: WorkerExecution, nativeIdKind: NativeIdKind, inputRefs: readonly string[] = []): { task: TaskView; cached: boolean } {
  let agent = state.agents?.find(item => item.key === call.member);
  if (agent) {
    const session = state.sessions.find(item => item.sessionRef === agent!.sessionRef)!;
    if (workflowDigest(session.execution) !== workflowDigest(execution)) throw new Error('Member execution binding changed; use a new member name');
    if (session.workspaceId !== call.workspace) throw new Error('Member workspace binding changed; use a new member name');
  }
  const previousTurnId = agent ? memberCursor(state, agent) : undefined;
  const digest = workflowDigest({ key: call.key, prompt: call.prompt, output: call.output, execution,
    member: call.member, previousTurnId, root: state.root, goal: state.goal, definition: state.definitionDigest,
    ...(call.workflowTool ? {workflowTool:true} : {}), ...(call.workspace ? {workspace:call.workspace} : {}),
    ...(inputRefs.length ? { inputs: inputRefs.map(ref => artifactOf(state, ref).digest) } : {}) });
  const existing = agent && (state.tasks.find(task => task.agentId === agent!.agentId && task.requestDigest === digest) ?? archiveOf(state)?.turn(agent.agentId, digest));
  if (existing?.status === 'result_ready') return { task: existing, cached: true };
  if (existing) {
    if (agent!.activeTurnId !== existing.taskId || ['queued', 'starting', 'running', 'cancelling'].includes(existing.status)) {
      throw new Error('Member already has an active turn; await it before continuing');
    }
    // An explicit replay retries the same logical turn and the same native conversation.
    emit(state, { type: 'task_requeued', taskId: existing.taskId, runId: state.script!.runId });
    return { task: existing, cached: false };
  }
  if (agent?.activeTurnId) throw new Error('Member has an unfinished turn; replay its original input before adding another turn');
  if (agent?.wait?.kind === 'event') throw new Error('Member is waiting for an event; await waitFor() before continuing');
  if (agent && agent.lastTurnId !== previousTurnId) throw new Error('Cannot rewrite member history; replay earlier turns unchanged or use a new member name');
  if (agent?.wait && state.mailbox?.receipts.find(receipt => receipt.id === agent!.wait!.receiptId)?.status === 'waiting') {
    throw new Error('Member is waiting for a message; await receive() before continuing');
  }
  if (!agent) {
    if ((state.agents?.length ?? 0) >= MAX_WORKFLOW_MEMBERS) throw new Error('Workflow member limit reached');
    const created: DurableAgent = { agentId: randomUUID(), key: call.member!, sessionRef: randomUUID(), checkpointVersion: 0 };
    emit(state, { type: 'member_created', agent: created, session: { sessionRef: created.sessionRef, actorId: created.agentId, actorKey: created.key, role: 'worker',
      nativeIdKind, execution, generation: 1, ...(call.workspace ? {workspaceId:call.workspace} : {}) } });
    agent = member(state, created.key);
  }
  const receipts = (state.mailbox?.receipts ?? []).filter(receipt => receipt.agentId === agent!.agentId && receipt.status === 'ready' && !receipt.turnId);
  const task: StoredTask = { taskId: randomUUID(), taskKey: call.key, sessionRef: agent.sessionRef, objective: putText(state, call.prompt),
    ...(call.workspace ? {workspaceId:call.workspace} : {}),
    ...(call.workflowTool ? {workflowTool:true} : {}),
    requestDigest: digest, cacheKey: digest, status: 'queued', attempts: [], resultRefs: [], inputRefs: [...inputRefs],
    scriptRunId: state.script!.runId, scriptKey: call.key, scriptOutput: call.output, ...(call.schema ? { scriptSchema: call.schema } : {}), agentId: agent.agentId,
    previousTurnId, boardSince: agent.boardSeq ?? 0, inputCheckpointVersion: agent.checkpointVersion, inputMessageIds: receipts.flatMap(receipt => receipt.messageIds) };
  task.cacheKey = workflowDigest({ request: digest, checkpointVersion: task.inputCheckpointVersion, messageIds: task.inputMessageIds });
  emit(state, { type: 'member_turn_scheduled', task, receiptIds: receipts.map(receipt => receipt.id) });
  return { task: findTask(state, task.taskId), cached: false };
}

export function completeMemberTurn(state: WorkflowView, task: TaskView, resultRef: string, now: number): void {
  const agent = taskAgent(state, task);
  if (!agent) return;
  saveCheckpoint(state, task, checkpoint(state, agent)?.state ?? null, now, resultRef);
  emit(state, { type: 'member_turn_completed', taskId: task.taskId });
}

export function mailboxOperation(state: WorkflowView, key: string, input: unknown, action: () => unknown): unknown {
  const operations = state.mailbox?.operations ?? [];
  const digest = workflowDigest(input);
  const prior = mailboxOperationByKey(state, key);
  if (prior) {
    if (prior.digest !== digest) throw new Error('Mailbox operation ID conflict');
    return prior.response;
  }
  if (operations.length >= MAILBOX_MAX_OPERATIONS) throw new Error('Mailbox operation limit reached');
  const response = action();
  emit(state, { type: 'mailbox_operation_recorded', operation: { key, digest, response } });
  return response;
}

export function messageMatch(input: { topic?: unknown; correlationId?: unknown }): { topic?: string; correlationId?: string } {
  return { ...(input.topic !== undefined ? { topic: scriptText(input.topic, 'message topic', 160) } : {}),
    ...(input.correlationId !== undefined ? { correlationId: scriptText(input.correlationId, 'message correlationId', 160) } : {}) };
}

export function sendMessage(state: WorkflowView, target: string, text: unknown, now: number, from?: string, metadata: { topic?: unknown; correlationId?: unknown } = {}): unknown {
  const agent = member(state, target);
  const message: MailboxMessage = { id: randomUUID(), to: agent.agentId, from, text: scriptText(text, 'message', 4000), createdAt: now, ...messageMatch(metadata) };
  // Board deliveries have their own budget (board.ts).
  if ((state.mailbox?.messages ?? []).filter(item => item.post === undefined).length >= MAILBOX_MAX_MESSAGES) throw new Error('Mailbox message limit reached');
  emit(state, { type: 'message_sent', message });
  return { messageId: message.id };
}

const RELAY_TRUNCATION = '…[truncated]';

/** A relay may only repeat the member's own latest reply, so recipients can trust the sender. */
export function relaySender(state: WorkflowView, name: string, text: unknown): string {
  const agent = member(state, name);
  const ref = taskById(state, agent.lastTurnId)?.resultRefs.at(-1);
  let produced: unknown;
  try { produced = (JSON.parse(ref ? readArtifact(state, ref).text : '') as { message?: unknown }).message; }
  catch { produced = undefined; }
  const reply = typeof produced === 'string' ? produced.trim() : undefined;
  const truncated = typeof text === 'string' && text.endsWith(RELAY_TRUNCATION) && reply?.startsWith(text.slice(0, -RELAY_TRUNCATION.length));
  if (reply === undefined || text !== reply && !truncated) throw new Error("A relayed message must repeat the sender's latest reply");
  return agent.agentId;
}

export function receiveMessages(state: WorkflowView, target: string, key: string, metadata: { topic?: unknown; correlationId?: unknown } = {}): Immutable<MailboxReceipt> {
  const agent = member(state, target);
  const receipts = state.mailbox?.receipts ?? [];
  const previousTurnId = memberCursor(state, agent);
  const match = messageMatch(metadata);
  const filter = Object.keys(match).length ? { match } : {};
  const digest = workflowDigest({ target, previousTurnId, ...filter });
  const prior = receiptByKey(state, key);
  if (prior) {
    if (prior.digest !== digest) throw new Error('Receive key conflict; replay the original member history');
    return prior;
  }
  if (agent.activeTurnId || agent.lastTurnId !== previousTurnId) throw new Error('Await the member turn before receiving messages');
  if (agent.wait) throw new Error('Member already has a pending receive');
  const reserved = (state.waits ?? []).filter(wait => wait.status === 'waiting' && wait.runId === state.script!.runId
    && !key.startsWith(`@wait/${wait.id}/`) && wait.any.some(arm => arm.kind === 'message')).length;
  if (receipts.length + reserved >= MAILBOX_MAX_RECEIPTS) throw new Error('Mailbox receive limit reached');
  const receipt: MailboxReceipt = { id: randomUUID(), key, digest, agentId: agent.agentId, status: 'waiting', messageIds: [], ...filter };
  emit(state, { type: 'receipt_opened', receipt });
  return state.mailbox!.receipts.find(item => item.id === receipt.id)!;
}

/** A mailbox message as its recipient sees it; the delivery of a board post shows the post it stands for. */
function messageView(state: WorkflowView, message: Immutable<MailboxMessage>): Record<string, unknown> {
  const name = (agentId: string) => state.agents?.find(agent => agent.agentId === agentId)?.key ?? agentId;
  const post = message.post === undefined ? undefined : postBySeq(state, message.post);
  return { id: message.id, from: post ? post.from ? name(post.from) : post.author ?? 'main' : message.from ? name(message.from) : 'main',
    text: post ? post.text : message.text, ...messageMatch(message),
    ...(post ? { post: post.seq, to: post.to.map(name), ...(post.all ? { all: true } : {}) } : {}) };
}

export function receiptMessages(state: WorkflowView, receiptId: string): unknown[] | undefined {
  const receipt = state.mailbox?.receipts.find(item => item.id === receiptId) ?? archivedRecord<MailboxReceipt>(state, 'receipt', { id: receiptId });
  if (!receipt) throw new Error('Unknown mailbox receipt');
  if (receipt.status === 'waiting') return undefined;
  return receipt.messageIds.map(id => messageView(state, (state.mailbox!.messages.find(item => item.id === id) ?? archivedRecord<MailboxMessage>(state, 'message', { id }))!));
}

export function memberContext(state: WorkflowView, task: TaskView): unknown {
  const agent = taskAgent(state, task);
  if (!agent) return undefined;
  return { member: agent.key, turnId: task.taskId, checkpoint: checkpoint(state, agent),
    messages: (state.mailbox?.messages ?? []).filter(message => task.inputMessageIds?.includes(message.id)).map(message => messageView(state, message)) };
}
