import { answer, ask, note, resolvePost } from '../asks';
import { readBoard, searchBoard } from '../board';
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
    'The board is one ordered, append-only feed that everyone in the workflow can read. You write to it in three ways.',
    'ask({operationId,to,text,withinMinutes?,topic?}) asks one member for an answer or an action that you wait for: to is its name ("main" is the main agent, for a member with no lead above it), '
      + 'withinMinutes how long you can wait (15 when left out, 1440 at most), text up to 4000 characters that say what you will do with the answer. The ask enters the turn the member is in, or waits in its messages for its next, and is a to-do of the member until it is answered; '
      + 'when your time runs out the to-do goes to those above that member. The answer reaches you in the turn you are in, or wakes you with it in your messages. You may have 8 asks open.',
    'answer({operationId,ask,text}) answers ask number ask: the answer goes to whoever asked and closes the ask in the same step. The member asked, a lead and the main agent may answer; on an ask of your own it withdraws the ask. '
      + 'Answer what is asked of you before other work, and when you cannot answer yet, answer with what it waits on. '
      + 'An ask made of you, and the answer to an ask of yours, may enter your turn while you work, as a user message that begins with "[Ask " or "[Answer to your ask ": it is not a new task; do as it says and go on.',
    'note({operationId,text,topic?}) records up to 4000 characters for others to read: conclusions, what you ruled out, what others should know. It names nobody and wakes nobody; those it concerns read it in its topic. '
      + 'topic is the workstream (1–40 lowercase letters, digits, _ . or -; "general" when left out): reuse the topics that exist, of which a board holds at most 64. '
      + 'Topic "announce" carries rulings that bind every member; only the main agent, the script and the lead of a swarm write there. A post cannot be edited or withdrawn. '
      + 'Note no acknowledgements or thanks, and do not note that you finished a work item: the result you give complete_work is the report.',
    'read_board({after?,limit?,member?,topic?,resolved?}) returns the latest limit posts (20 by default, 50 at most), or the ones after post number after; member keeps the posts one member sent or received, topic one topic. '
      + 'Resolved posts are skipped (resolvedSkipped counts them) unless resolved: true, and topics lists each topic with its posts, its resolved posts and its latest number. '
      + 'read_context.board has the rulings since your last turn and, for each topic, how many posts are new. Read the topics that concern your work, not the whole feed.',
    'search_board({query,member?,topic?,limit?}) searches every post: query is up to 8 words separated by spaces, matched as substrings without regard to case, all of which must occur. '
      + 'It returns the latest limit hits (10 by default, 30 at most) with number and snippet; read_board({after: number - 1, limit: 1, resolved: true}) reads one in full. '
      + 'Resolved posts come after the open ones and carry how they ended. Search before you ask or note something, and instead of paging through a long board.',
    'resolve_post({operationId,seq,note?,see?,reopen?}) marks posts that need nobody any more (dealt with, or replaced by a newer post) as resolved. seq is a post number or an array of up to 32; '
      + 'give note (how it ended, at most 500 characters), see (the post that replaced it) or both; reopen: true removes the mark. '
      + 'You may mark your own posts; a lead and the main agent any post, and announcements only the lead of the swarm and the main agent. A resolved post stays searchable but read_board skips it.',
  ].join('\n'),
  tools: [
    {
      name: 'ask',
      main: { doc: 'ask(to,text,withinMinutes?,topic?)', ...versioned((ctx, state, args) => ask(state, { author: 'main' }, args, ctx.now()), { allowInterrupted: true, appendOnly: true }) },
      worker: { verifiesRoot: true,
        call: (ctx, state, task, _caller, args) => memberOperation(ctx, state, task, 'ask', args, agent => ask(state, { agentId: agent.agentId }, args, ctx.now())) },
    },
    {
      name: 'answer',
      main: { doc: 'answer(ask,text)', ...versioned((ctx, state, args) => answer(state, { author: 'main' }, args, ctx.now()), { allowInterrupted: true, appendOnly: true }) },
      worker: { verifiesRoot: true,
        call: (ctx, state, task, _caller, args) => memberOperation(ctx, state, task, 'answer', args, agent => answer(state, { agentId: agent.agentId }, args, ctx.now())) },
    },
    {
      name: 'note',
      main: { doc: 'note(text,topic?)', ...versioned((ctx, state, args) => note(state, { author: 'main' }, args, ctx.now()), { allowInterrupted: true, appendOnly: true }) },
      worker: { verifiesRoot: true,
        call: (ctx, state, task, _caller, args) => memberOperation(ctx, state, task, 'note', args, agent => note(state, { agentId: agent.agentId }, args, ctx.now())) },
    },
    {
      name: 'resolve_post',
      main: {
        doc: 'resolve_post(seq,note?,see?,reopen?)',
        ...versioned((ctx, state, args) => resolvePost(state, { author: 'main' }, args, ctx.now()), { allowInterrupted: true, appendOnly: true }),
      },
      worker: {
        verifiesRoot: true,
        call: (ctx, state, task, _caller, args) => memberOperation(ctx, state, task, 'resolve_post', args, agent => resolvePost(state, { agentId: agent.agentId }, args, ctx.now())),
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
    'staff_swarm({operationId,add?,like?,workspace?,queue?,role?,brief?,move?,revive?,retire?,cleanup?,maxTurns?}) changes who works in your swarm. add is an array of new member names (1–40 letters, digits, _ . or -). '
      + 'A new member takes the harness, model, role and queue of the member like names (by default the first member that is not a lead); a lead cannot choose another harness or model, so ask the main agent to add the member when one is needed. '
      + 'Its first turn shows it the task, its role and brief. queue makes it consume that work queue, and it then starts when the queue has work it can claim. '
      + 'workspace (true, or {base?,repo?,isolation?}) gives each added member a Git worktree of its own: without repo the cwd of the workflow is the repository and its HEAD the base, and isolation: "clone" makes each a repository of its own that does not share .git. '
      + 'Without workspace the new members run in the root directory, where members that change code in parallel overwrite one another, and they cannot use submit_work. '
      + 'move (an array of names, with queue) makes members that consume one queue consume queue instead, for when one queue has more work than members and another has members without work: '
      + 'a member finishes the item it holds and takes its next from the new queue, where it is woken when there is work to claim, and its next turn tells it of the move; role, when given, replaces the role of the members moved. '
      + 'unconsumed in the answer names a queue that lost its last member while it still holds unfinished items. '
      + 'revive ("failed", or an array of names) lets failed members retry their last turn in the session they had. retire (an array of names) lets a member finish the turn it is in and then never wakes it again. '
      + 'cleanup ("retired", or an array of stopped members) deletes their idle worktrees together with whatever was not committed or integrated; the worktree of a failed member can be cleaned at once. '
      + 'maxTurns raises the number of wake-ups every member has. Giving a part of the work a lead of its own (leads, under) is for the main agent alone.',
    'swarm_finish({operationId,result}) ends the swarm with the final result (at most 16000 characters): the turns still running finish, the swarm returns, and nobody is woken again.',
  ].join('\n'),
  tools: [
    { name: 'staff_swarm',
      main: { doc: 'staff_swarm(swarm?,add?,like?,workspace?,harness?,model?,reasoningEffort?,queue?,leads?,under?,role?,brief?,move?,revive?,retire?,cleanup?,maxTurns?,maxConcurrent?)',
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
            if (state.script?.readOnly && input.workspace !== undefined && input.workspace !== false) {
              throw new Error('Workspace operations are disabled in read-only workflows');
            }
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
            if (state.script?.readOnly && input.workspace !== undefined && input.workspace !== false) {
              throw new Error('Workspace operations are disabled in read-only workflows');
            }
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
