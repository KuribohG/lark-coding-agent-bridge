/** Arguments every versioned main operation carries for authorization and idempotency, not for the operation itself. */
export const CONTROL_ARGS = ['workflowId', 'operationId', 'expectedStateVersion'];
