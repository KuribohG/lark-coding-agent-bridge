import { CONTROL_ARGS } from './control-args';
import { LANDING_HALTED, pushEvent, requireState } from '../kernel-state';
import { assigned, closeWorkQueue, completeSubmission, enqueueFromMember, enqueueWork, heldWork, holdClaim, holdSubmission, mutateWork, returnSubmission, submitClaim, trackSubmission, retryWork, searchWork, settleWork, supersededView, updateWork, workItem, workOperation, workStatus, writeOverlaps, WORK_MUTATIONS } from '../work-queue';
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
 * How long a submit_work call waits for what happens in the member's worktree (the rebase, the screening, the
 * precheck) before it answers that this is still going on, in seconds. A precheck may take longer than the time limit
 * a member's shell call has, and a call that is cut off there looks like a failure and costs a turn to work out. Three
 * minutes fits under the limits the agent CLIs give a shell call that names none.
 */
const SUBMIT_WAIT_DEFAULT_S = 180;
const SUBMIT_WAIT_MAX_S = 3600;

/**
 * A submission a member started, from the call that started it to what that call is answered: that the commits have
 * joined the landing queue, or what stopped them in the member's worktree. It runs on whether or not a call waits for
 * it, so the answer is kept: a call that comes back for it reads it, and one that never came back still finds it.
 */
interface Submission {
  operationId: string;
  attemptId: string;
  /** The claim it was made for, as `claimId:generation`. */
  claim?: string;
  since: number;
  answer: Promise<unknown>;
  settled: boolean;
  /** A call has returned the answer. */
  read: boolean;
}
/** The latest submission of each member turn of a kernel; what the queue makes of one later is kept by its work item. */
const submissions = new WeakMap<KernelContext, Map<string, Submission>>();

/**
 * Submits the commits of the member's worktree to the landing queue. The call lasts as long as the worktree is needed:
 * the commits are rebased onto the landing branch, screened and prechecked there, and what fails is the answer, with
 * the claim still the member's. Once the commits have joined the queue the call answers `submitted`, the worktree is
 * back at the tip of the branch, and the member takes its next item.
 *
 * From then on the engine holds the claim of the work item the commits are for; commits submitted for none get an
 * item of their own. When they land it completes the item, as the work of that member. When the queue turns them
 * back it returns the item to the member, with what the queue answered.
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
      // One submission at a time is at work in a worktree: a call made meanwhile waits for it, whatever operationId
      // it names. A repeat of its operationId reads its answer again. So does a call that submits the same claim under
      // another operationId before any call has returned the answer: the member has yet to learn what became of it.
      const joins = last && last.attemptId === caller.attemptId && (!last.settled || last.operationId === operationId || !last.read && !!held && last.claim === held);
      const submission = joins ? last : (() => {
        const start = bound((state, task) => {
          active(ctx, state);
          if (state.script?.readOnly || task.readOnly) throw new Error('Work landing is disabled in read-only workflows');
          const prior = workOperation(state, task, caller.attemptId, operationId);
          if (prior) return { prior: prior.response };
          if (!task.workspaceId) throw new Error('submit_work requires a member that runs in a managed worktree');
          if (!ctx.host.land) throw new Error('Landing is unavailable in this workflow');
          if (claim) holdClaim(state, task, caller.attemptId, claim, ctx.now(), LAND_LEASE_MS);
          else {
            // Commits that complete nothing would leave the item the member is at without its work when the worktree goes back to the branch.
            const at = heldWork(state, task);
            if (at) throw new Error(`You hold work item "${at}": pass its claimId and generation, so that the item is completed when these commits land. `
              + 'Commits are submitted without a claim only by a member that holds no item');
          }
          return { workspace: task.workspaceId, state: ctx.store.workspaceView(state) };
        });
        if ('prior' in start) return { prior: start.prior };
        // The claim the engine holds once the queue has the commits. Until then a claim is the member's, and the
        // submission stops when its turn is gone.
        let engine: Record<string, unknown> | undefined;
        const inState = <T>(change: (state: WorkflowView) => T): T => ctx.store.transact(() => change(requireState(ctx.store.state(caller.scopeId, workflowId))), 'landing:' + caller.taskId);
        const hold = () => engine ? inState(current => { active(ctx, current); holdSubmission(current, engine!, ctx.now()); }) : bound((state, task) => {
          active(ctx, state);
          if (claim) holdClaim(state, task, caller.attemptId, claim, ctx.now(), LAND_LEASE_MS);
        });
        // The precheck and the queue may outlast any lease: keep the claim meanwhile, and stop once nobody holds it.
        const controller = new AbortController();
        const timer = setInterval(() => { try { hold(); } catch (error) { controller.abort(error); } }, LAND_LEASE_MS / 4);
        timer.unref();
        // What the queue found out about the branch is for the main agent; a halted branch says it until it is heard.
        const raise = (notice: string, halted: boolean) => {
          // A halt stands until the main agent restores or adopts the branch, which settles the notice (landing.ts).
          const write = (state: WorkflowView) => {
            if (!state.events.some(event => event.kind === 'landing_attention' && !event.acknowledged && event.summary === notice)) pushEvent(state, { kind: 'landing_attention', summary: notice, ...(halted ? { subject: LANDING_HALTED } : {}) }, ctx.now);
          };
          try { if (engine) inState(write); else bound(write); }
          catch { /* nobody is left to say it through; the next report carries a standing notice again */ }
        };
        let answerWith!: (answer: unknown) => void, failWith!: (error: unknown) => void;
        const answer = new Promise<unknown>((resolve, reject) => { answerWith = resolve; failWith = reject; });
        // The commits join the queue: the engine takes the claim, or adds the item that follows them, and the member
        // is answered. When it cannot (the claim ended meanwhile) this throws, and the commits stay in the worktree.
        const submitted = (info: { targetCommit: string; headCommit: string; commits: number; worktree: string }) => {
          const landing = { targetCommit: info.targetCommit, headCommit: info.headCommit, commits: info.commits };
          const taken = bound((state, task) => claim ? submitClaim(state, task, caller.attemptId, { operationId, ...claim }, ctx.now(), landing, info.worktree)
            : trackSubmission(state, task, caller.attemptId, operationId, ctx.now(), landing, info.worktree));
          engine = taken.claim;
          answerWith(taken.response);
        };
        void (async () => {
          let report;
          try { report = await ctx.host.land!(start.state, { workspace: start.workspace, taskId: caller.taskId, submitted, noticed: (notice: string) => raise(notice, true) }, controller.signal) as { status: string; headCommit?: string; commits?: number; reason?: string; notice?: string }; }
          catch (error) {
            // Before the queue had the commits this is the member's answer. After, the queue gave them up or was
            // closed: the item goes back to its member, unless the service is closing (the restart does that then) or
            // someone ended the claim, which leaves nothing to return.
            if (!engine) failWith(error);
            else if (!ctx.closed) try { inState(current => returnSubmission(current, engine!, ctx.now(), { status: 'failed', reason: error instanceof Error ? error.message : String(error) })); } catch { /* ended meanwhile */ }
            return;
          }
          finally { clearInterval(timer); }
          const { notice, ...rest } = report;
          if (notice) raise(notice, rest.status === 'halted');
          const result = args.result ?? { headCommit: rest.headCommit, commits: rest.commits };
          if (engine) {
            // Nobody waits for this: the item carries it on.
            try {
              if (rest.status === 'landed') inState(current => completeSubmission(current, engine!, result, ctx.now()));
              else inState(current => returnSubmission(current, engine!, ctx.now(), { status: rest.status, reason: rest.reason, report: rest }));
            } catch (error) { ctx.log.warn('workflow.landing.submission_unsettled', { workflowId, taskId: caller.taskId, status: rest.status, error: error instanceof Error ? error.message : String(error) }); }
            return;
          }
          // The commits never joined the queue. A worktree with nothing to land completes the item it was submitted for.
          try { answerWith(rest.status === 'landed' && claim ? { ...rest, item: bound((state, task) => mutateWork(state, task, caller.attemptId, 'complete_work', { operationId, ...claim, result }, ctx.now())) } : rest); }
          catch (error) { failWith(error); }
        })();
        const begun: Submission = { operationId, attemptId: caller.attemptId, ...(held ? { claim: held } : {}), since: Date.now(), answer, settled: false, read: false };
        const settle = () => { begun.settled = true; };
        answer.then(settle, settle);
        book.set(key, begun);
        return begun;
      })();
      // A repeated call reads what its first one was answered: the commits joined the queue, or the item was completed.
      if ('prior' in submission) return (submission.prior as { status?: unknown } | null)?.status === 'submitted' ? submission.prior : { status: 'landed', item: submission.prior };
      let timer: NodeJS.Timeout | undefined;
      // The call that waits does not keep a closing service alive.
      const waited = new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), waitMs); timer.unref(); });
      const answered = await Promise.race([submission.answer.then(value => ({ value }), (error: unknown) => ({ error })), waited]);
      clearTimeout(timer);
      // Nothing is wrong: the worktree is still at the rebase or the precheck, and the same call goes on waiting for it.
      if (!answered) return { status: 'preparing', operationId: submission.operationId, seconds: Math.round((Date.now() - submission.since) / 1000) };
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
    + 'submit_work rebases your commits onto the tip of the landing branch and runs the workflow\'s precheck on them, in your worktree. What fails there is answered at once, as described below, and the item stays yours. '
    + 'Otherwise your commits join the landing queue and the call answers {status:"submitted",key,targetCommit,headCommit,commits,worktree}. You do not wait for the queue, '
    + 'which checks your commits in one batch with those of other members and advances the branch. The item is the queue\'s from then on: do not submit it again, and do not complete, fail or release it. '
    + 'It is completed with result (the landed commit when omitted) when the commits land, and items that wait on it are handed out only then. '
    + 'Your worktree is back at targetCommit, the tip of the landing branch, without the commits you submitted (worktree:"kept" says it could not be moved: run git reset --hard <targetCommit> yourself). '
    + 'Call claim_work for your next item and start it there; do not start work that needs commits that have not landed. '
    + 'The call lasts as long as the rebase and the precheck, and waits for them for up to waitSeconds (180 unless you pass another, at most 3600): give your shell command a time limit a minute longer than that. '
    + 'When they take longer it answers {status:"preparing",operationId,seconds}, and nothing is wrong: call submit_work again with the same operationId, as often as it takes, and leave your worktree as it is meanwhile. '
    + 'A call that was cut off loses nothing either: repeat it with the same operationId. A worktree with nothing to land is answered {status:"landed",commits:0}, which completes the item you named. '
    + 'Without claimId, which is for a member that holds no item, submit_work adds an item for the commits (key in the answer) and they are followed in the same way. '
    + 'Only submit_work advances the landing branch: never commit, update-ref or push to it. '
    + 'The queue checks in a worktree of its own (a train-… directory that git worktree list shows): never run a command in it, not even git status, which locks its index and stops the landing for everyone.',
  'When the queue turns your commits back you are told, and the item is yours again: claim_work hands it to you before other work, with item.landing = {status,reason?,commits,report}. '
    + 'Bring the commits back with git cherry-pick <commits> (a range, base..head), repair what status and report say as described below, commit and submit again with the claim you now hold. '
    + 'status "lost" or "failed" says the queue did not get to check them (the bridge restarted, or the queue gave up for a reason of its own): cherry-pick them and submit again. '
    + 'An item of another member that carries item.landing is taken up the same way, from that member\'s commits.',
  'What turns a landing back. submit_work answers it at once when it happens in your worktree: the claim stays yours and the worktree holds your commits, so repair and submit again with a new operationId, '
    + 'or use release_claim or fail_work when you cannot. From the queue it comes later, in item.landing. '
    + '{status:"conflict",targetCommit,detail}: your commits conflict with what has landed. Rebase onto targetCommit, resolve the conflict and submit again. '
    + 'Do not merge by hand a file that a command generates (a registry, a manifest, an index): take its version from targetCommit, run the command again and commit what it writes. '
    + 'A detail that is a Git lock error such as index.lock is not a conflict in the content: check that no other git process is running and submit again. '
    + '{status:"check_failed",targetCommit,commands,reason?}: a check failed on your commits on top of targetCommit: the precheck in your worktree, which now holds them there, or the checks of the queue. Repair, commit and submit again. '
    + 'If the failure looks unrelated to your change, note your commit (git rev-parse HEAD), check out targetCommit, run the same command and return to your commit. '
    + 'If targetCommit fails by itself the landing branch is broken: do not repair the changes of other members, and do not change a test, a check or an expected output to get past it. '
    + 'Look for a report of it with search_work; if there is none, add one with enqueue_work (the failing command and its output). Keep your commits and submit once the repair has landed. '
    + '{status:"rejected",files,reason}: you changed paths this workflow does not let you change. Remove those changes (deletions and renames too) and submit again; do not work around it. '
    + '{status:"halted",reason}: the landing branch was changed outside the queue and landing is paused; the main agent has been told. Keep your commits and try again at your next turn. '
    + 'Commits that were already in the queue wait there and need nothing from you.',
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
