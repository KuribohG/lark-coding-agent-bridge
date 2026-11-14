/**
 * Ceilings on what one workflow may hold. They bound memory and journal growth and catch runaway scripts; they are
 * not the budget of a run. A workflow asks for the agents and concurrency it needs (`maxAgents`, `maxConcurrent`)
 * and gets small defaults otherwise. Sized for a few hundred workers running at once in one workflow tree; how many
 * tasks a workflow runs over its lifetime is not limited here.
 */

/** Workers one workflow tree may run at once; `maxConcurrent` asks for up to this many. */
export const MAX_CONCURRENT_WORKERS = 256;
/**
 * Ceiling of `maxAgents`. The number of agent calls has no fixed limit: finished tasks leave the state for the
 * archive (archive.ts), so a workflow's budget is whatever it asks for and gets a small default otherwise.
 */
export const MAX_AGENT_CALLS = Number.MAX_SAFE_INTEGER;
/**
 * Keyed calls of each other kind one script run holds in the state: mailbox, work queue, control and workspace.
 * Like the other list ceilings below, this bounds what is live; settled entries move to the archive (records.ts).
 */
export const SCRIPT_MAX_KEYED_CALLS = 2048;
/** Functions one parallel() or items one pipeline() may take. */
export const SCRIPT_MAX_FANOUT = 16_384;
/** Attempts one task may run, retries and resumptions after child workflows included. */
export const MAX_TASK_ATTEMPTS = 512;
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
/**
 * Ceiling of a swarm's `maxTurns`: wake-ups of one member other than the lead. Completed turns are archived, so this
 * does not bound state; it stops members that keep waking each other.
 */
export const SWARM_MAX_TURNS = 4096;
/** Member names one board post, or one quiet wait, may list. */
export const MAX_NAMED_MEMBERS = 256;

export const MAX_WAITS = 2048;
export const MAX_CONTROL_OPERATIONS = 2048;
export const MAX_WORKSPACE_KEYS = 1024;
/** Managed worktrees of one workflow: one for each swarm member that lands its own work, plus review and integration ones. */
export const MAX_WORKSPACES = 384;
/** Workspace records of one workflow: worktrees, frozen changes, approvals, checks and the operations that made them. */
export const MAX_WORKSPACE_RECORDS = 4096;

export const MAILBOX_MAX_MESSAGES = 4096;
export const MAILBOX_MAX_OPERATIONS = 8192;
export const MAILBOX_MAX_RECEIPTS = 2048;

export const BOARD_MAX_DELIVERIES = 32_768;
/** The topic of a post that names none. */
export const BOARD_DEFAULT_TOPIC = 'general';
/** Rules and rulings every member must know: only the main agent, the script and a swarm's lead post in it. */
export const BOARD_ANNOUNCE_TOPIC = 'announce';
/** Distinct topics of one board. A topic is a workstream, not a tag for one post. */
export const BOARD_MAX_TOPICS = 64;
/** Latest posts of each topic the board keeps the seq of, so they are found without reading the feed. */
export const BOARD_TOPIC_RECENT = 8;

export const WORK_MAX_ITEMS = 4096;
export const WORK_MAX_CLAIMS = 8192;
export const WORK_MAX_OPERATIONS = 32_768;
/** Serialized size of all queues of one workflow: items with their inputs, progress and results, claims and operation records. */
export const WORK_MAX_BYTES = 64_000_000;
