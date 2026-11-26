import { CONTROL_ARGS } from './control-args';
import { LANDING_HALTED, pushEvent, requireState } from '../kernel-state';
import { assigned, closeWorkQueue, completeSubmission, enqueueFromMember, enqueueWork, holdClaim, holdSubmission, mutateWork, returnSubmission, submitClaim, retryWork, searchWork, settleWork, supersededView, updateWork, workItem, workOperation, workStatus, writeOverlaps, WORK_MUTATIONS } from '../work-queue';
import { queueName } from '../work-routing';
import { boundedInteger, scriptText } from '../script-contract';
import { workAuthority } from '../swarm';
import { memberOperation } from './members';
import type { ToolArgs, WorkflowTool, WorkflowToolPlugin } from './types';
import type { KernelContext } from '../kernel-context';
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
 * what became of the items it replaced, and, when it names the paths it will change, the unfinished items that expect
 * to change the same ones. The script's enqueueWork answers with the item alone, so that a replay reads what the first
 * run read.
 */
function enqueued(state: WorkflowView, response: unknown): unknown {
  const item = workItem(state, (response as { itemId: string }).itemId);
  return item ? { ...response as object, queue: item.queue ?? 'default', ...(item.gate ? { gate: true } : {}), ...assigned(state, item), ...supersededView(state, item), ...writeOverlaps(state, item) } : response;
}

function active(ctx: { now(): number }, state: WorkflowView): void {
  if (state.status !== 'active' || state.script?.status !== 'running' || ctx.now() >= state.deadlineAt) throw new Error('Workflow is inactive');
}

const LAND_LEASE_MS = 120_000;
/**
 * How long a submit_work call waits for its landing before it answers that the submission is still in the queue, in
 * seconds. A landing takes as long as the trains ahead of it; a member's shell call has a time limit of its own, and a
 * call that is cut off there looks like a failure and costs a turn to work out. Three minutes fits under the limits
 * the agent CLIs give a shell call that names none.
 */
const SUBMIT_WAIT_DEFAULT_S = 180;
const SUBMIT_WAIT_MAX_S = 3600;

/**
 * A landing a member asked for, from the call that started it to the answer it has been given. It runs on whether or
 * not a call waits for it, so the answer is kept: a call that comes back for it reads it, and one that never came
 * back while it ran still finds it.
 */
interface Submission {
  operationId: string;
  attemptId: string;
  /** The claim it completes when it lands, as `claimId:generation`. */
  claim?: string;
  workspace: string;
  state: ReturnType<KernelContext['store']['workspaceView']>;
  since: number;
  answer: Promise<unknown>;
  /** Settles with the answer for a member that goes on without waiting, once the landing queue holds its item. */
  handed: Promise<unknown>;
  settled: boolean;
  /** A call has returned the answer. */
  read: boolean;
}
/** The latest submission of each member turn of a kernel; held in memory like the landing queue itself. */
const submissions = new WeakMap<KernelContext, Map<string, Submission>>();

/**
 * Lands the commits of the member's worktree and, when it holds a claim, completes that work item with the landing.
 * A rejected landing leaves the claim with the member, who repairs the worktree and submits again.
 *
 * Where the landing is `async`, a submission that names a claim is the member's only until it has joined the queue:
 * the claim passes to the engine, the call answers `submitted` and the member takes its next item. The engine
 * completes the item when the commits land and returns it to the member when the queue turns them back.
 */
const submitWork: WorkflowTool = {
  name: 'submit_work',
  worker: {
    verifiesRoot: true,
    prepare: (ctx, state) => ctx.scheduler.expireClaims(state),
    call: () => { throw new Error('submit_work runs outside a transaction'); },
    run: async (ctx, caller, args, bound) => {
      if (Object.keys(args).some(key => !['operationId', 'claimId', 'generation', 'result', 'waitSeconds'].includes(key))) throw new Error('Unsupported submit_work option');
      const operationId = scriptText(args.operationId, 'operationId', 160);
      const claim = args.claimId === undefined ? undefined : { claimId: args.claimId, generation: args.generation };
      if (!claim && args.result !== undefined) throw new Error('result belongs to a claimed work item; pass claimId and generation');
      const waitMs = boundedInteger(args.waitSeconds, SUBMIT_WAIT_DEFAULT_S, 0, SUBMIT_WAIT_MAX_S) * 1000;
      const workflowId = bound(state => { active(ctx, state); return state.workflowId; });
      const book = submissions.get(ctx) ?? new Map<string, Submission>(); submissions.set(ctx, book);
      const key = `${workflowId}:${caller.taskId}`, last = book.get(key), held = claim && `${String(claim.claimId)}:${String(claim.generation)}`;
      // One landing at a time in a worktree: a call made while it runs waits for it, whatever operationId it names.
      // A repeat of its operationId reads its answer again. So does a call that submits the same claim under another
      // operationId before any call has returned the answer: the member has yet to learn what became of that item.
      const joins = last && last.attemptId === caller.attemptId && (!last.settled || last.operationId === operationId || !last.read && !!held && last.claim === held);
      const submission = joins ? last : (() => {
        const start = bound((state, task) => {
          active(ctx, state);
          if (state.script?.readOnly || task.readOnly) throw new Error('Work landing is disabled in read-only workflows');
          const prior = claim && workOperation(state, task, caller.attemptId, operationId);
          if (prior) return { prior: prior.response };
          if (!task.workspaceId) throw new Error('submit_work requires a member that runs in a managed worktree');
          if (!ctx.host.land) throw new Error('Landing is unavailable in this workflow');
          if (claim) holdClaim(state, task, caller.attemptId, claim, ctx.now(), LAND_LEASE_MS);
          return { workspace: task.workspaceId, state: ctx.store.workspaceView(state) };
        });
        if ('prior' in start) return { prior: start.prior };
        // Until the landing queue holds the item the claim is the member's, and the landing stops when its turn is gone.
        let engine = false;
        const inState = <T>(change: (state: WorkflowView) => T): T => ctx.store.transact(() => change(requireState(ctx.store.state(caller.scopeId, workflowId))), 'landing:' + caller.taskId);
        const hold = () => engine ? inState(current => { active(ctx, current); holdSubmission(current, claim!, ctx.now()); }) : bound((state, task) => {
          active(ctx, state);
          if (claim) holdClaim(state, task, caller.attemptId, claim, ctx.now(), LAND_LEASE_MS);
        });
        // Checks may outlast any lease: keep the claim while they run, and stop landing once nobody holds it any more.
        const controller = new AbortController();
        const timer = setInterval(() => { try { hold(); } catch (error) { controller.abort(error); } }, LAND_LEASE_MS / 4);
        timer.unref();
        let hand!: (answer: unknown) => void;
        const handed = new Promise<unknown>(resolve => { hand = resolve; });
        // The submission joined an async queue: the claim passes to the engine and the member is answered at once.
        const submitted = claim && ((info: { targetCommit: string; headCommit: string; commits: number; worktree: string }) => {
          try {
            const answered = bound((state, task) => submitClaim(state, task, caller.attemptId, { operationId, ...claim }, ctx.now(),
              { targetCommit: info.targetCommit, headCommit: info.headCommit, commits: info.commits }, info.worktree));
            engine = true;
            if (book.get(key) === begun) book.delete(key);
            hand(answered);
          } catch (error) {
            // The worktree may have been moved already: say where the commits are.
            controller.abort(new Error(`The landing queue could not take the item over (${error instanceof Error ? error.message : String(error)}). `
              + `Your commits are ${info.targetCommit}..${info.headCommit}${info.worktree === 'reset' ? `, and your worktree was moved back to ${info.targetCommit}: git cherry-pick brings them back` : ''}`));
          }
        });
        const answer = (async () => {
          let report;
          try { report = await ctx.host.land!(start.state, { workspace: start.workspace, taskId: caller.taskId, ...(submitted ? { submitted } : {}) }, controller.signal) as { status: string; headCommit?: string; commits?: number; reason?: string }; }
          catch (error) {
            // The queue gave the submission up, or was closed. A claim the engine holds goes back to its member; when
            // the service is closing the restart does that, and a claim that someone ended has nothing left to return.
            if (engine && !ctx.closed) try { inState(current => returnSubmission(current, claim!, ctx.now(), { status: 'failed', reason: error instanceof Error ? error.message : String(error) })); } catch { /* ended meanwhile */ }
            throw error;
          }
          finally { clearInterval(timer); }
          // What the landing queue found out about the branch is for the main agent; a halted branch says it until it is heard.
          const { notice, ...rest } = report as typeof report & { notice?: string };
          const halted = rest.status === 'halted';
          if (notice) {
            // A halt stands until the main agent restores or adopts the branch, which settles the notice (landing.ts).
            const raise = (state: WorkflowView) => {
              if (!state.events.some(event => event.kind === 'landing_attention' && !event.acknowledged && event.summary === notice)) pushEvent(state, { kind: 'landing_attention', summary: notice, ...(halted ? { subject: LANDING_HALTED } : {}) }, ctx.now);
            };
            try { if (engine) inState(raise); else bound(raise); }
            catch { /* the member's turn is gone; the next report carries a standing notice again */ }
          }
          report = rest;
          const result = args.result ?? { headCommit: report.headCommit, commits: report.commits };
          if (engine) {
            // Nobody waits for this answer: the item itself carries it on.
            try {
              return report.status === 'landed' ? { ...report, item: inState(current => completeSubmission(current, claim!, result, ctx.now())) }
                : (inState(current => returnSubmission(current, claim!, ctx.now(), { status: report.status, reason: report.reason, report })), report);
            } catch (error) { ctx.log.warn('workflow.landing.submission_unsettled', { workflowId, taskId: caller.taskId, status: report.status, error: error instanceof Error ? error.message : String(error) }); return report; }
          }
          if (report.status !== 'landed' || !claim) return report;
          const item = bound((state, task) => mutateWork(state, task, caller.attemptId, 'complete_work', { operationId, ...claim, result }, ctx.now()));
          return { ...report, item };
        })();
        const begun: Submission = { operationId, attemptId: caller.attemptId, ...(held ? { claim: held } : {}), workspace: start.workspace, state: start.state, since: Date.now(), answer, handed, settled: false, read: false };
        const settle = () => { begun.settled = true; };
        answer.then(settle, settle);
        book.set(key, begun);
        return begun;
      })();
      // A repeated call reads what its first one was answered: the item completed, or handed to the landing queue.
      if ('prior' in submission) return (submission.prior as { status?: unknown } | null)?.status === 'submitted' ? submission.prior : { status: 'landed', item: submission.prior };
      let timer: NodeJS.Timeout | undefined;
      // The call that waits does not keep a closing service alive.
      const waited = new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), waitMs); timer.unref(); });
      const answered = await Promise.race([submission.answer.then(value => ({ value }), (error: unknown) => ({ error })), submission.handed.then(value => ({ value })), waited]);
      clearTimeout(timer);
      if (!answered) {
        // Nothing is wrong: the submission is where `stage` says, and the same call goes on waiting for it.
        const progress = ctx.host.landProgress?.(submission.state, { workspace: submission.workspace, taskId: caller.taskId }) as object | undefined;
        return { status: 'queued', operationId: submission.operationId, ...(progress ?? { stage: 'preparing', seconds: Math.round((Date.now() - submission.since) / 1000) }) };
      }
      submission.read = true;
      if ('error' in answered) throw answered.error;
      // An answer to an earlier call says which submission it is about.
      return submission.operationId === operationId ? answered.value : { ...answered.value as object, operationId: submission.operationId };
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
    + 'release_claim({operationId,claimId,generation,reason,waitFor?}) hands it back as it is; waitFor: [keys] names the items it has to wait for, and it is handed out again once they are completed. '
    + 'Only fail_work, and a turn of yours that broke off, count against the attempts an item has: handing an item back, or losing it to a restart, does not. input, progress and result hold at most 16000 characters each. '
    + 'item.writeOverlaps lists the unfinished items that expect to change the same paths with nothing to order them (member says who holds one): ask that member who changes what before you start. '
    + 'item.neededBy lists the items that wait on yours and are handed out when you complete it: when yours is a check and it did not pass, end it with fail_work and say why, not with complete_work. '
    + 'Losing a claim does not undo what you changed outside the workflow: check what has already happened and make a repeat harmless.',
  'Landing code: when you run in a managed worktree and your system prompt names a Landing branch, deliver code with submit_work({operationId,claimId?,generation?,result?,waitSeconds?}). '
    + 'Commit first, and put the key of the item in the commit message: a problem later found in that code is then reported with your item as its origin and comes back to you. '
    + 'submit_work rebases your commits onto the tip of the landing branch, checks them in one batch with the commits of other members that are waiting, advances the branch and, given claimId and generation, '
    + 'completes the item with result (the landed commit when omitted). It returns {status:"landed",headCommit,commits,item} and leaves your worktree at the tip of the branch, with what others have landed: start the next item there. '
    + 'The call waits for the landing for up to waitSeconds (180 unless you pass another, at most 3600): give your shell command a time limit a minute longer than that. '
    + 'When the landing takes longer the call answers {status:"queued",operationId,stage,seconds,position?,waiting?,train?,retrying?}, and nothing is wrong: '
    + 'stage is preparing (your commits are being rebased and prechecked in your worktree), waiting (in the queue; position 1 boards the next batch) or on_train (in the batch that is being checked now). '
    + 'Call submit_work again with the same operationId to go on waiting, as often as it takes. Until you have the answer leave your worktree as it is, without a commit, rebase or reset, and do not go looking for the queue. '
    + 'retrying means the queue itself failed and runs again with your submission kept: it needs nothing from you. '
    + 'The answer is kept until you have read it, so a call that was cut off loses nothing: repeat it with the same operationId. Only submit_work advances the landing branch: never commit, update-ref or push to it. '
    + 'The batch is checked in a worktree of the queue\'s own (a train-… directory that git worktree list shows): never run a command in it, not even git status, which locks its index and stops the landing for everyone.',
  'Going on without the answer: a workflow may let its members hand their commits to the queue and take the next item. A submit_work that names claimId is then answered '
    + '{status:"submitted",key,targetCommit,headCommit,commits,worktree} as soon as your commits have passed what is checked in your worktree and joined the queue; '
    + 'a conflict, a rejection and a failed precheck are still answered at once, as described below. The item is the queue\'s from then on: do not wait for it, do not submit it again, and do not complete, fail or release it. '
    + 'Your worktree is back at targetCommit, the tip of the landing branch, without those commits (worktree:"kept" says it could not be moved: run git reset --hard <targetCommit> yourself). '
    + 'Call claim_work for your next item and start it there. The item completes by itself when the commits land, and items that wait on it are handed out only then: do not start work that needs commits that have not landed. '
    + 'When the queue turns the commits back you are told, and the item is yours again: claim_work hands it to you before other work, with item.landing = {status,reason?,commits,report}. '
    + 'Bring the commits back with git cherry-pick <commits> (a range, base..head), repair what status and report say as described below, commit and submit again. '
    + 'status "lost" or "failed" says the queue did not get to check them: cherry-pick them and submit again. An item of another member that carries item.landing is taken up the same way, from that member\'s commits.',
  'When a landing is turned back the claim stays yours while you repair: submit again with a new operationId, or use release_claim or fail_work when you cannot. '
    + '{status:"conflict",targetCommit,detail}: your commits conflict with what has landed. Rebase onto targetCommit, resolve the conflict and submit again. '
    + 'Do not merge by hand a file that a command generates (a registry, a manifest, an index): take its version from targetCommit, run the command again and commit what it writes. '
    + 'A detail that is a Git lock error such as index.lock is not a conflict in the content: check that no other git process is running and submit again. '
    + '{status:"check_failed",targetCommit,commands,reason?}: a check failed on your commits on top of targetCommit, which is what your worktree now holds. Repair, commit and submit again. '
    + 'If the failure looks unrelated to your change, note your commit (git rev-parse HEAD), check out targetCommit, run the same command and return to your commit. '
    + 'If targetCommit fails by itself the landing branch is broken: do not repair the changes of other members, and do not change a test, a check or an expected output to get past it. '
    + 'Look for a report of it with search_work; if there is none, add one with enqueue_work (the failing command and its output). Keep your commits and submit once the repair has landed. '
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
  'Changing work you added: while nobody has claimed it, update_work({operationId,key or itemId,title?,input?,writes?,resources?}) amends what an item of yours asks for, cancel: true with reason withdraws it, '
    + 'and supersededBy: key replaces it by that item, so that what waited on it waits on that one. Everything else about an item is changed by whoever plans its queue.',
  'Repeats and restarts: an operationId is unique within the current attempt of your turn, and repeating a call with the same content returns its first answer. In a new attempt, after a turn was cut short, you may claim again; a claimId and generation that expired can no longer be submitted. '
    + 'A turn that a bridge restart interrupted keeps its claim: go on with the same claimId and generation (the claim in your work queue context) instead of claiming again. After claim_work returned null, ask again with a new operationId.',
].join('\n');

const LEAD_INSTRUCTIONS = 'Changing items: you plan the queues you lead (the lead of a swarm, every queue). '
  + 'update_work({operationId,key or itemId,title?,input?,writes?,resources?,priority?,hold?,assignee?,dependsOn?,supersededBy?,cancel?,reason?}) changes an unfinished item: '
  + 'title, input, writes and resources amend what it asks for while nobody has claimed it (revision counts the amendments); '
  + 'priority moves it in the order, assignee gives it to one member or, with null, back to the whole queue, dependsOn replaces what it waits on, and cancel: true withdraws it with reason; '
  + 'blocks in the answer are the items that depended on it and can no longer be claimed. A claimed item is neither amended nor cancelled: tell_worker has its member stop and hand it back, or supersededBy replaces it. '
  + 'supersededBy: key replaces the item by another one instead: what waited on it waits on that one, and the item is withdrawn (one that a member holds, when its claim ends; tell_worker stops that member now). '
  + 'enqueue_work with supersedes: [keys] adds the replacement and does this in one call. Revise a plan this way: do not add new keys and keep the old ones on hold. '
  + 'hold: true sets an item aside by your decision and needs reason (what for, and what would bring it back); false returns it. Do not hold an item to make it wait: name what it waits for in dependsOn. '
  + 'What it waits for is an item or, when nobody in the workflow does it (an event outside, a decision, a release), a gate: enqueue_work({key,title,input,gate:true}) adds a condition that nobody claims, '
  + 'and settle_work({operationId,key or itemId,result}) declares it met, with what was established as result; the items that named it are then handed out by themselves, and the answer lists them. '
  + 'settle_work likewise ends the wait for an unclaimed item whose work was done some other way. An item on hold with nothing else in its way, one that waits on an item that was cancelled or failed, '
  + 'a gate nobody has declared met and an item that keeps coming back without progress are to-dos of whoever planned them. '
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
        doc: 'enqueue_work(key,title,input,queue?,priority?,dependsOn?,resources?,writes?,origin?,assignee?,maxAttempts?,gate?,supersedes?)',
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
          return enqueued(state, enqueueFromMember(state, task, args, ctx.now(), member => workAuthority(state, member)));
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
      main: { doc: 'update_work(itemId 或 key,title?,input?,writes?,resources?,priority?,hold?,assignee?,dependsOn?,supersededBy?,cancel?,reason?)', ...versioned((ctx, state, args) => updateWork(state, operationInput(args), ctx.now()), { allowInterrupted: true, appendOnly: true }) },
      worker: { verifiesRoot: true,
        call: (ctx, state, task, _caller, args) => memberOperation(ctx, state, task, 'update_work', args, agent => updateWork(state, operationInput(args), ctx.now(), workAuthority(state, agent.key), agent.key)) },
    },
    {
      name: 'settle_work',
      // Declares one unclaimed item done; like a withdrawal, it is checked against the item as it stands when it commits.
      main: { doc: 'settle_work(itemId 或 key,result)', ...versioned((ctx, state, args) => settleWork(state, operationInput(args), ctx.now()), { allowInterrupted: true, appendOnly: true }) },
      worker: { verifiesRoot: true,
        call: (ctx, state, task, _caller, args) => memberOperation(ctx, state, task, 'settle_work', args, agent => settleWork(state, operationInput(args), ctx.now(), workAuthority(state, agent.key), agent.key)) },
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
