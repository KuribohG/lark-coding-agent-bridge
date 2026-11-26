/**
 * Ceilings on what one workflow may hold. They bound memory and journal growth and catch runaway scripts; they are
 * not the budget of a run. A workflow asks for the agents and concurrency it needs (`maxAgents`, `maxConcurrent`)
 * and gets small defaults otherwise. Sized for several hundred workers running at once in one workflow tree; how many
 * tasks a workflow runs over its lifetime is not limited here.
 */

/** Workers one workflow tree may run at once; `maxConcurrent` asks for up to this many. */
export const MAX_CONCURRENT_WORKERS = 512;
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

/** Durable members of one workflow, across all its swarms and discussions. Retired members stay in this count. */
export const MAX_WORKFLOW_MEMBERS = 2048;
/** Members a swarm may be declared with, the lead included. */
export const SWARM_DECLARED_MEMBERS = 512;
/**
 * Members a swarm may hold at once: declared, added by the lead, and not retired or failed. A long-running swarm
 * replaces members as they fail or finish; the live count, not the churn history, decides whether it can take more.
 */
export const SWARM_MAX_LIVE_MEMBERS = 512;
/**
 * Members a swarm may ever hold: declared, added by the lead, and since retired or failed. Bounds the member records
 * one swarm keeps in the workflow state, so retiring and replacing members does not grow it without limit.
 */
export const SWARM_MAX_MEMBERS = 2048;
/**
 * Ceiling of a swarm's `maxTurns`: wake-ups of one member other than the lead. Completed turns are archived, so this
 * does not bound state; it stops members that keep waking each other.
 */
export const SWARM_MAX_TURNS = 4096;
/** Member names one board post, or one quiet wait, may list. */
export const MAX_NAMED_MEMBERS = 512;

export const MAX_WAITS = 2048;
export const MAX_CONTROL_OPERATIONS = 2048;
export const MAX_WORKSPACE_KEYS = 4096;
/** Managed worktrees of one workflow: one for each swarm member that lands its own work, plus review and integration ones. */
export const MAX_WORKSPACES = 1024;
/** Workspace records of one workflow: worktrees, frozen changes, approvals, checks and the operations that made them. */
export const MAX_WORKSPACE_RECORDS = 16_384;
/**
 * New worktrees whose files are written at once. Git registers a worktree in a few steps, so registration stays
 * serialized per repository; writing the checked-out files is the expensive part and runs in this many slots.
 */
export const WORKSPACE_CHECKOUT_SLOTS = 64;
/**
 * How long a landing train waits before each run it repeats after a failure of its own (a Git command that failed in
 * its worktree), with its submissions kept in the queue. A lock another process holds there is released within
 * minutes; after the last wait the submissions get the failure back.
 */
export const TRAIN_RETRY_DELAYS_MS: readonly number[] = [5_000, 15_000, 45_000, 120_000, 300_000, 300_000, 300_000];
/**
 * A lock file in the train's own Git directory that is this old was left by a process that is gone: a shell call a
 * member started without a time limit of its own is stopped after ten minutes, and that leaves the lock behind.
 */
export const TRAIN_STALE_LOCK_MS = 600_000;

export const MAILBOX_MAX_MESSAGES = 4096;
export const MAILBOX_MAX_OPERATIONS = 8192;
export const MAILBOX_MAX_RECEIPTS = 2048;

export const BOARD_MAX_DELIVERIES = 32_768;
/** The topic of a post that names none. */
export const BOARD_DEFAULT_TOPIC = 'general';
/** Rules and rulings every member must know: only the main agent, the script and a swarm's lead post in it. */
export const BOARD_ANNOUNCE_TOPIC = 'announce';
/**
 * What members saw while working that the plan does not account for. They post it naming nobody, so that it wakes
 * nobody and does not become work until a lead has held it against the goal at its review.
 */
export const BOARD_NOTICED_TOPIC = 'noticed';
/** The longest delay a wake-up may ask for (wake_me, of a member and of the main agent). */
export const WAKE_MAX_MINUTES = 24 * 60;
/** Outcomes of work items a swarm keeps for its leads' next turns; past this many the newest are left to the items themselves. */
export const SWARM_MAX_RESULTS = 1024;
/** Distinct topics of one board. A topic is a workstream, not a tag for one post. */
export const BOARD_MAX_TOPICS = 64;
/** Latest posts of each topic the board keeps the seq of, so they are found without reading the feed. */
export const BOARD_TOPIC_RECENT = 8;
/** Asks that may be open at once, on the board and from one asker: an ask is for what its author waits on, not for every post. */
export const BOARD_MAX_ASKS = 128;
export const BOARD_MAX_ASKS_EACH = 8;
/**
 * Asks and answers that enter a running turn (turn-mail.ts): how many at once, how long after the last time, and how
 * many in one turn. Each takes the member's attention off its task, so what is beyond these waits for its next turn.
 */
export const TURN_MAIL_BATCH = 4;
export const TURN_MAIL_GAP_MS = 5_000;
export const TURN_MAIL_PER_TURN = 16;
/** Characters of one post quoted in a running turn; read_board has the rest. */
export const TURN_MAIL_TEXT = 2000;

export const WORK_MAX_ITEMS = 4096;
export const WORK_MAX_CLAIMS = 8192;
export const WORK_MAX_OPERATIONS = 32_768;
/** Serialized size of all queues of one workflow: items with their inputs, progress and results, claims and operation records. */
export const WORK_MAX_BYTES = 64_000_000;
/** The flow of a work queue is kept in slots this long, for this many of them (six hours). */
export const WORK_FLOW_SLOT_MS = 10 * 60_000;
export const WORK_FLOW_SLOTS = 36;
