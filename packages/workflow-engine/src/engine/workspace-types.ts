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
   * `commonDir` still name the checkout it was made from, where its work is reviewed and landed. A wsfs workspace
   * is a worktree of `repository` like the first, whose files are not written: `path` is a directory of a mount
   * that shows the commit as it is read from the object database, under the files the workspace changed.
   */
  isolation?: 'clone' | 'wsfs';
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
    /**
     * The train that runs now: how many submissions it carries, how many runs of the checks it has started, and since
     * when. `front` says it carries the submissions that were put at the head of the queue (expedite_work), and nothing else.
     */
    train?: { submissions: number; step: 'stacking' | 'checking' | 'landing'; checks: number; since: number; front?: true };
    /** The train failed for a reason of its own (a Git command in its worktree) and runs again with its submissions kept. */
    retrying?: { failures: number; since: number; reason: string };
    /** How long a run of the checks that passed has usually taken lately, in seconds; compare it with the checks' `timeoutMs`. */
    usualCheckSeconds?: number;
    /** The latest trains of the landing ledger, newest first, in short; `configure_landing({trains})` reads them in full. */
    recent?: Array<{ since: number; seconds: number; submissions: number; landed: number; outcome: LandingTrain['outcome'];
      /** Each run of the checks: on the stack of how many submissions, for how long, and whether it passed. */
      checks: Array<{ submissions: number; seconds: number; passed: boolean; slow?: true }>;
      /** The submissions the train answered without landing them. */
      turnedBack?: Array<{ key?: string; member?: string; status: string }> }>;
  }>;
}

/**
 * One run of a train, as the landing ledger keeps it: what it carried, every run of the checks, and what became of
 * each submission. A train that ran no check and answered nobody (it waited for a halted branch, or failed at once
 * and runs again) is not written down.
 */
export interface LandingTrain {
  repository: string;
  since: number;
  ms: number;
  /** The branch head the submissions were stacked on, and where the train moved the branch when any of them landed. */
  base: string | null;
  head?: string;
  /**
   * The submissions the train took from the queue, in the order it stacked them. `outcome` is the status each was
   * answered with (`landed`, `check_failed`, `conflict`, `withdrawn`), `failed` when the train gave it up, or `next`
   * when it went back to the queue for the next train. `front` is who put one at the head of the queue and why.
   */
  submissions: Array<{ key?: string; member?: string; workspace: string; headCommit: string; commits: number; outcome: string; front?: string }>;
  /**
   * Every run of the checks, in the order they ran: `submissions` says how many of the stacked submissions the commit
   * under test held, `slow` that it ran far longer than usual, `command` and `code` which command failed, and `reason`
   * what else was wrong (the checks left files behind, or the run was stopped).
   */
  checks: Array<{ submissions: number; headCommit: string; ms: number; passed: boolean; slow?: true; command?: string; code?: number; reason?: string }>;
  /**
   * `done` when the train answered its submissions or sent them on to the next one; `restacked` when it stopped to run
   * again without a submission that was withdrawn; `preempted` when it stopped for a submission that was put at the
   * head of the queue, and runs again after the train that carries that one; `halted` and `retrying` when it kept them
   * for a branch that has to be settled or for a failure of its own; `failed` when it gave them up.
   */
  outcome: 'done' | 'restacked' | 'preempted' | 'halted' | 'retrying' | 'failed';
  error?: string;
}

/** A submission in the landing queue, as someone who watches the queue is shown it. */
export interface LandingRider extends LandLabel {
  workspace: string;
  headCommit: string;
  commits: number;
  /** When it joined the queue; one that rides another train keeps the time it first joined. */
  since: number;
  /** Who put it at the head of the queue and why (expedite_work); the others have none. */
  front?: string;
}

/**
 * The landing queue of one repository as it stands. The queue lives in the memory of the service, which writes this
 * to the workspace store whenever the queue changes, so that a reader outside it (the dashboard) can show what waits
 * and what the train is doing. `waiting` are the submissions behind the train, in the order they board: the ones
 * that were put at the head of the queue first, which ride a train of their own. `train` is the train that runs: the
 * submissions it took, in order (`taken` until their commits are in what the checks run on, `stacked` from then on,
 * and the status one was answered with after that), the runs of the checks so far, and the run that is going on.
 * `halted` is what the main agent was told of a branch the queue waits for.
 */
export interface LandingLive {
  repository: string;
  /** When this was written. */
  at: number;
  waiting: LandingRider[];
  train?: {
    since: number;
    step: 'stacking' | 'checking' | 'landing';
    base?: string | null;
    riders: Array<LandingRider & { state: string }>;
    checks: LandingTrain['checks'];
    /** The run of the checks that is going on: on the stack after how many submissions, and since when. */
    checking?: { submissions: number; since: number };
  };
  retrying?: { failures: number; since: number; reason: string };
  halted?: string;
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
  /** The latest trains of the landing ledger, newest first, as many as `trains` asked for. */
  trains?: LandingTrain[];
}

/** What a submission is for and whose it is, as the ledger and the notices to the main agent name it. */
export interface LandLabel { key?: string; member?: string }

/**
 * What became of a request to take a submission out of the landing queue. `withdrawn`: it left the queue, and a train
 * that carried it runs again without it. `landing`: its train has passed the checks and is moving the branch, so the
 * commits land. `absent`: the queue does not hold it, because it has been answered already.
 */
export type LandWithdrawal = 'withdrawn' | 'landing' | 'absent';

/**
 * What became of a request to put a submission at the head of the landing queue. `expedited`: it boards ahead of the
 * others, on a train of its own, and a train that carried it with others runs again after that one. `landing`: its
 * train has passed the checks and is moving the branch, so the commits land as it is. `absent`: the queue does not
 * hold it, because it has been answered already or was never submitted.
 */
export type LandExpedite = 'expedited' | 'landing' | 'absent';

/**
 * Where claim_work left the worktree of the member that claimed an item. `commits`: on the commits the landing queue
 * turned back for the item, as they were submitted. `tip`: at the tip of the landing branch. `kept`: where it stood,
 * because moving it would have lost something; `note` says what. `headCommit` is where the worktree stands.
 */
export interface LandPosition { worktree: 'tip' | 'commits' | 'kept'; headCommit: string; note?: string }

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
  /** The commits do not apply to `targetCommit`. At submit_work the member's worktree holds them as submitted; from a train they are the item's, and claim_work puts them back into a worktree. */
  | { status: 'conflict'; targetRef: string; targetCommit: string; detail: string }
  /** A check failed on the commits on top of `targetCommit`: the precheck in the member's worktree, which holds them, or the checks of a train. */
  | { status: 'check_failed'; targetRef: string; targetCommit: string; headCommit: string; reason?: string; commands: WorkspaceChecks['commands'] }
  /** The commits change protected paths; the worktree holds them as submitted. */
  | { status: 'rejected'; targetRef: string; targetCommit: string; files: string[]; reason: string }
  /** The branch was moved from outside the queue to a commit it does not vouch for. What a new submission is answered until the main agent settles it; submissions already in the queue wait there. */
  | { status: 'halted'; targetRef: string; targetCommit: string | null; reason: string }
  /** The commits were taken out of the queue before they landed (withdraw_work); `reason` says by whom and why. */
  | { status: 'withdrawn'; targetRef: string; targetCommit: string; headCommit: string; reason: string }
  /** Something the main agent should hear about the branch; submit_work raises it as an event and keeps it from the member. */
) & { notice?: string };

export interface WorkspaceContext {
  state: WorkspaceStateView;
  signal: AbortSignal;
}
