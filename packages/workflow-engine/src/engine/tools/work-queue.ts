import { CONTROL_ARGS } from './control-args';
import { pushEvent, requireState } from '../kernel-state';
import { assigned, closeWorkQueue, enqueueFromMember, enqueueWork, holdClaim, mutateWork, retryWork, searchWork, updateWork, workItem, workOperation, workStatus, writeOverlaps, WORK_MUTATIONS } from '../work-queue';
import { queueName } from '../work-routing';
import { scriptText } from '../script-contract';
import { workAuthority } from '../swarm';
import { memberOperation } from './members';
import type { ToolArgs, WorkflowTool, WorkflowToolPlugin } from './types';
import type { WorkflowView } from '../types';
import { versioned } from './versioned';

function operationInput(args: ToolArgs): ToolArgs {
  return Object.fromEntries(Object.entries(args).filter(([key]) => !CONTROL_ARGS.includes(key)));
}

/** Claims, leases and progress of a persistent member's work item. */
const claimTools: WorkflowTool[] = WORK_MUTATIONS.map(name => ({
  name,
  worker: {
    verifiesRoot: true,
    prepare: (ctx, state) => ctx.scheduler.expireClaims(state),
    call: (ctx, state, task, caller, args) => {
      active(ctx, state);
      return mutateWork(state, task, caller.attemptId, name, args, ctx.now());
    },
  },
}));

/**
 * What enqueue_work answers: the item, the queue it went to and the member it is for, which `origin` may have chosen,
 * and, when it names the paths it will change, the unfinished items that expect to change the same ones. The script's
 * enqueueWork answers with the item alone, so that a replay reads what the first run read.
 */
function enqueued(state: WorkflowView, response: unknown): unknown {
  const item = workItem(state, (response as { itemId: string }).itemId);
  return item ? { ...response as object, queue: item.queue ?? 'default', ...assigned(state, item), ...writeOverlaps(state, item) } : response;
}

function active(ctx: { now(): number }, state: WorkflowView): void {
  if (state.status !== 'active' || state.script?.status !== 'running' || ctx.now() >= state.deadlineAt) throw new Error('Workflow is inactive');
}

const LAND_LEASE_MS = 120_000;

/**
 * Lands the commits of the member's worktree and, when it holds a claim, completes that work item with the landing.
 * A rejected landing leaves the claim with the member, who repairs the worktree and submits again.
 */
const submitWork: WorkflowTool = {
  name: 'submit_work',
  worker: {
    verifiesRoot: true,
    prepare: (ctx, state) => ctx.scheduler.expireClaims(state),
    call: () => { throw new Error('submit_work runs outside a transaction'); },
    run: async (ctx, caller, args, bound) => {
      if (Object.keys(args).some(key => !['operationId', 'claimId', 'generation', 'result'].includes(key))) throw new Error('Unsupported submit_work option');
      const operationId = scriptText(args.operationId, 'operationId', 160);
      const claim = args.claimId === undefined ? undefined : { claimId: args.claimId, generation: args.generation };
      if (!claim && args.result !== undefined) throw new Error('result belongs to a claimed work item; pass claimId and generation');
      const hold = () => bound((state, task) => {
        active(ctx, state);
        if (claim) holdClaim(state, task, caller.attemptId, claim, ctx.now(), LAND_LEASE_MS);
      });
      const start = bound((state, task) => {
        active(ctx, state);
        const prior = claim && workOperation(state, task, caller.attemptId, operationId);
        if (prior) return { prior: prior.response };
        if (!task.workspaceId) throw new Error('submit_work requires a member that runs in a managed worktree');
        if (!ctx.host.land) throw new Error('Landing is unavailable in this workflow');
        if (claim) holdClaim(state, task, caller.attemptId, claim, ctx.now(), LAND_LEASE_MS);
        return { workspace: task.workspaceId, state: ctx.store.public(state) };
      });
      if ('prior' in start) return { status: 'landed', item: start.prior };
      // Checks may outlast any lease: keep the claim while they run, and stop landing once the member's turn is gone.
      const controller = new AbortController();
      const timer = setInterval(() => { try { hold(); } catch (error) { controller.abort(error); } }, LAND_LEASE_MS / 4);
      timer.unref();
      let report;
      try { report = await ctx.host.land!(start.state, { workspace: start.workspace, taskId: caller.taskId }, controller.signal) as { status: string; headCommit?: string; commits?: number }; }
      finally { clearInterval(timer); }
      // What the landing queue found out about the branch is for the main agent; a halted branch says it until it is heard.
      const { notice, ...rest } = report as typeof report & { notice?: string };
      if (notice) {
        try {
          bound(state => {
            if (!state.events.some(event => event.kind === 'landing_attention' && !event.acknowledged && event.summary === notice)) pushEvent(state, { kind: 'landing_attention', summary: notice }, ctx.now);
          });
        } catch { /* the member's turn is gone; the next report carries a standing notice again */ }
      }
      report = rest;
      if (report.status !== 'landed' || !claim) return report;
      const item = bound((state, task) => mutateWork(state, task, caller.attemptId, 'complete_work',
        { operationId, ...claim, result: args.result ?? { headCommit: report.headCommit, commits: report.commits } }, ctx.now()));
      return { ...report, item };
    },
  },
};

/**
 * What a member is told about the queue, in the order it meets it: taking an item, doing it, landing it and what to
 * do when a landing is turned back; then adding, finding and changing items, and what a repeated call does.
 */
const MEMBER_INSTRUCTIONS = [
  'Work queue. Work comes as items; you hold one at a time, and the progress you save on an item outlives your turn.',
  'Taking an item: claim_work({operationId,leaseMs?,queue?}) claims one item atomically and returns {claimId,generation,leaseUntil,item}, or null when there is none for you: then end the turn and do not wait for work. '
    + 'A swarm member that consumes a queue claims from that queue only and omits queue; any other member claims from "default" unless it names one. '
    + 'Items that are for you (item.assignee is your name) come first. item.origin, when set, is the key of the delivered item this one is about, which work_status({key}) reads. '
    + 'The bridge keeps your claim while your turn runs; you cannot renew it. When the turn ends, is cancelled or is stopped after a long silence, an unfinished claim returns to the queue with the progress you saved.',
  'Doing it: read item.progress first, which holds what an earlier attempt saved. checkpoint_work({operationId,claimId,generation,expectedProgressVersion,state}) saves progress as JSON; '
    + 'complete_work({operationId,claimId,generation,result}) finishes the item; fail_work({operationId,claimId,generation,error,retry?}) gives it up (retry: true only when another attempt could succeed); '
    + 'release_claim({operationId,claimId,generation,reason}) hands it back as it is. input, progress and result hold at most 16000 characters each. '
    + 'item.writeOverlaps lists the unfinished items that expect to change the same paths with nothing to order them (member says who holds one): agree on the board who changes what before you start. '
    + 'Losing a claim does not undo what you changed outside the workflow: check what has already happened and make a repeat harmless.',
  'Landing code: when you run in a managed worktree and your system prompt names a Landing branch, deliver code with submit_work({operationId,claimId?,generation?,result?}). '
    + 'Commit first, and put the key of the item in the commit message: a problem later found in that code is then reported with your item as its origin and comes back to you. '
    + 'submit_work rebases your commits onto the tip of the landing branch, checks them in one batch with the commits of other members that are waiting, advances the branch and, given claimId and generation, '
    + 'completes the item with result (the landed commit when omitted). It returns {status:"landed",headCommit,commits,item} and leaves your worktree at the tip of the branch, with what others have landed: start the next item there. '
    + 'The call blocks until the batch has been checked; if your command times out, repeat it with the same operationId to rejoin the same landing. Only submit_work advances the landing branch: never commit, update-ref or push to it.',
  'When a landing is turned back the claim stays yours while you repair: submit again with a new operationId, or use release_claim or fail_work when you cannot. '
    + '{status:"conflict",targetCommit,detail}: your commits conflict with what has landed. Rebase onto targetCommit, resolve the conflict and submit again. '
    + 'Do not merge by hand a file that a command generates (a registry, a manifest, an index): take its version from targetCommit, run the command again and commit what it writes. '
    + 'A detail that is a Git lock error such as index.lock is not a conflict in the content: check that no other git process is running and submit again. '
    + '{status:"check_failed",targetCommit,commands,reason?}: a check failed on your commits on top of targetCommit, which is what your worktree now holds. Repair, commit and submit again. '
    + 'If the failure looks unrelated to your change, note your commit (git rev-parse HEAD), check out targetCommit, run the same command and return to your commit. '
    + 'If targetCommit fails by itself the landing branch is broken: do not repair the changes of other members, and do not change a test, a check or an expected output to get past it. '
    + 'Look for a report of it with search_work; if there is none, add one with enqueue_work (the failing command and its output) and name the lead in a post. Keep your commits and submit once the repair has landed. '
    + '{status:"rejected",files,reason}: you changed paths this workflow does not let you change. Remove those changes (deletions and renames too) and submit again; do not work around it. '
    + '{status:"halted",reason}: the landing branch was changed outside the queue and landing is paused; the main agent has been told. Keep your commits and try again at your next turn.',
  'Adding work: enqueue_work({key,title,input,origin?,assignee?,queue?,priority?,dependsOn?,resources?,writes?,maxAttempts?}) adds work that someone has to do: '
    + 'a part split off an item that is too large, a problem you found, or the next batch when the queue is empty and the goal is not met. '
    + 'Before you add an item, and before you investigate a problem, look with search_work for its symptom, module or test name: someone may have reported it under another key, and then you use that result or go on from it. '
    + 'key is a stable name for the problem itself (bug-<module>-<symptom>); when it exists nothing is added and the answer is {itemId,key,existing:true,status}. '
    + 'title says it in one sentence; input gives the symptom, how to reproduce it and what is known. '
    + 'origin is the key of the item whose delivered result the new item is about (the commit that made the change names it, and search_work shows in doneBy who completed an item): '
    + 'the new item goes to the queue of that item and to the member that completed it, which is woken for it and gets it before other work. assignee names the member yourself. '
    + 'The answer gives queue and assignee; an assigneeNote in it says that this member cannot take the item (it has stopped, has no wake-ups left or does not consume that queue), so that any member of the queue claims it. '
    + 'Without origin the item goes to the queue you consume ("default" when you consume none) unless queue names another; only queues that exist and are open take items. '
    + 'priority (-100..100) puts an item ahead of lower ones; dependsOn lists keys of items that must all be completed first; items that share a key in resources are claimed one at a time. '
    + 'writes lists up to 16 paths the item expects to change and locks nothing: the answer and work_status({key}) report in writeOverlaps the unfinished items whose paths overlap, which you order with dependsOn or split apart.',
  'Finding work: work_status({itemId or key}) reads one item in full; work_status({queue?,offset?,limit?}) pages through items (16 by default, 64 at most). '
    + 'search_work({query,queue?,status?,limit?}) searches every item, finished ones too: query is up to 8 words separated by spaces, matched as substrings without regard to case in key, title, input, result and error, all of which must occur. '
    + 'Hits in key or title come first, then the most recently changed; it returns limit hits (10 by default, 30 at most) with itemId, status, doneBy and a snippet.',
  'Withdrawing work: update_work({operationId,key or itemId,cancel:true,reason?}) withdraws an item that you added and nobody has claimed. Everything else about an item is changed by whoever plans its queue.',
  'Repeats and restarts: an operationId is unique within the current attempt of your turn, and repeating a call with the same content returns its first answer. In a new attempt, after a turn was cut short, you may claim again; a claimId and generation that expired can no longer be submitted. '
    + 'A turn that a bridge restart interrupted keeps its claim: go on with the same claimId and generation (the claim in your work queue context) instead of claiming again. After claim_work returned null, ask again with a new operationId.',
].join('\n');

const LEAD_INSTRUCTIONS = 'Changing items: you plan the queues you lead (the lead of a swarm, every queue). update_work({operationId,key or itemId,priority?,hold?,assignee?,cancel?,reason?}) changes an unfinished item: '
  + 'priority moves it in the order, hold: true sets it aside without removing it and false returns it, assignee gives it to one member or, with null, back to the whole queue, and cancel: true withdraws it with reason; '
  + 'blocks in the answer are the items that depended on it and can no longer be claimed. A claimed item cannot be cancelled: ask its member in a post to stop and hand it back, and cancel it once it is back in the queue. '
  + 'retry_work({operationId,key or itemId,additionalAttempts?}) gives a failed item more attempts (1 by default, 8 at most) and returns it to the queue.';

/** Durable work queues: the main agent produces and inspects items; persistent members claim and finish them. */
export const workQueueTools: WorkflowToolPlugin = {
  id: 'work-queue',
  memberInstructions: MEMBER_INSTRUCTIONS,
  leadInstructions: LEAD_INSTRUCTIONS,
  tools: [
    {
      name: 'enqueue_work',
      main: {
        doc: 'enqueue_work(key,title,input,queue?,priority?,dependsOn?,resources?,writes?,origin?,assignee?,maxAttempts?)',
        ...versioned((ctx, state, args) => {
          ctx.scripts.checkWorkKey(state, args.key);
          return enqueued(state, enqueueWork(state, operationInput(args), ctx.now()));
        }, { allowInterrupted: true, appendOnly: true }),
      },
      worker: {
        verifiesRoot: true,
        call: (ctx, state, task, _caller, args) => {
          active(ctx, state);
          ctx.scripts.checkWorkKey(state, args.key);
          return enqueued(state, enqueueFromMember(state, task, args, ctx.now()));
        },
      },
    },
    {
      name: 'retry_work',
      // Giving a failed item more attempts conflicts with nothing a worker or the scheduler commits meanwhile.
      main: { doc: 'retry_work(itemId 或 key,additionalAttempts?)', ...versioned((ctx, state, args) => retryWork(state, operationInput(args), ctx.now()), { allowInterrupted: true, appendOnly: true }) },
      worker: { verifiesRoot: true,
        call: (ctx, state, task, _caller, args) => memberOperation(ctx, state, task, 'retry_work', args, agent => retryWork(state, operationInput(args), ctx.now(), workAuthority(state, agent.key))) },
    },
    {
      name: 'update_work',
      // A new priority, a hold or a withdrawal changes one item; whichever of two such changes commits last stands.
      main: { doc: 'update_work(itemId 或 key,priority?,hold?,assignee?,cancel?,reason?)', ...versioned((ctx, state, args) => updateWork(state, operationInput(args), ctx.now()), { allowInterrupted: true, appendOnly: true }) },
      worker: { verifiesRoot: true,
        call: (ctx, state, task, _caller, args) => memberOperation(ctx, state, task, 'update_work', args, agent => updateWork(state, operationInput(args), ctx.now(), workAuthority(state, agent.key), agent.key)) },
    },
    {
      name: 'close_work_queue',
      main: {
        doc: 'close_work_queue(queue?)',
        ...versioned((ctx, state, args) => {
          if (Object.keys(args).some(key => ![...CONTROL_ARGS, 'queue'].includes(key))) throw new Error('Unsupported close_work_queue option');
          return closeWorkQueue(state, ctx.now(), queueName(args.queue));
        }, { allowInterrupted: true }),
      },
    },
    {
      name: 'work_status',
      main: { kind: 'read', doc: 'work_status(itemId? 或 key? 或 queue?,offset?,limit?)',
        read: (ctx, state, args) => workStatus(requireState(state), { itemId: args.itemId, offset: args.offset, limit: args.limit, ...(args.key !== undefined ? { key: args.key } : {}), ...(args.queue !== undefined ? { queue: args.queue } : {}) }, ctx.now()) },
      worker: { call: (ctx, state, _task, _caller, args) => workStatus(state, args, ctx.now()) },
    },
    {
      name: 'search_work',
      main: { kind: 'read', doc: 'search_work(query,queue?,status?,limit?)', read: (_ctx, state, args) => searchWork(requireState(state), operationInput(args)) },
      worker: { call: (_ctx, state, _task, _caller, args) => searchWork(state, args) },
    },
    ...claimTools,
    submitWork,
  ],
};
