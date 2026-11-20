import { randomUUID } from 'node:crypto';
import { postToBoard } from '../board';
import { mailboxOperation, taskAgent } from '../durable-agents';
import { emit } from '../kernel-store';
import { mailboxOperationByKey, pushEvent, requiredText, requireState } from '../kernel-state';
import { boundedInteger, scriptText } from '../script-contract';
import { readsPosts, tellTarget } from '../swarm';
import type { DirectMessage, TaskView, WorkflowView } from '../types';
import type { WorkflowToolPlugin } from './types';

const MAX_MESSAGES = 2048;
const RUNNING = ['starting', 'running'];

function label(state: WorkflowView, task: TaskView): string {
  return taskAgent(state, task)?.key ?? task.scriptKey ?? task.taskId;
}

/** A task by its ID, the member whose turn it is, or the script key that created it (its latest task). */
function target(state: WorkflowView, value: unknown): TaskView {
  const name = scriptText(value, 'target', 200);
  const member = state.agents?.find(agent => agent.key === name);
  const task = state.tasks.find(item => item.taskId === name)
    ?? (member ? state.tasks.find(item => item.taskId === (member.activeTurnId ?? member.lastTurnId)) : undefined)
    ?? state.tasks.filter(item => item.scriptKey === name).at(-1);
  if (!task) throw new Error('Unknown worker: pass a taskId, a member name or a script key');
  return task;
}

function record(state: WorkflowView, message: DirectMessage): void {
  if ((state.direct?.length ?? 0) >= MAX_MESSAGES) throw new Error('Direct message limit reached');
  emit(state, { type: 'direct_message_recorded', taskId: message.taskId, message });
}

/**
 * Leaves on the board, naming the member, a message that could not enter its turn: the member reads it at its next
 * turn, and a swarm member is woken for it. Undefined when no turn will come to read it.
 */
function leave(state: WorkflowView, sender: Parameters<typeof postToBoard>[1], member: string, text: string, now: number): { seq: number } | undefined {
  // The words were meant for one member: an @name in them names nobody else.
  return readsPosts(state, member) ? postToBoard(state, sender, { text, to: [member] }, now, { literal: true }) : undefined;
}

/**
 * Words for one worker, from the main agent or from a lead to a member it leads. They enter the worker's session as
 * a user message while its turn runs; a persistent member that is not in a turn, or whose harness takes no input
 * mid-turn, gets them as a post that names it, so the sender need not know which of the two it is. A worker may
 * answer each message of the main agent once, which wakes the main agent; a lead is answered on the board.
 */
export const directTools: WorkflowToolPlugin = {
  id: 'direct',
  memberInstructions: 'The main agent may put a message into your turn while you work (a user message that begins with "[Message from the main agent"): adjust to it and go on with your task. '
    + 'reply_main({text}) hands the main agent an answer of at most 4000 characters and wakes it. Each message can be answered once, so use it only when you were asked something or the main agent has to decide; it is refused when no message awaits an answer. '
    + 'A lead may put a message into your turn in the same way (it begins with "[Message from lead "): adjust to it and go on, and name the lead in a post when it needs an answer.',
  leadInstructions: 'tell_worker({operationId,target,text}) puts up to 4000 characters into the running turn of a member you lead at once (the answer is accepted). '
    + 'A member that is not in a turn, or cannot take a message in the middle of one, gets a post that names it instead (posted) and reads it at its next turn.',
  tools: [
    {
      name: 'tell_worker',
      main: {
        kind: 'direct', doc: 'tell_worker(target,text)',
        run: async (ctx, state, args, change) => {
          if (Object.keys(args).some(key => !['target', 'text', 'workflowId'].includes(key))) throw new Error('Unsupported tell_worker option');
          const text = scriptText(args.text, 'message', 4000);
          if (!text.trim()) throw new Error('Message text must not be empty');
          const task = target(state, args.target);
          const where = { taskId: task.taskId, worker: label(state, task) };
          const member = taskAgent(state, task)?.key;
          // A one-off worker has no next turn to read a post in.
          const left = () => {
            const post = member === undefined ? undefined : change(current => leave(current, { author: 'main' }, member, text, ctx.now()));
            return post && { status: 'posted', seq: post.seq, ...where, hint: 'No turn of the member could take the message, so it is a board post that names it: the member reads it at its next turn, and a swarm member is woken for it.' };
          };
          if (state.status !== 'active' || !RUNNING.includes(task.status)) {
            return left() ?? { status: 'inactive', ...where, taskStatus: task.status,
              hint: 'No turn of this worker is running, and none will come to read a post: a one-off worker cannot be reached, a stopped member is revived with staff_swarm.' };
          }
          const id = randomUUID();
          const id = randomUUID();
          const session = state.sessions.find(item => item.sessionRef === task.sessionRef);
          const useHostTools = (session ? ctx.host.workerHostTools?.(session, state.root) : undefined) ?? Boolean(ctx.host.hostTools);
          const replyInstruction = useHostTools
            ? 'call workflow_call({method:"reply_main",args:{text:"..."}})'
            : 'run node "$AGENT_WORKFLOW_CLI" workflow reply_main --input \'{"text":"..."}\' --json';
          const delivery = !ctx.host.tell ? 'unsupported' : await ctx.host.tell(state.workflowId, task.taskId, `[Message from the main agent ${id.slice(0, 8)}]\n${text}\n\n`
            + `(The main agent of the workflow sent this while you work. It is not a new task: adjust to it and go on with the task you have. To answer, ${replyInstruction}. Each message can be answered once and the answer wakes the main agent, so do not call it when no answer is needed.)`, id);
          if (delivery === 'accepted' || delivery === 'unknown') {
            change(current => record(current, { id, taskId: task.taskId, from: 'main', text, createdAt: ctx.now(), delivery }));
            return { status: delivery, messageId: id, ...where };
          }
          return left() ?? { status: delivery, ...where };
        },
      },
      worker: {
        verifiesRoot: true,
        call: () => { throw new Error('tell_worker runs outside a transaction'); },
        run: async (ctx, caller, args, bound) => {
          if (Object.keys(args).some(key => !['operationId', 'target', 'text'].includes(key))) throw new Error('Unsupported tell_worker option');
          const text = scriptText(args.text, 'message', 4000);
          if (!text.trim()) throw new Error('Message text must not be empty');
          const key = 'worker:' + caller.taskId + ':' + requiredText(args.operationId, 160);
          const input = { method: 'tell_worker', args };
          const start = bound((state, task) => {
            // A repeated call answers as the first one did, without speaking twice.
            if (mailboxOperationByKey(state, key)) return { prior: mailboxOperation(state, key, input, () => undefined) };
            if (state.status !== 'active' || state.script?.status !== 'running' || ctx.now() >= state.deadlineAt) throw new Error('Workflow is inactive');
            const lead = taskAgent(state, task);
            if (!lead) throw new Error('tell_worker requires a persistent member');
            const to = tellTarget(state, lead.key, args.target);
            const turn = state.tasks.find(item => item.taskId === state.agents?.find(agent => agent.key === to.member)?.activeTurnId);
            const running = turn && RUNNING.includes(turn.status) ? turn.taskId : undefined;
            if (running && (state.direct?.length ?? 0) >= MAX_MESSAGES) throw new Error('Direct message limit reached');
            return { ...to, lead: lead.key, agentId: lead.agentId, workflowId: state.workflowId, taskId: running };
          });
          if ('prior' in start) return start.prior;
          const id = randomUUID();
          const delivery = !start.taskId || !ctx.host.tell ? 'inactive' : await ctx.host.tell(start.workflowId, start.taskId, `[Message from lead ${start.lead} ${id.slice(0, 8)}]\n${text}\n\n`
            + `(${start.lead}, ${start.standing === 'swarm' ? 'the lead of your swarm' : 'the lead of your queue'}, sent this while you work. It is not a new task: adjust to it and go on with the task you have. `
            + `To answer, name ${start.lead} in a post with post_board; do not post when no answer is needed.)`, id);
          // The lead's turn may have ended while the member's transport answered; what was said is then already said.
          return bound(state => mailboxOperation(state, key, input, () => {
            if (delivery === 'accepted' || delivery === 'unknown') {
              record(state, { id, taskId: start.taskId!, from: 'lead', by: start.lead, text, createdAt: ctx.now(), delivery });
              return { status: delivery, messageId: id, member: start.member };
            }
            const post = leave(state, { agentId: start.agentId }, start.member, text, ctx.now());
            return post ? { status: 'posted', seq: post.seq, member: start.member }
              : { status: 'inactive', member: start.member, hint: 'No turn of the member will come to read it: it has stopped or has not started. The swarm lead revives or replaces a stopped member with staff_swarm.' };
          }));
        },
      },
    },
    {
      name: 'worker_messages',
      main: {
        kind: 'read', doc: 'worker_messages(target?,limit?)',
        read: (_ctx, bound, args) => {
          const state = requireState(bound);
          const only = args.target === undefined ? undefined : target(state, args.target).taskId;
          const messages = (state.direct ?? []).filter(message => !only || message.taskId === only);
          return { total: messages.length, messages: messages.slice(-boundedInteger(args.limit, 20, 1, 50)).map(message => {
            const task = state.tasks.find(item => item.taskId === message.taskId);
            return { ...message, worker: task ? label(state, task) : message.taskId };
          }) };
        },
      },
    },
    {
      name: 'reply_main',
      worker: {
        call: (ctx, state, task, _caller, args) => {
          if (Object.keys(args).some(key => !['text', 'operationId'].includes(key))) throw new Error('Unsupported reply_main option');
          const text = scriptText(args.text, 'reply', 4000);
          if (!text.trim()) throw new Error('Reply text must not be empty');
          const mine = (state.direct ?? []).filter(message => message.taskId === task.taskId);
          if (mine.filter(message => message.from === 'worker').length >= mine.filter(message => message.from === 'main').length) {
            throw new Error('reply_main answers a message from the main agent; none is waiting for a reply');
          }
          const id = randomUUID();
          record(state, { id, taskId: task.taskId, from: 'worker', text, createdAt: ctx.now() });
          pushEvent(state, { kind: 'worker_reply', taskId: task.taskId, summary: `${label(state, task)} 回复主 agent：${text.slice(0, 600)}` }, ctx.now);
          return { messageId: id };
        },
      },
    },
  ],
};
