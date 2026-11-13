import type { DomainEvent } from './events';
import type { Immutable, MailboxMessage, MailboxReceipt, StoredTask, WorkflowData, WorkflowView, WorkflowWait, WorkflowWorkItem, WorkflowWorkQueue } from './types';

/**
 * Applies one event to a workflow's state. This is the only code that changes workflow state, and it must stay a
 * deterministic function of the state and the event: no clocks, no generated IDs, no I/O. The journal is replayed
 * through it to rebuild a workflow, so anything it derives has to come out the same every time.
 */
export function evolve(state: WorkflowData, event: DomainEvent): void {
  switch (event.type) {
    case 'workflow_created': throw new Error('workflow_created starts a workflow and cannot be applied to one');
    case 'workflow_replaced':
      for (const key of Object.keys(state)) delete (state as unknown as Record<string, unknown>)[key];
      Object.assign(state, event.state);
      return;
    case 'workflow_paused': return setStatus(state, 'paused', 'paused');
    case 'workflow_cancelled': return setStatus(state, 'cancelled', 'cancelled');
    case 'workflow_completed': state.status = 'completed'; return;
    case 'binding_invalidated': return setStatus(state, 'binding_attention', 'interrupted');
    case 'workflow_interrupted':
      if (event.restart) state.restart = event.restart;
      return setStatus(state, 'interrupted', 'interrupted');
    case 'restart_resume_disabled': state.restart = { ...state.restart!, resume: false }; return;
    case 'clock_resumed': state.deadlineAt = event.deadlineAt; state.restart = undefined; return;
    case 'deadline_extended': state.deadlineAt = event.deadlineAt; return;
    case 'artifact_added': state.artifacts.push(event.artifact); return;
    case 'notice_raised': state.events.push(event.notice); return;
    case 'notices_acknowledged':
      for (const notice of state.events) if (event.ids.includes(notice.id) && !notice.acknowledged) { notice.acknowledged = true; notice.acknowledgedAt = event.at; }
      return;
    case 'notices_notified':
      for (const notice of state.events) if (event.ids.includes(notice.id) && !notice.notified) { notice.notified = true; notice.notifiedAt = event.at; }
      return;

    case 'script_set': state.script = event.script; return;
    case 'script_started': state.script!.status = 'running'; return;
    case 'script_replayed': {
      const script = state.script!;
      if (event.planRef) script.planRef = event.planRef;
      if (event.sourceRef) script.sourceRef = event.sourceRef;
      if (event.args) script.args = event.args.value;
      if (event.defaults) script.defaults = event.defaults;
      script.runId = event.runId; script.status = 'queued';
      if (event.counted) script.revision++;
      for (const wait of state.waits ?? []) releaseBindings(state, wait.id);
      script.calls = []; script.mailboxCalls = []; script.workCalls = []; script.controlCalls = []; script.workspaceCalls = [];
      if (script.archivedCalls) script.archivedCalls = 0;
      script.logs = []; script.error = undefined; script.resultRef = undefined; script.phase = undefined;
      state.status = 'active';
      return;
    }
    case 'script_call_recorded': state.script!.calls.push(event.call); return;
    case 'script_call_archived': state.script!.archivedCalls = (state.script!.archivedCalls ?? 0) + 1; return;
    case 'script_key_recorded': (state.script![event.list] ??= []).push(event.key); return;
    case 'workspace_key_reserved': (state.workspaceKeys ??= []).push(event.key); return;
    case 'control_operation_recorded': (state.controlOperations ??= []).push(event.operation); return;
    case 'script_phase_set': state.script!.phase = event.phase; return;
    case 'script_logged': state.script!.logs = [...state.script!.logs, event.text].slice(-50); return;
    case 'script_succeeded': state.script!.resultRef = event.resultRef; state.script!.status = 'result_ready'; return;
    case 'script_failed': state.script!.status = 'failed'; state.script!.error = event.error; return;

    case 'session_created': state.sessions.push(event.session); return;
    case 'session_bound': {
      const session = byId(state.sessions, item => item.sessionRef, event.sessionRef)!;
      session.nativeSessionId = event.nativeSessionId;
      if (event.model) session.observedModel = event.model;
      task(state, event.taskId).attempts.at(-1)!.sessionAt ??= event.at;
      return;
    }
    case 'task_created': state.tasks.push(event.task); return;
    case 'tasks_archived': {
      const gone = new Set(event.taskIds);
      const totals = state.archived ??= { tasks: 0, attempts: 0, statuses: {} };
      // New arrays, not splices: byId() indexes each array on the assumption that it only grows.
      state.tasks = state.tasks.filter(found => {
        if (!gone.has(found.taskId)) return true;
        totals.tasks++; totals.attempts += found.attempts.length;
        totals.statuses[found.status] = (totals.statuses[found.status] ?? 0) + 1;
        return false;
      });
      const sessions = new Set(event.sessionRefs);
      const artifacts = new Set(event.artifactRefs);
      state.sessions = state.sessions.filter(found => !sessions.has(found.sessionRef));
      state.artifacts = state.artifacts.filter(found => !artifacts.has(found.ref));
      const { script } = state;
      if (script) {
        const kept = script.calls.filter(call => !gone.has(call.taskId));
        if (kept.length < script.calls.length) { script.archivedCalls = (script.archivedCalls ?? 0) + script.calls.length - kept.length; script.calls = kept; }
      }
      for (const found of state.swarms ?? []) {
        const kept = found.turns.filter(turn => !gone.has(turn.taskId));
        if (kept.length < found.turns.length) { found.archivedTurns = (found.archivedTurns ?? 0) + found.turns.length - kept.length; found.turns = kept; }
      }
      return;
    }
    case 'task_requeued': {
      const found = task(state, event.taskId);
      found.status = 'queued'; found.error = undefined; found.scriptRunId = event.runId;
      return;
    }
    case 'task_failed': { const found = task(state, event.taskId); found.status = 'failed'; found.error = event.error; return; }
    case 'task_cancelled': {
      const found = task(state, event.taskId);
      if (event.error) found.error = event.error;
      found.status = event.pending ? 'cancelling' : 'cancelled';
      return;
    }
    case 'task_interrupted': { const found = task(state, event.taskId); found.status = 'interrupted'; found.error = event.error; return; }
    case 'task_script_cancelled': task(state, event.taskId).scriptCancelled = true; return;
    case 'task_message_turn_marked': task(state, event.taskId).consumerMessageTurn = true; return;
    case 'task_child_requested': {
      const found = task(state, event.taskId);
      found.waitingWorkflowId = event.workflowId; found.yieldRequestedAt = event.at;
      return;
    }
    case 'task_child_awaited': task(state, event.taskId).status = 'waiting_workflow'; return;
    case 'task_child_finished': {
      const found = task(state, event.taskId);
      found.status = 'queued'; found.resumeWorkflowId = found.waitingWorkflowId;
      found.waitingWorkflowId = undefined; found.yieldRequestedAt = undefined;
      return;
    }
    case 'attempt_started': {
      const found = task(state, event.taskId);
      found.status = 'starting'; found.attempts.push(event.attempt);
      delete found.retryAt;
      return;
    }
    case 'attempt_admitted': task(state, event.taskId).attempts.at(-1)!.admittedAt ??= event.at; return;
    case 'attempt_spawned': {
      const found = task(state, event.taskId);
      const attempt = found.attempts.at(-1)!;
      attempt.runId = event.runId; attempt.spawnedAt ??= event.at;
      found.status = 'running';
      return;
    }
    case 'attempt_ended': {
      const found = task(state, event.taskId);
      const attempt = found.attempts.at(-1)!;
      attempt.endedAt = event.at; attempt.result = event.result; attempt.stopReason = event.stopReason;
      if (event.failureKind !== undefined) attempt.failureKind = event.failureKind;
      found.status = event.status;
      if (event.error !== undefined) found.error = event.error;
      if (event.resultRef) found.resultRefs.push(event.resultRef);
      return;
    }

    case 'attempt_retry_scheduled': {
      const found = task(state, event.taskId);
      // The attempt already ended as failed; the task itself is queued again for a later attempt.
      found.status = 'queued';
      found.retryAt = event.at;
      found.retryCount = (found.retryCount ?? 0) + 1;
      delete found.error;
      return;
    }

    case 'member_created': (state.agents ??= []).push(event.agent); state.sessions.push(event.session); return;
    case 'member_turn_scheduled': {
      const box = mailbox(state);
      for (const receipt of box.receipts) if (event.receiptIds.includes(receipt.id)) receipt.turnId = event.task.taskId;
      const agent = state.agents!.find(item => item.agentId === event.task.agentId)!;
      agent.activeTurnId = event.task.taskId; agent.wait = undefined;
      state.tasks.push(event.task);
      return;
    }
    case 'member_turn_completed': {
      const found = task(state, event.taskId);
      const agent = state.agents!.find(item => item.agentId === found.agentId)!;
      const box = mailbox(state);
      for (const message of box.messages) if (found.inputMessageIds?.includes(message.id)) message.consumedByTurnId = found.taskId;
      for (const receipt of box.receipts) if (receipt.turnId === found.taskId) receipt.status = 'consumed';
      agent.lastTurnId = found.taskId; agent.activeTurnId = undefined;
      return;
    }
    case 'checkpoint_saved': {
      const checkpoints = state.checkpoints ??= [];
      checkpoints.push(event.checkpoint);
      const agent = state.agents!.find(item => item.agentId === event.checkpoint.agentId)!;
      agent.checkpointRef = event.checkpoint.ref; agent.checkpointVersion = event.checkpoint.version;
      // Retain recent evidence without dropping another member's current recovery point.
      if (checkpoints.length > 256) {
        const oldest = checkpoints.findIndex(item => !state.agents?.some(other => other.checkpointRef === item.ref));
        if (oldest >= 0) checkpoints.splice(oldest, 1);
      }
      return;
    }
    case 'mailbox_operation_recorded': mailbox(state).operations.push(event.operation); return;
    case 'message_sent': {
      const box = mailbox(state);
      box.messages.push(event.message);
      for (const receipt of box.receipts) if (receipt.agentId === event.message.to) settleReceipt(state, receipt);
      return;
    }
    case 'direct_message_recorded': (state.direct ??= []).push(event.message); return;
    case 'board_posted': {
      (state.board ??= { posts: [] }).posts.push(event.post);
      if (!event.deliveries.length) return;
      const box = mailbox(state);
      box.messages.push(...event.deliveries);
      const recipients = new Set(event.deliveries.map(message => message.to));
      for (const receipt of box.receipts) if (recipients.has(receipt.agentId)) settleReceipt(state, receipt);
      return;
    }
    case 'receipt_opened': {
      mailbox(state).receipts.push(event.receipt);
      state.agents!.find(item => item.agentId === event.receipt.agentId)!.wait = { kind: 'message', receiptId: event.receipt.id };
      settleReceipt(state, event.receipt);
      return;
    }

    case 'swarm_created': (state.swarms ??= []).push(event.swarm); return;
    case 'swarm_rebound': {
      const found = swarm(state, event.swarmId);
      found.runId = event.runId;
      if (event.archivedCalls) state.script!.archivedCalls = (state.script!.archivedCalls ?? 0) + event.archivedCalls;
      for (const member of found.members) member.retryPending = event.retryPending.includes(member.name) || undefined;
      return;
    }
    case 'swarm_turn_scheduled': {
      const found = swarm(state, event.swarmId);
      const member = found.members.find(item => item.name === event.member)!;
      member.taskId = event.taskId; member.retryPending = undefined; member.lastWake = event.wake;
      found.stalled = undefined;
      // Work resumed, so the next idle spell earns the lead a fresh set of reminders.
      if (event.member !== found.lead) found.nudges = 0;
      if (!event.retry) {
        found.turns.push({ key: event.key, member: event.member, taskId: event.taskId });
        if (!event.opening) member.turns++;
      }
      return;
    }
    case 'swarm_member_wake_cleared': swarm(state, event.swarmId).members.find(item => item.name === event.member)!.lastWake = undefined; return;
    case 'swarm_member_added': swarm(state, event.swarmId).members.push(event.member); return;
    case 'swarm_member_stopped': {
      const member = swarm(state, event.swarmId).members.find(item => item.name === event.member)!;
      member.stopped = event.reason; member.detail = event.detail;
      return;
    }
    case 'swarm_member_revived': {
      const member = swarm(state, event.swarmId).members.find(item => item.name === event.member)!;
      member.stopped = undefined; member.detail = undefined; member.lastWake = undefined;
      return;
    }
    case 'swarm_turns_extended': {
      const found = swarm(state, event.swarmId);
      found.maxTurns = event.maxTurns; found.nudges = 0; found.stalled = undefined;
      return;
    }
    case 'swarm_nudged': swarm(state, event.swarmId).nudges++; return;
    case 'swarm_stalled': swarm(state, event.swarmId).stalled = true; return;
    case 'swarm_finish_requested': swarm(state, event.swarmId).finish = { result: event.result }; return;
    case 'swarm_ended': {
      const found = swarm(state, event.swarmId);
      found.status = 'done'; found.stop = event.stop; found.reason = event.reason; found.lastPost = state.board?.posts.length ?? 0;
      return;
    }

    case 'wait_opened':
      (state.waits ??= []).push(event.wait);
      return bindAgents(state, event.wait.id, event.agentIds);
    case 'wait_rebound': wait(state, event.waitId).runId = event.runId; return bindAgents(state, event.waitId, event.agentIds);
    case 'wait_released': return releaseBindings(state, event.waitId);
    case 'wait_settled': { const found = wait(state, event.waitId); found.result = event.result; found.status = 'ready'; return; }

    case 'work_queue_opened': {
      const work = queue(state);
      if (event.name !== 'default' && !Object.hasOwn(work.queues ?? {}, event.name)) (work.queues ??= {})[event.name] = {};
      return;
    }
    case 'work_queue_closed': {
      const work = queue(state);
      const control = event.name === 'default' ? work : (work.queues ??= {})[event.name] ??= {};
      control.closedAt ??= event.at;
      if (event.closeKey) control.closeKey = event.closeKey;
      return;
    }
    case 'work_enqueued': queue(state).items.push(event.item); return;
    case 'work_retried': {
      const found = item(state, event.itemId);
      found.maxAttempts = event.maxAttempts; found.status = 'pending'; found.error = undefined; found.updatedAt = event.at;
      return;
    }
    case 'work_cancelled':
      for (const found of queue(state).items) if (event.itemIds.includes(found.id)) { found.status = 'cancelled'; found.updatedAt = event.at; }
      return;
    case 'work_claimed': {
      const { claim: granted } = event;
      const found = item(state, granted.itemId);
      queue(state).claims.push(granted);
      found.generation = granted.generation; found.claimId = granted.id; found.status = 'claimed';
      found.updatedAt = granted.createdAt; found.error = undefined;
      return;
    }
    case 'claim_renewed': claim(state, event.claimId).leaseUntil = event.leaseUntil; return;
    case 'claim_ended': {
      const ended = claim(state, event.claimId);
      const found = item(state, ended.itemId);
      ended.status = event.status; ended.endedAt = event.at; ended.reason = event.reason;
      found.claimId = undefined; found.updatedAt = event.at; found.error = ended.reason;
      found.status = event.retry && found.generation < found.maxAttempts ? 'pending' : 'failed';
      if (event.retry && found.status === 'failed') found.error = 'Attempt budget exhausted: ' + ended.reason;
      return;
    }
    case 'work_progress_saved': {
      const found = item(state, event.itemId);
      found.progress = { version: found.progress.version + 1, state: event.state, updatedAt: event.at };
      found.updatedAt = event.at;
      return;
    }
    case 'work_completed': {
      const completed = claim(state, event.claimId);
      const found = item(state, completed.itemId);
      found.result = event.result; found.status = 'completed'; found.updatedAt = event.at; found.claimId = undefined; found.error = undefined;
      completed.status = 'completed'; completed.endedAt = event.at;
      return;
    }
    case 'work_operation_recorded': queue(state).operations.push(event.operation); return;
  }
}

function setStatus(state: WorkflowData, status: WorkflowData['status'], script: NonNullable<WorkflowData['script']>['status']): void {
  state.status = status;
  if (state.script) state.script.status = script;
}

const indexes = new WeakMap<object, { size: number; ids: Map<string, unknown> }>();

/**
 * Finds an item by ID, indexing new items instead of scanning on every call. The index assumes the array only grows:
 * a reducer that removes items must assign a new array.
 */
export function byId<T>(items: readonly T[], id: (item: T) => string, wanted: string | undefined): T | undefined {
  if (wanted === undefined) return undefined;
  let index = indexes.get(items);
  if (!index) indexes.set(items, index = { size: 0, ids: new Map() });
  for (; index.size < items.length; index.size++) index.ids.set(id(items[index.size]!), items[index.size]);
  return index.ids.get(wanted) as T | undefined;
}

function task(state: WorkflowData, id: string): StoredTask {
  return byId(state.tasks, found => found.taskId, id)!;
}

function wait(state: WorkflowData, id: string): WorkflowWait {
  return state.waits!.find(found => found.id === id)!;
}

function swarm(state: WorkflowData, id: string) {
  return state.swarms!.find(found => found.id === id)!;
}

function queue(state: WorkflowData): WorkflowWorkQueue {
  return state.workQueue ??= { items: [], claims: [], operations: [] };
}

function item(state: WorkflowData, id: string): WorkflowWorkItem {
  return byId(queue(state).items, found => found.id, id)!;
}

function claim(state: WorkflowData, id: string) {
  return byId(queue(state).claims, found => found.id, id)!;
}

function mailbox(state: WorkflowData) {
  return state.mailbox ??= { messages: [], receipts: [], operations: [] };
}

function bindAgents(state: WorkflowData, waitId: string, agentIds: string[]): void {
  for (const agent of state.agents ?? []) if (agentIds.includes(agent.agentId)) agent.wait = { kind: 'event', receiptId: waitId };
}

function releaseBindings(state: WorkflowData, waitId: string): void {
  for (const agent of state.agents ?? []) if (agent.wait?.kind === 'event' && agent.wait.receiptId === waitId) agent.wait = undefined;
}

/** Unreserved, unconsumed messages for a member, oldest first; a receive takes at most 16. */
export function availableMessages(state: Pick<WorkflowView, 'mailbox'>, agentId: string, match: { topic?: string; correlationId?: string } = {}): ReadonlyArray<Immutable<MailboxMessage>> {
  return (state.mailbox?.messages ?? []).filter(message => message.to === agentId && !message.receiptId && !message.consumedByTurnId
    && (match.topic === undefined || message.topic === match.topic)
    && (match.correlationId === undefined || message.correlationId === match.correlationId)).slice(0, 16);
}

function settleReceipt(state: WorkflowData, receipt: MailboxReceipt): void {
  if (receipt.status !== 'waiting') return;
  const messages = availableMessages(state, receipt.agentId, receipt.match) as MailboxMessage[];
  if (!messages.length) return;
  for (const message of messages) message.receiptId = receipt.id;
  receipt.messageIds = messages.map(message => message.id);
  receipt.status = 'ready';
}
