import { RETIRED_EVENTS, type DomainEvent } from './events';
import { BOARD_DEFAULT_TOPIC, BOARD_TOPIC_RECENT, SWARM_MAX_RESULTS, WORK_FLOW_SLOT_MS, WORK_FLOW_SLOTS } from './limits';
import { CALL_KINDS, RECORDS } from './records';
import type { BoardPost, Immutable, MailboxMessage, MailboxReceipt, OpenAsk, StoredTask, WorkFlowSlot, WorkflowData, WorkflowTodo, WorkflowView, WorkflowWait, WorkflowWorkItem, WorkflowWorkQueue } from './types';

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
    case 'workflow_cancel_requested': return setStatus(state, 'cancelling', 'cancelled');
    case 'workflow_cancelled': return setStatus(state, 'cancelled', 'cancelled');
    case 'workflow_completed': state.status = 'completed'; return;
    case 'binding_invalidated': return setStatus(state, 'binding_attention', 'interrupted');
    case 'workflow_interrupted':
      if (event.restart) state.restart = event.restart;
      return setStatus(state, 'interrupted', 'interrupted');
    case 'restart_resume_disabled': state.restart = { ...state.restart!, resume: false }; return;
    case 'clock_resumed': state.deadlineAt = event.deadlineAt; state.restart = undefined; return;
    case 'deadline_extended': state.deadlineAt = event.deadlineAt; return;
    case 'concurrency_changed': state.definition.maxConcurrentWorkers = event.maxConcurrentWorkers; return;
    case 'charter_set': state.charter = { version: (state.charter?.version ?? 0) + 1, text: event.text, by: event.by, at: event.at }; return;
    case 'status_set': (state.statuses ??= {})[event.by] = { text: event.text, at: event.at, version: (state.statuses[event.by]?.version ?? 0) + 1 }; return;
    case 'todos_updated': {
      const todos = state.todos ??= { next: 1, open: [] };
      for (const id of event.remove ?? []) {
        const gone = todos.open.find(found => found.id === id);
        // A dry spell that someone was told of counts in the queue's record once it is over.
        if (gone?.kind === 'dry' && gone.told.length) drySpell(state, gone, event.at);
      }
      if (event.remove?.length) todos.open = todos.open.filter(found => !event.remove!.includes(found.id));
      for (const entry of event.upsert ?? []) {
        const at = todos.open.findIndex(found => found.id === entry.id);
        if (at >= 0) todos.open[at] = entry; else todos.open.push(entry);
        todos.next = Math.max(todos.next, entry.id + 1);
      }
      return;
    }
    case 'main_wake_set': state.mainWake = event.wake; return;
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
      // Keyed calls belong to a run; the archived ones of the run that ended stay in the archive under its ID.
      for (const kind of Object.values(CALL_KINDS)) if (state.archivedRecords?.[kind]) state.archivedRecords[kind] = 0;
      script.logs = []; script.error = undefined; script.resultRef = undefined; script.phase = undefined; delete script.stopReason;
      state.status = 'active';
      return;
    }
    case 'script_call_recorded': state.script!.calls.push(event.call); return;
    case 'script_call_archived': state.script!.archivedCalls = (state.script!.archivedCalls ?? 0) + 1; return;
    case 'script_key_recorded': (state.script![event.list] ??= []).push(event.key); return;
    case 'workspace_key_reserved': (state.workspaceKeys ??= []).push(event.key); return;
    case 'control_operation_recorded': (state.controlOperations ??= []).push(event.operation); return;
    case 'script_phase_set': state.script!.phase = event.phase; return;
    case 'script_writes_set':
      if (event.paths.length) state.script!.writes = event.paths; else delete state.script!.writes;
      return;
    case 'script_logged': state.script!.logs = [...state.script!.logs, event.text].slice(-50); return;
    case 'script_succeeded': state.script!.resultRef = event.resultRef; state.script!.status = 'result_ready'; return;
    case 'script_failed':
      state.script!.status = 'failed'; state.script!.error = event.error;
      if (event.stopReason) state.script!.stopReason = event.stopReason;
      return;

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
    case 'records_archived': {
      const spec = RECORDS[event.kind];
      const gone = new Set(event.ids);
      const list = spec.list(state) ?? [];
      // A new array, as for tasks: byId() indexes arrays on the assumption that they only grow.
      const kept = list.filter(entry => {
        if (!gone.has(spec.id(entry, state))) return true;
        spec.left?.(state, entry);
        return false;
      });
      spec.replace(state, kept);
      const totals = state.archivedRecords ??= {};
      totals[event.kind] = (totals[event.kind] ?? 0) + list.length - kept.length;
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
    case 'execution_stop_requested': task(state, event.taskId).quiescence = 'requested'; return;
    case 'execution_uncertain': {
      const found = task(state, event.taskId);
      found.status = 'unknown'; found.quiescence = 'unknown'; found.error = event.error;
      const attempt = found.attempts.at(-1);
      if (attempt) attempt.result = 'unknown';
      return;
    }
    case 'execution_settled': {
      const found = task(state, event.taskId);
      const attempt = found.attempts.at(-1)!;
      found.quiescence = 'quiescent'; attempt.completionDigest = event.digest; attempt.completedRevision = event.revision;
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
      agent.boardSeq = (state.board?.posts.length ?? 0) + (state.archivedRecords?.post ?? 0);
      if (state.charter) agent.charterSeen = state.charter.version;
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
    case 'turn_mail_shown': {
      // Input of the turn like the messages it began with: read_context lists them, a retry is handed them again, and
      // the turn consumes them when it completes, so they wake the member for no turn of their own.
      const found = task(state, event.taskId);
      for (const message of mailbox(state).messages) {
        if (!event.messageIds.includes(message.id)) continue;
        message.shownInTurnId = found.taskId;
        (found.inputMessageIds ??= []).push(message.id);
      }
      return;
    }
    case 'board_posted': {
      const board = state.board ??= { posts: [] };
      board.posts.push(event.post);
      const topic = (board.topics ??= {})[event.post.topic ?? BOARD_DEFAULT_TOPIC] ??= { posts: 0, recent: [] };
      topic.posts++;
      topic.recent.push(event.post.seq);
      if (topic.recent.length > BOARD_TOPIC_RECENT) topic.recent.shift();
      if (event.post.ask) (board.asks ??= []).push(openAsk(event.post, event.post.createdAt));
      if (!event.deliveries.length) return;
      const box = mailbox(state);
      box.messages.push(...event.deliveries);
      const recipients = new Set(event.deliveries.map(message => message.to));
      for (const receipt of box.receipts) if (recipients.has(receipt.agentId)) settleReceipt(state, receipt);
      return;
    }
    case 'board_post_resolved': {
      const board = state.board ??= { posts: [] };
      // A post that has left the state carries the mark in its archived entry, which the store amends.
      const post = board.posts[event.seq - (state.archivedRecords?.post ?? 0) - 1];
      if (post && event.resolved) post.resolved = event.resolved; else if (post) delete post.resolved;
      const topic = (board.topics ??= {})[event.topic] ??= { posts: 0, recent: [] };
      const resolved = (topic.resolved ?? 0) + (event.resolved ? 1 : -1);
      if (resolved > 0) topic.resolved = resolved; else delete topic.resolved;
      // An ask is open for as long as its post is: resolved it is answered or withdrawn, reopened it is owed again.
      if (board.asks || event.ask) {
        const asks = (board.asks ?? []).filter(ask => ask.seq !== event.seq);
        if (event.ask) asks.push(event.ask);
        if (asks.length) board.asks = asks.sort((a, b) => a.seq - b.seq); else delete board.asks;
      }
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
      if (event.reopened) { found.status = 'running'; found.stop = undefined; found.reason = undefined; found.lastPost = undefined; }
      return;
    }
    case 'swarm_turn_scheduled': {
      const found = swarm(state, event.swarmId);
      const member = found.members.find(item => item.name === event.member)!;
      member.taskId = event.taskId; member.retryPending = undefined; member.lastWake = event.wake;
      if (event.timer) { member.wakeAt = undefined; member.wakeNote = undefined; }
      // The prompt of a new turn told the member of its move and of what waits on it; a retried turn runs the prompt it had.
      // The first turn of a new session is a wake-up of the member like any other; only the turn a member starts with is not.
      const again = Boolean(member.takeover);
      if (!event.retry) { member.movedFrom = undefined; member.takeover = undefined; if (event.at !== undefined) member.briefedAt = event.at; }
      if (!event.retry) {
        found.turns.push({ key: event.key, member: event.member, taskId: event.taskId });
        if (!event.opening || again) member.turns++;
      }
      return;
    }
    case 'swarm_member_wake_cleared': swarm(state, event.swarmId).members.find(item => item.name === event.member)!.lastWake = undefined; return;
    case 'swarm_member_added': swarm(state, event.swarmId).members.push(event.member); return;
    case 'swarm_member_timer_set': {
      const member = swarm(state, event.swarmId).members.find(item => item.name === event.member)!;
      member.wakeAt = event.at; member.wakeNote = event.at === undefined ? undefined : event.note;
      return;
    }
    case 'swarm_member_stopped': {
      const member = swarm(state, event.swarmId).members.find(item => item.name === event.member)!;
      member.stopped = event.reason; member.detail = event.detail;
      return;
    }
    case 'swarm_member_workspace_cleaned': {
      const member = swarm(state, event.swarmId).members.find(item => item.name === event.member)!;
      delete member.workspace; member.cleaned = true;
      return;
    }
    case 'swarm_member_revived': {
      const member = swarm(state, event.swarmId).members.find(item => item.name === event.member)!;
      member.stopped = undefined; member.detail = undefined; member.lastWake = undefined;
      if (event.auto) member.autoRevived = (member.autoRevived ?? 0) + 1;
      return;
    }
    case 'swarm_member_replaced': {
      const member = swarm(state, event.swarmId).members.find(item => item.name === event.member)!;
      member.takeover = { ...(event.by ? { by: event.by } : {}), ...(member.stopped ? { was: member.stopped } : {}), ...(member.detail ? { detail: member.detail } : {}), ...(event.brief ? { brief: event.brief } : {}) };
      member.sessions = (member.sessions ?? 1) + 1;
      // Without a latest turn the member is neither retried nor taken for failed: it starts like one that was added.
      member.stopped = undefined; member.detail = undefined; member.taskId = undefined; member.retryPending = undefined; member.lastWake = undefined; member.autoRevived = undefined;
      const agent = state.agents!.find(item => item.key === event.member)!;
      const given = agent.activeTurnId;
      agent.activeTurnId = undefined; agent.lastTurnId = event.cursor; agent.wait = undefined;
      // The new session has read none of the rulings the old one was handed.
      agent.boardSeq = undefined;
      const session = byId(state.sessions, item => item.sessionRef, agent.sessionRef)!;
      // Nothing to resume: the host starts a new native session, which the next session_bound records.
      session.nativeSessionId = undefined; session.observedModel = undefined; session.generation++;
      if (!given) return;
      // The turn the old session did not finish is given up. It is not part of what the member did, so it leaves the
      // calls of the run, as a replay, which carries only finished turns, would leave it out.
      const script = state.script!;
      script.calls = script.calls.filter(call => call.taskId !== given);
      // It consumes nothing either: what it had taken of the member's messages is for the new session.
      const box = mailbox(state);
      const held = new Set<string>();
      for (const receipt of box.receipts) if (receipt.turnId === given) { held.add(receipt.id); receipt.status = 'consumed'; }
      for (const message of box.messages) {
        if (message.consumedByTurnId) continue;
        if (message.receiptId && held.has(message.receiptId)) message.receiptId = undefined;
        if (message.shownInTurnId === given) message.shownInTurnId = undefined;
      }
      return;
    }
    case 'swarm_member_moved': {
      const member = swarm(state, event.swarmId).members.find(item => item.name === event.member)!;
      // A member that has had a turn was told the queue it consumed then, so its next turn tells it where it is now;
      // moved back before that turn, it has nothing to be told.
      if (member.taskId && member.movedFrom === undefined) member.movedFrom = member.queue;
      if (member.movedFrom === event.queue) member.movedFrom = undefined;
      // What it was last woken for was the work of the queue it leaves.
      member.queue = event.queue; member.lastWake = undefined;
      if (event.role !== undefined) member.role = event.role;
      return;
    }
    case 'swarm_results_seen': {
      const found = swarm(state, event.swarmId);
      const left = (found.results ?? []).filter(entry => !event.items.includes(entry.item));
      found.results = left.length ? left : undefined;
      return;
    }
    case 'swarm_turns_extended': swarm(state, event.swarmId).maxTurns = event.maxTurns; return;
    case 'swarm_finish_requested': swarm(state, event.swarmId).finish = { result: event.result }; return;
    case 'swarm_ended': {
      const found = swarm(state, event.swarmId);
      found.status = 'done'; found.stop = event.stop; found.reason = event.reason; found.lastPost = (state.board?.posts.length ?? 0) + (state.archivedRecords?.post ?? 0);
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
    case 'work_queue_reopened': {
      const work = queue(state);
      const control = event.name === 'default' ? work : work.queues?.[event.name];
      if (control) { control.closedAt = undefined; control.closeKey = undefined; }
      return;
    }
    case 'work_enqueued':
      queue(state).items.push(event.item);
      // A gate is a condition, not work that enters and leaves a queue: the flow counts what members have to do.
      if (!event.item.gate) flowed(state, event.item, event.item.createdAt, 'enqueued');
      return;
    case 'work_retried': {
      const found = item(state, event.itemId);
      found.maxAttempts = event.maxAttempts; found.status = 'pending'; found.error = undefined; found.updatedAt = event.at;
      return;
    }
    case 'work_cancelled':
      for (const found of queue(state).items) {
        if (!event.itemIds.includes(found.id)) continue;
        found.status = 'cancelled'; found.updatedAt = event.at;
        if (event.reason !== undefined) found.error = event.reason;
      }
      return;
    case 'work_updated': {
      const found = item(state, event.itemId);
      if (event.priority !== undefined) found.priority = event.priority || undefined;
      if (event.hold !== undefined) {
        found.hold = event.hold || undefined;
        found.held = event.hold ? event.held : undefined;
      }
      if (event.assignee !== undefined) found.assignee = event.assignee ?? undefined;
      if (event.dependsOn !== undefined) found.dependsOn = event.dependsOn.length ? event.dependsOn : undefined;
      if (event.supersededBy !== undefined) found.supersededBy = event.supersededBy;
      if (event.landing) found.landing = event.landing;
      if (event.amend) {
        if (event.amend.title !== undefined) found.title = event.amend.title;
        if (Object.hasOwn(event.amend, 'input')) found.input = event.amend.input;
        if (event.amend.writes !== undefined) found.writes = event.amend.writes.length ? event.amend.writes : undefined;
        if (event.amend.resources !== undefined) found.resources = event.amend.resources;
        found.revision = (found.revision ?? 0) + 1;
      }
      // Whoever plans the item has changed what it asks, whom it is for or what it waits on: the rounds it made before
      // say nothing of the item as it is now.
      if (event.amend || event.assignee || event.dependsOn !== undefined) found.idleClaims = undefined;
      if (event.settled) {
        found.status = 'completed'; found.result = event.settled.result; found.settledBy = event.settled.by;
        found.error = undefined; found.hold = undefined; found.held = undefined; found.landing = undefined;
        if (!found.gate) flowed(state, found, event.at, 'completed');
      }
      found.updatedAt = event.at;
      return;
    }
    case 'work_claimed': {
      const { claim: granted } = event;
      const found = item(state, granted.itemId);
      queue(state).claims.push(granted);
      found.generation = granted.generation; found.claimId = granted.id; found.status = 'claimed';
      found.updatedAt = granted.createdAt; found.error = undefined;
      return;
    }
    case 'claim_frozen': {
      const held = claim(state, event.claimId);
      held.frozen = true; held.reason = event.reason;
      return;
    }
    case 'claim_renewed': claim(state, event.claimId).leaseUntil = event.leaseUntil; return;
    case 'claim_held': claim(state, event.claimId).heldUntil = event.until; return;
    case 'claim_submitted': claim(state, event.claimId).landing = event.landing; return;
    case 'claim_adopted': {
      const adopted = claim(state, event.claimId);
      adopted.taskId = event.by.taskId; adopted.attemptId = event.by.attemptId;
      delete adopted.heldUntil;
      return;
    }
    case 'claim_ended': {
      const ended = claim(state, event.claimId);
      const found = item(state, ended.itemId);
      delete ended.frozen; delete ended.heldUntil;
      ended.status = event.status; ended.endedAt = event.at; ended.reason = event.reason;
      found.claimId = undefined; found.updatedAt = event.at; found.error = ended.reason;
      // An item that was replaced while a member held it does not return to the queue: its replacement is the work now.
      if (found.supersededBy) { found.status = 'cancelled'; found.error = `Superseded by "${found.supersededBy}"; the claim ended: ${ended.reason}`; return; }
      if (event.counted) found.failures = (found.failures ?? 0) + 1;
      // A claim that left neither progress nor a failure behind is one more round the item made without moving.
      found.idleClaims = !event.counted && ended.progress === found.progress.version ? (found.idleClaims ?? 0) + 1 : undefined;
      found.status = event.retry && (found.failures ?? 0) < found.maxAttempts ? 'pending' : 'failed';
      if (event.retry && found.status === 'failed') found.error = 'Attempt budget exhausted: ' + ended.reason;
      if (found.status === 'failed') settled(state, found, ended.agentId, event.at, 'failed');
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
      found.result = event.result; found.status = 'completed'; found.updatedAt = event.at; found.claimId = undefined; found.error = undefined; found.landing = undefined;
      completed.status = 'completed'; completed.endedAt = event.at;
      // Kept on the item, which outlives its claims: what is later found wrong with the result goes back to this member.
      const by = state.agents?.find(agent => agent.agentId === completed.agentId)?.key;
      if (by) found.doneBy = by;
      settled(state, found, completed.agentId, event.at, 'completed');
      return;
    }
    case 'work_operation_recorded': queue(state).operations.push(event.operation); return;
    // A new event must get a case here: the `never` parameter makes that a compile error, and a journal written by
    // another build meets this branch at runtime instead of being silently skipped.
    default:
      if (RETIRED_EVENTS.has((event as { type: string }).type)) return;
      assertNever(event);
  }
}

/** Exhaustiveness check for a closed union. */
function assertNever(value: never): never {
  const type = (value as { type?: unknown } | undefined)?.type;
  throw new Error(`Unhandled workflow event${type === undefined ? '' : `: ${String(type)}`}`);
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

/**
 * Counts an item entering or leaving its queue in the ten-minute slot of `at`. Only the latest slots are kept, so the
 * record stays the same size however long the workflow runs.
 */
/**
 * Adds a dry spell that is over to its queue's record of them. The to-do's subject names the swarm and the queue
 * (`dry:<swarm>:<queue>`); the spell lasted from when the queue ran dry to when it was last seen so.
 */
function drySpell(state: WorkflowData, todo: WorkflowTodo, at: number): void {
  const [, swarmId, ...rest] = todo.subject.split(':');
  const found = state.swarms?.find(swarm => swarm.id === swarmId);
  if (!found) return;
  const lasted = Math.max(0, (todo.goneAt ?? at) - todo.since);
  const dry = (found.dry ??= {})[rest.join(':')] ??= { spells: 0, ms: 0, longest: 0 };
  dry.spells++; dry.ms += lasted; dry.longest = Math.max(dry.longest, lasted);
}

function flowed(state: WorkflowData, found: WorkflowWorkItem, at: number, what: Exclude<keyof WorkFlowSlot, 'slot'>): void {
  const slots = (queue(state).flow ??= {})[found.queue ?? 'default'] ??= [];
  // A clock that stepped back counts into the latest slot, which keeps the slots in order.
  const slot = Math.max(Math.floor(at / WORK_FLOW_SLOT_MS), slots.at(-1)?.slot ?? 0);
  let last = slots.at(-1);
  if (last?.slot !== slot) {
    slots.push(last = { slot });
    while (slots[0]!.slot <= slot - WORK_FLOW_SLOTS) slots.shift();
  }
  last[what] = (last[what] ?? 0) + 1;
}

/**
 * An item was completed, or failed for good, under the claim of `agentId`. Whatever ended the claim (the member's own
 * call, a lease that ran out, a turn that stopped), the item counts in its queue's flow and for the swarm member
 * that held it, and in a swarm with a lead the outcome is owed to the lead that planned the item (see `results`).
 */
function settled(state: WorkflowData, found: WorkflowWorkItem, agentId: string, at: number, how: 'completed' | 'failed'): void {
  flowed(state, found, at, how);
  const name = state.agents?.find(agent => agent.agentId === agentId)?.key;
  for (const owner of state.swarms ?? []) {
    const member = owner.members.find(candidate => candidate.name === name);
    if (!member) continue;
    if (how === 'completed') member.itemsDone = (member.itemsDone ?? 0) + 1; else member.itemsFailed = (member.itemsFailed ?? 0) + 1;
    if (owner.lead && owner.status === 'running' && !owner.finish && (owner.results?.length ?? 0) < SWARM_MAX_RESULTS) (owner.results ??= []).push({ item: found.id, worker: member.name, at });
    return;
  }
}

/** How an ask begins, for those who are told of it without reading it. */
const ASK_EXCERPT_CHARS = 200;

/** A post that asks, as the ask that is open from `at` on. */
export function openAsk(post: Immutable<BoardPost>, at: number): OpenAsk {
  const text = post.text.replace(/\s+/g, ' ').trim();
  return { seq: post.seq, ...(post.from ? { from: post.from } : {}), ...(post.to[0] ? { to: post.to[0] } : {}), at, within: post.ask!.within,
    excerpt: text.length > ASK_EXCERPT_CHARS ? text.slice(0, ASK_EXCERPT_CHARS) + '…' : text };
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
  return (state.mailbox?.messages ?? []).filter(message => message.to === agentId && !message.receiptId && !message.consumedByTurnId && !message.shownInTurnId
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
