import type {
  AgentCheckpoint, DurableAgent, MailboxMessage, MailboxReceipt, SessionBinding, StoredArtifact, StoredTask, TurnAttempt, WorkClaim,
  WorkConsumerPool, WorkerExecutionSelection, WorkflowData, WorkflowEvent, WorkflowScript, WorkflowStopReason, WorkflowWait, WorkflowWorkItem,
} from './types';

type Operation = { key: string; digest: string; response: unknown };

/**
 * Everything that can happen to a workflow. The journal of these events is the only durable record of a workflow;
 * its state is what evolve() (evolve.ts) derives from them. Events carry the values the kernel decided — clocks and
 * generated IDs included — so that replaying them never consults anything but the event itself.
 *
 * An event's meaning is fixed once it has been written: change behaviour by adding an event, not by reinterpreting one.
 */
export type DomainEvent =
  // Workflow lifecycle
  | { type: 'workflow_created'; state: WorkflowData }
  /** Repair and test tooling only: overwrites the whole state (see replaceWorkflowState). */
  | { type: 'workflow_replaced'; state: WorkflowData }
  | { type: 'workflow_paused' }
  | { type: 'workflow_cancelled' }
  | { type: 'workflow_completed' }
  | { type: 'binding_invalidated' }
  | { type: 'workflow_interrupted'; restart?: { since: number; resume: boolean } }
  | { type: 'restart_resume_disabled' }
  | { type: 'clock_resumed'; deadlineAt: number }
  | { type: 'artifact_added'; artifact: StoredArtifact }
  | { type: 'notice_raised'; notice: WorkflowEvent }
  | { type: 'notices_acknowledged'; ids: string[]; at: number }
  | { type: 'notices_notified'; ids: string[]; at: number }
  // Script run
  | { type: 'script_set'; script: WorkflowScript }
  | { type: 'script_started' }
  /** A new run of the script; `counted` is false for the automatic replay after a restart. */
  | { type: 'script_replayed'; runId: string; counted: boolean; planRef?: string; sourceRef?: string; args?: { value: unknown }; defaults?: WorkerExecutionSelection }
  | { type: 'script_call_recorded'; call: { key: string; taskId: string; cached: boolean } }
  | { type: 'script_key_recorded'; list: 'mailboxCalls' | 'workCalls' | 'controlCalls' | 'workspaceCalls'; key: string }
  | { type: 'workspace_key_reserved'; key: string }
  | { type: 'control_operation_recorded'; operation: { key: string; digest: string; taskId: string } }
  | { type: 'script_phase_set'; phase: string }
  | { type: 'script_logged'; text: string }
  | { type: 'script_succeeded'; resultRef: string }
  | { type: 'script_failed'; error: string }
  // Sessions, tasks and their attempts
  | { type: 'session_created'; session: SessionBinding }
  | { type: 'session_bound'; sessionRef: string; taskId: string; nativeSessionId: string; model?: string; at: number }
  | { type: 'task_created'; task: StoredTask }
  | { type: 'task_requeued'; taskId: string; runId: string }
  | { type: 'task_failed'; taskId: string; error: string }
  /** `pending` while the worker process still has to exit. */
  | { type: 'task_cancelled'; taskId: string; pending?: boolean; error?: string }
  | { type: 'task_interrupted'; taskId: string; error: string }
  | { type: 'task_script_cancelled'; taskId: string }
  | { type: 'task_message_turn_marked'; taskId: string }
  | { type: 'task_child_requested'; taskId: string; workflowId: string; at: number }
  | { type: 'task_child_awaited'; taskId: string }
  | { type: 'task_child_finished'; taskId: string }
  | { type: 'attempt_started'; taskId: string; attempt: TurnAttempt }
  | { type: 'attempt_admitted'; taskId: string; at: number }
  | { type: 'attempt_spawned'; taskId: string; runId: string; at: number }
  | { type: 'attempt_ended'; taskId: string; at: number; result: string; stopReason?: WorkflowStopReason; status: StoredTask['status']; error?: string; resultRef?: string }
  // Persistent members, checkpoints and the mailbox
  | { type: 'member_created'; agent: DurableAgent; session: SessionBinding }
  | { type: 'member_turn_scheduled'; task: StoredTask; receiptIds: string[] }
  | { type: 'member_turn_completed'; taskId: string }
  | { type: 'checkpoint_saved'; checkpoint: AgentCheckpoint }
  | { type: 'mailbox_operation_recorded'; operation: Operation }
  | { type: 'message_sent'; message: MailboxMessage }
  | { type: 'receipt_opened'; receipt: MailboxReceipt }
  // Event waits
  | { type: 'wait_opened'; wait: WorkflowWait; agentIds: string[] }
  | { type: 'wait_rebound'; waitId: string; runId: string; agentIds: string[] }
  | { type: 'wait_released'; waitId: string }
  | { type: 'wait_settled'; waitId: string; result: NonNullable<WorkflowWait['result']> }
  // Work queues and claims
  | { type: 'work_queue_opened'; name: string }
  | { type: 'work_queue_closed'; name: string; at: number; closeKey?: string }
  | { type: 'work_enqueued'; item: WorkflowWorkItem }
  | { type: 'work_retried'; itemId: string; maxAttempts: number; at: number }
  | { type: 'work_cancelled'; itemIds: string[]; at: number }
  | { type: 'work_claimed'; claim: WorkClaim }
  | { type: 'claim_renewed'; claimId: string; leaseUntil: number }
  /** A claim that ended without completing its item; `retry` returns the item to the queue while attempts remain. */
  | { type: 'claim_ended'; claimId: string; status: 'failed' | 'released' | 'expired' | 'cancelled'; reason: string; retry: boolean; at: number }
  | { type: 'work_progress_saved'; itemId: string; state: unknown; at: number }
  | { type: 'work_completed'; claimId: string; result: unknown; at: number }
  | { type: 'work_operation_recorded'; operation: Operation }
  // Consumer pools
  | { type: 'pool_created'; pool: WorkConsumerPool }
  | { type: 'pool_rebound'; poolId: string; runId: string; retryPending: string[] }
  | { type: 'pool_member_disabled'; poolId: string; member: string; reason: string }
  | { type: 'pool_member_wake_cleared'; poolId: string; member: string }
  | { type: 'pool_status_changed'; poolId: string; status: WorkConsumerPool['status']; reason?: string }
  | { type: 'pool_turn_scheduled'; poolId: string; member: string; key: string; taskId: string; retry: boolean; wake: string };

/** Events that change a workflow's status or its script's status or run. */
const LIFECYCLE = new Set<DomainEvent['type']>(['workflow_created', 'workflow_replaced', 'workflow_paused', 'workflow_cancelled', 'workflow_completed',
  'workflow_interrupted', 'binding_invalidated', 'script_set', 'script_started', 'script_replayed', 'script_succeeded', 'script_failed']);

/** Subscription topics an event touches (see WorkflowStore.watch). */
export function eventTopics(event: DomainEvent): string[] {
  const topics: string[] = [];
  if ('taskId' in event) topics.push('task:' + event.taskId);
  if ('task' in event) topics.push('task:' + event.task.taskId);
  if ('waitId' in event) topics.push('wait:' + event.waitId);
  if (event.type === 'wait_opened') topics.push('wait:' + event.wait.id);
  if (event.type.startsWith('pool_')) topics.push('pool');
  if (event.type === 'message_sent' || event.type === 'receipt_opened' || event.type.startsWith('member_turn_')) topics.push('mailbox');
  if (LIFECYCLE.has(event.type)) topics.push('lifecycle');
  return topics;
}

/** The entity an event is mainly about, recorded beside it for history queries. */
export function eventEntity(event: DomainEvent): string | undefined {
  if ('taskId' in event) return event.taskId;
  if ('task' in event) return event.task.taskId;
  if ('waitId' in event) return event.waitId;
  if ('claimId' in event) return event.claimId;
  if ('itemId' in event) return event.itemId;
  if ('poolId' in event) return event.poolId;
  switch (event.type) {
    case 'artifact_added': return event.artifact.ref;
    case 'work_enqueued': return event.item.id;
    case 'work_claimed': return event.claim.id;
    case 'wait_opened': return event.wait.id;
    case 'message_sent': return event.message.id;
    case 'receipt_opened': return event.receipt.id;
    case 'checkpoint_saved': return event.checkpoint.ref;
    case 'pool_created': return event.pool.id;
    case 'member_created': return event.agent.agentId;
    case 'session_created': return event.session.sessionRef;
    default: return undefined;
  }
}
