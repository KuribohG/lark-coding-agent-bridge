/** One public registry for direct host tools and the legacy IPC transport. */
export const MAIN_WORKFLOW_METHODS = ['status', 'read_artifact', 'run_script', 'replay_script', 'publish_artifact', 'ack_events',
  'cancel_task', 'pause', 'resume', 'cancel', 'complete', 'send_message', 'read_checkpoint', 'enqueue_work', 'retry_work', 'close_work_queue', 'work_status'] as const;
export const WORKER_WORKFLOW_METHODS = ['task_status', 'read_context', 'checkpoint', 'send_message', 'read_artifact', 'claim_work',
  'renew_claim', 'checkpoint_work', 'complete_work', 'fail_work', 'release_claim', 'work_status', 'run_workflow'] as const;
export function workflowToolDefinitions(kind: 'main' | 'worker') {
  return [{ type: 'function', function: { name: 'workflow_call', description: 'Operate only the workflow bound by the current trusted host turn.',
    parameters: { type: 'object', additionalProperties: false, properties: {
      method: { type: 'string', enum: [...(kind === 'main' ? MAIN_WORKFLOW_METHODS : WORKER_WORKFLOW_METHODS)] },
      args: { type: 'object' },
    }, required: ['method', 'args'] } } }];
}
