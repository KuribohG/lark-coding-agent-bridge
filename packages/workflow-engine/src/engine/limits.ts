/**
 * Ceilings on what one workflow may hold. They bound memory and journal growth and catch runaway scripts; they are
 * not the budget of a run. A workflow asks for the agents and concurrency it needs (`maxAgents`, `maxConcurrent`)
 * and gets small defaults otherwise. Sized for a few hundred workers running at once in one workflow tree.
 */

/** Workers one workflow tree may run at once; `maxConcurrent` asks for up to this many. */
export const MAX_CONCURRENT_WORKERS = 256;
/** Tasks one workflow may create, which is also the ceiling of `maxAgents` and of each kind of script call. */
export const SCRIPT_MAX_TASKS = 2048;
/** Script interpreters running at once on one nesting level. */
export const MAX_RUNNING_SCRIPTS = 32;
/** Memory one script interpreter may use; it holds every result the script keeps. */
export const SCRIPT_MEMORY_BYTES = 256 * 1024 * 1024;

export const MAX_CHILD_WORKFLOWS = 256;

/** Durable members of one workflow, across all its swarms and discussions. */
export const MAX_WORKFLOW_MEMBERS = 512;
/** Members a swarm may be declared with, the lead included. */
export const SWARM_DECLARED_MEMBERS = 256;
/** Members a swarm may ever hold: declared, added by the lead and retired. */
export const SWARM_MAX_MEMBERS = 320;
/** Member names one board post, or one quiet wait, may list. */
export const MAX_NAMED_MEMBERS = 256;

export const MAX_WAITS = 2048;
export const MAX_CONTROL_OPERATIONS = 2048;
export const MAX_WORKSPACE_KEYS = 256;

export const MAILBOX_MAX_MESSAGES = 4096;
export const MAILBOX_MAX_OPERATIONS = 8192;
export const MAILBOX_MAX_RECEIPTS = 2048;

export const BOARD_MAX_POSTS = 8192;
export const BOARD_MAX_DELIVERIES = 32_768;

export const WORK_MAX_ITEMS = 4096;
export const WORK_MAX_CLAIMS = 8192;
export const WORK_MAX_OPERATIONS = 32_768;
/** Serialized size of all queues of one workflow: items with their inputs, progress and results, claims and operation records. */
export const WORK_MAX_BYTES = 64_000_000;
