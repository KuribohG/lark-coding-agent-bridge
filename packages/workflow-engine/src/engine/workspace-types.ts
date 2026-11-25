import type { WorkspaceStateView } from './types';

export interface WorkspaceBinding {
  id: string;
  workflowId: string;
  rootDigest: string;
  repository: string;
  commonDir: string;
  path: string;
  baseCommit: string;
  kind: 'task' | 'review' | 'integration';
  /**
   * Absent for a worktree of `repository`, which shares its refs, stash and Git metadata with every other worktree.
   * A clone is a repository of its own at `path` that borrows the objects of `repository`; `repository` and
   * `commonDir` still name the checkout it was made from, where its work is reviewed and landed. An overlay is such
   * a repository whose files are not copied either: `path` is a mount that shows one checkout of the baseline,
   * shared with every overlay made from that commit, under the files this workspace changed.
   */
  isolation?: 'clone' | 'overlay';
  changeId?: string;
  status: 'preparing' | 'ready' | 'removed';
  /** `hostKey` names the hosted worker process that runs here; it keeps the lease while no service is attached to it. */
  busy?: { token: string; taskId?: string; ownerPid: number; hostKey?: string };
}

export interface WorkspaceChange {
  id: string;
  workspaceId: string;
  baseCommit: string;
  headCommit: string;
  tree: string;
  diffDigest: string;
  files: string[];
}

export interface WorkspaceApproval {
  id: string;
  changeId: string;
  taskId: string;
  resultRef: string;
}

export interface WorkspaceChecks {
  id: string;
  workspaceId: string;
  headCommit: string;
  tree: string;
  passed: boolean;
  commands: Array<{ argv: string[]; code: number; stdout: string; stderr: string }>;
}

export interface WorkspaceIntegration {
  workspace: WorkspaceBinding;
  status: 'prepared' | 'conflict';
  approvals: string[];
  remaining: string[];
  targetRef: string;
  expectedHead: string | null;
  headCommit: string;
  conflict?: string;
}

export type WorkspaceCommands = Array<{ argv: string[]; timeoutMs: number }>;

/**
 * How members land work with submit_work: the private branch that collects it and what every landing must pass.
 * Submissions are landed in batches: a train stacks the waiting ones in its own worktree, checks the stack once and
 * advances the branch to it, so the commit that lands is always one the checks passed on.
 */
export interface WorkspaceLanding {
  targetRef: string;
  /** Run on each train, in the train's worktree. */
  commands: WorkspaceCommands;
  /** Run in the member's worktree before its submission may board a train. */
  precheck?: WorkspaceCommands;
  /** Paths a submission may not change, unless it comes from one of the rule's `allow` worktrees. */
  protect?: Array<{ paths: string[]; allow: string[] }>;
  /** Submissions one train carries at most. */
  batch: number;
}

/**
 * What the main agent changed about the landing while the workflow runs (configure_landing). It is kept apart from
 * the script's configuration, so a script that configures the landing again does not undo it: `commands`, `precheck`
 * (empty for none) and `batch` replace the script's, and the `protect` rules are added to the script's.
 */
export interface LandingOverride {
  commands?: WorkspaceCommands;
  precheck?: WorkspaceCommands;
  protect?: NonNullable<WorkspaceLanding['protect']>;
  batch?: number;
}

/**
 * The commit of one repository's landing branch that the landing queue vouches for: the one it last advanced the
 * branch to, or a commit that came from elsewhere and passed the checks afterwards. A branch found anywhere else was
 * moved from outside the queue.
 */
export interface LandingHead {
  targetRef: string;
  head: string;
  /** Where the queue is about to move the branch; a crash between the move and this record leaves the branch here. */
  next?: string;
  /** The outside commit the branch was found at and why the queue does not vouch for it; nothing lands meanwhile. */
  halt?: { head: string | null; reason: string };
}

/** The landing as the main agent sees it. */
export interface LandingView {
  targetRef: string;
  checks: WorkspaceCommands;
  precheck?: WorkspaceCommands;
  protect?: WorkspaceLanding['protect'];
  batch: number;
  /** The settings that come from configure_landing rather than the script. */
  overridden: string[];
  branches: Array<{ repository: string; head: string | null; landed?: string;
    /** Submissions in the queue behind the train that runs now; while the branch is halted they stay there. */
    waiting: number; halted?: string;
    /** The train that runs now: how many submissions it carries, how many runs of the checks it has started, and since when. */
    train?: { submissions: number; step: 'stacking' | 'checking'; checks: number; since: number };
    /** The train failed for a reason of its own (a Git command in its worktree) and runs again with its submissions kept. */
    retrying?: { failures: number; since: number; reason: string } }>;
}

/** A change configure_landing did not make, and why. */
export interface LandingRefusal {
  repository: string;
  headCommit?: string;
  reason: string;
  commands?: WorkspaceChecks['commands'];
}

/** What a configure_landing call did. */
export interface LandingChange {
  /** The landing settings are now different from before the call. */
  changed: boolean;
  /** New commands failed on the landing branch as it is, so the settings were left alone. */
  refused?: LandingRefusal;
  /** What `branch` did in each repository whose branch the queue did not vouch for. */
  settled?: Array<{ repository: string; branch: 'restored' | 'adopted'; head: string; kept?: string }>;
  landing: LandingView;
}

/**
 * A submission that joined the landing queue, which is what its member is answered: it goes on to its next item, and
 * what the queue makes of the commits reaches it through the work item they are for. The commits
 * `targetCommit..headCommit` are the queue's now, by their IDs; the member's worktree was moved back to
 * `targetCommit`, the tip of the landing branch, unless `worktree` says it was `kept` as it stood.
 */
export interface LandSubmitted { targetRef: string; targetCommit: string; headCommit: string; commits: number; worktree: 'reset' | 'kept' }

export type LandReport = (
  /** The branch head now contains the work. With no commits it is what a worktree that had nothing to land is answered. */
  | { status: 'landed'; targetRef: string; headCommit: string; commits: number }
  /** The commits do not apply to `targetCommit`. From the rebase in the member's worktree, which holds them as submitted; from a train, about commits its member no longer has checked out. */
  | { status: 'conflict'; targetRef: string; targetCommit: string; detail: string }
  /** A check failed on the commits on top of `targetCommit`: the precheck in the member's worktree, which holds them, or the checks of a train. */
  | { status: 'check_failed'; targetRef: string; targetCommit: string; headCommit: string; reason?: string; commands: WorkspaceChecks['commands'] }
  /** The commits change protected paths; the worktree is left rebased onto `targetCommit`. */
  | { status: 'rejected'; targetRef: string; targetCommit: string; files: string[]; reason: string }
  /** The branch was moved from outside the queue to a commit it does not vouch for. What a new submission is answered until the main agent settles it; submissions already in the queue wait there. */
  | { status: 'halted'; targetRef: string; targetCommit: string | null; reason: string }
  /** Something the main agent should hear about the branch; submit_work raises it as an event and keeps it from the member. */
) & { notice?: string };

export interface WorkspaceContext {
  state: WorkspaceStateView;
  signal: AbortSignal;
}
