import { postToBoard, readBoard, resolvePosts, searchBoard } from '../board';
import { workflowDigest } from '../digest';
import { inheritedWorkerExecution } from '../execution';
import { finishSwarm, staffCleanups, staffSelection, staffSwarm, staffWorkspaces } from '../swarm';
import { memberOperation } from './members';
import { mailboxOperation, taskAgent } from '../durable-agents';
import { mailboxOperationByKey, requiredText, requireState } from '../kernel-state';
import type { WorkerExecution, WorkflowView } from '../types';
import type { ToolArgs, WorkflowToolPlugin } from './types';

const staffing = (args: ToolArgs): ToolArgs => Object.fromEntries(Object.entries(args).filter(([key]) => !CONTROL_ARGS.includes(key)));
import { CONTROL_ARGS } from './control-args';
import { versioned } from './versioned';

/** The shared message board: one ordered, append-only feed that every agent of the workflow can read, and whose posts can be marked resolved. */
export const boardTools: WorkflowToolPlugin = {
  id: 'board',
  memberInstructions: [
    'The board is one ordered, append-only feed that everyone in the workflow can read.',
    'post_board({operationId,text,to?,topic?}) posts up to 4000 characters. to is an array of member names or "all"; @name and @all in the text name members too. '
      + 'A named member is woken and gets the post, with its number, in read_context.member.messages; a post that names nobody wakes nobody. '
      + 'topic is the workstream (1–40 lowercase letters, digits, _ . or -; "general" when left out): keep one name per workstream and reuse the topics that exist, of which a board holds at most 64. '
      + 'Topic "announce" carries rules and rulings that bind every member; only the main agent, the script and the lead of a swarm post there. A post cannot be edited or withdrawn.',
    'read_board({after?,limit?,member?,topic?,resolved?}) returns the latest limit posts (20 by default, 50 at most), or the ones after post number after; member keeps the posts one member sent or received, topic one topic. '
      + 'Resolved posts are skipped (resolvedSkipped counts them) unless resolved: true. topics lists each topic with its posts, its resolved posts and its latest number. '
      + 'Every turn read_context.board already has the announcements since your last turn in full (announcements; moreAnnouncements means that earlier ones are left out, which read_board({topic:"announce"}) returns) '
      + 'and, for each topic, its posts, the resolved ones and the unresolved ones that are new (new). Read the topics that concern your work, not the whole feed.',
    'search_board({query,member?,topic?,limit?}) searches every post: query is up to 8 words separated by spaces, matched as substrings without regard to case, all of which must occur. '
      + 'It returns the latest limit hits (10 by default, 30 at most) with number and snippet; read_board({after: number - 1, limit: 1, resolved: true}) reads one in full. '
      + 'Resolved posts come after the open ones and carry resolved (by, note and see, the post that answered or replaced it). Search before you ask or report something, and instead of paging through a long board.',
    'Post conclusions, questions, hand-offs and blockers, saying who must do what; post no acknowledgements or thanks. Do not post when you finish a work item: the result you give complete_work is the report, which search_work finds. '
      + 'In a swarm with a lead the system hands it to the lead that planned the item and quotes only its first line or two when several come back, '
      + 'so start the result with the conclusion, then say what you did, what you found, where you departed from the item and what still worries you.',
    'resolve_post({operationId,seq,note?,see?,reopen?}) marks posts that need nobody any more (answered, done, or replaced by a newer post) as resolved. seq is a post number or an array of up to 32. '
      + 'Give note (how it ended, at most 500 characters), see (the post that answered or replaced it) or both; reopen: true removes the mark. '
      + 'You may mark your own posts and the ones that name you; a lead and the main agent any post, and announcements only they. A resolved post stays searchable but read_board skips it, and one that reaches you resolved is dealt with already. '
      + 'Mark your question when it is answered and a request when you have done it.',
  ].join('\n'),
  tools: [
    {
      name: 'post_board',
      main: {
        doc: 'post_board(text,to?,topic?)',
        ...versioned((ctx, state, args) => postToBoard(state, { author: 'main' }, args, ctx.now()), { allowInterrupted: true, appendOnly: true }),
      },
      worker: {
        verifiesRoot: true,
        call: (ctx, state, task, _caller, args) => {
          const agent = taskAgent(state, task);
          if (!agent) throw new Error('Posting requires a persistent member; one-off workers can only read the board');
          if (state.status !== 'active' || state.script?.status !== 'running' || ctx.now() >= state.deadlineAt) throw new Error('Workflow is inactive');
          return mailboxOperation(state, 'worker:' + task.taskId + ':' + requiredText(args.operationId, 160), { method: 'post_board', args },
            () => postToBoard(state, { agentId: agent.agentId }, args, ctx.now()));
        },
      },
    },
    {
      name: 'resolve_post',
      main: {
        doc: 'resolve_post(seq,note?,see?,reopen?)',
        ...versioned((ctx, state, args) => resolvePosts(state, { author: 'main' }, args, ctx.now()), { allowInterrupted: true, appendOnly: true }),
      },
      worker: {
        verifiesRoot: true,
        call: (ctx, state, task, _caller, args) => memberOperation(ctx, state, task, 'resolve_post', args, agent => resolvePosts(state, { agentId: agent.agentId }, args, ctx.now())),
      },
    },
    {
      name: 'read_board',
      main: { kind: 'read', doc: 'read_board(after?,limit?,member?,topic?,resolved?)', read: (_ctx, state, args) => readBoard(requireState(state), args) },
      worker: { call: (_ctx, state, _task, _caller, args) => readBoard(state, args) },
    },
    {
      name: 'search_board',
      main: { kind: 'read', doc: 'search_board(query,member?,topic?,limit?)', read: (_ctx, state, args) => searchBoard(requireState(state), staffing(args)) },
      worker: { call: (_ctx, state, _task, _caller, args) => searchBoard(state, args) },
    },
  ],
};

/** Management of a running swarm by its lead. */
export const swarmTools: WorkflowToolPlugin = {
  id: 'swarm',
  leadInstructions: [
    'The next two operations are for the lead of a swarm; from any other member they are refused.',
    'staff_swarm({operationId,add?,like?,workspace?,queue?,role?,brief?,revive?,retire?,cleanup?,maxTurns?}) changes who works in your swarm. add is an array of new member names (1–40 letters, digits, _ . or -). '
      + 'A new member takes the harness, model, role and queue of the member like names (by default the first member that is not the lead); a lead cannot choose another harness or model, so ask the main agent to add the member when one is needed. '
      + 'Its first turn shows it the task, its role and brief. queue makes it consume that work queue, and it then starts when the queue has work it can claim. Add a member before you name it in a post. '
      + 'workspace (true, or {base?,repo?,isolation?}) gives each added member a Git worktree of its own: without repo the cwd of the workflow is the repository and its HEAD the base, and isolation: "clone" makes each a repository of its own that does not share .git. '
      + 'Without workspace the new members run in the root directory, where members that change code in parallel overwrite one another, and they cannot use submit_work. '
      + 'revive ("failed", or an array of names) lets failed members retry their last turn in the session they had. retire (an array of names) lets a member finish the turn it is in and then never wakes it again. '
      + 'cleanup ("retired", or an array of stopped members) deletes their idle worktrees together with whatever was not committed or integrated; the worktree of a failed member can be cleaned at once. '
      + 'maxTurns raises the number of wake-ups every member has. Giving a queue a lead of its own (leads) is for the main agent alone.',
    'swarm_finish({operationId,result}) ends the swarm with the final result (at most 16000 characters): the turns still running finish, the swarm returns, and nobody is woken again.',
    'The system posts to the lead when a member fails and when everyone is idle. The items that members complete, and the ones that fail for good, it gathers into posts in topic "handoff" when the turn of the lead that planned them begins: '
      + 'one item is quoted at length, several get a line or two each, and work_status({key}) has an item in full.',
  ].join('\n'),
  tools: [
    { name: 'staff_swarm',
      main: { doc: 'staff_swarm(swarm?,add?,like?,workspace?,harness?,model?,reasoningEffort?,queue?,leads?,role?,brief?,revive?,retire?,cleanup?,maxTurns?,maxConcurrent?)',
        ...versioned((_ctx, state, args, resolved) => {
          const staffed = resolved as { execution?: WorkerExecution; workspaces?: Record<string, string>; cleanedUp?: Array<{ name: string; workspace: string }> } | undefined;
          return staffSwarm(state, staffing(args), undefined, staffed?.execution, staffed?.workspaces, staffed?.cleanedUp, _ctx.now());
        }, {
          // Staffing is checked against the swarm as it is when the change commits, and no worker commit changes
          // what it checks: a swarm of a hundred members advances the version faster than a status can be read.
          appendOnly: true,
          // Naming a harness, a model or worktrees needs the host: the execution it binds for them is resolved like a
          // script member's, and the worktrees are made or released under the same authorization the change commits under.
          resolve: async (ctx, state, args) => {
            const input = staffing(args);
            const selection = staffSelection(state, input, ctx.host);
            const execution = selection ? await (ctx.host.resolveWorker?.(state.root, selection) ?? inheritedWorkerExecution(state.root, selection)) : undefined;
            const workspaces = await staffWorkspaces(ctx, state, input);
            const cleanedUp = await staffCleanups(ctx, state, input);
            return execution || workspaces || cleanedUp ? { execution, workspaces, cleanedUp } : undefined;
          },
        }) },
      worker: { verifiesRoot: true,
        call: () => { throw new Error('staff_swarm runs outside a transaction'); },
        run: async (ctx, caller, args, bound) => {
          const input = staffing(args);
          // A lead names neither harness nor model and cannot change concurrency; refuse before making worktrees that a
          // rejected change would strand.
          const forbidden = ['harness', 'model', 'reasoningEffort', 'maxConcurrent'].find(option => input[option] !== undefined);
          if (forbidden) throw new Error(forbidden === 'maxConcurrent' ? 'Only the main agent can change maxConcurrent' : 'Only the main agent can choose the harness or model of new members; a lead adds members like an existing one');
          const operationId = requiredText(args.operationId, 160);
          const key = 'worker:' + caller.taskId + ':' + operationId;
          const active = (state: WorkflowView) => {
            if (state.status !== 'active' || state.script?.status !== 'running' || ctx.now() >= state.deadlineAt) throw new Error('Workflow is inactive');
          };
          const digest = workflowDigest({ method: 'staff_swarm', args });
          const first = bound((state, task) => {
            if (!taskAgent(state, task)) throw new Error('This operation requires a persistent member');
            active(state);
            const prior = mailboxOperationByKey(state, key);
            if (prior) {
              if (prior.digest !== digest) throw new Error('Mailbox operation ID conflict');
              return { prior: prior.response } as const;
            }
            return { state } as const;
          });
          if ('prior' in first) return first.prior;
          const workspaces = await staffWorkspaces(ctx, first.state, input);
          const cleanedUp = await staffCleanups(ctx, first.state, input);
          return bound((state, task) => {
            const agent = taskAgent(state, task);
            if (!agent) throw new Error('This operation requires a persistent member');
            active(state);
            return mailboxOperation(state, key, { method: 'staff_swarm', args }, () => staffSwarm(state, input, agent.key, undefined, workspaces, cleanedUp, ctx.now()));
          });
        } } },
    { name: 'swarm_finish', worker: { verifiesRoot: true,
      call: (ctx, state, task, _caller, args) => memberOperation(ctx, state, task, 'swarm_finish', args, agent => finishSwarm(state, agent.key, args)) } },
  ],
};
