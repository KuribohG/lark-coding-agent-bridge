import { randomUUID } from 'node:crypto';
import { taskAgent } from '../durable-agents';
import { emit } from '../kernel-store';
import { pushEvent, requireState } from '../kernel-state';
import { boundedInteger, scriptText } from '../script-contract';
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
 * A conversation between the main agent and one worker while its turn runs. The main agent's text enters the
 * worker's session as a user message; the worker may answer each message once, which wakes the main agent.
 */
export const directTools: WorkflowToolPlugin = {
  id: 'direct',
  memberInstructions: '主 agent 可能在你工作途中插入留言（以"[主 agent 留言"开头的用户消息）：按留言调整后继续当前任务。reply_main({text}) 把最多 4000 字符的答复交给主 agent 并唤醒它；每条留言最多回复一次，只在被问到或需要主 agent 决定时使用，没有待回复的留言时调用会被拒绝。',
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
          if (state.status !== 'active' || !RUNNING.includes(task.status)) {
            return { status: 'inactive', ...where, taskStatus: task.status,
              hint: 'No turn of this worker is running. A persistent member reads board posts that name it at its next turn (post_board); a one-off worker cannot be reached.' };
          }
          if (!ctx.host.tell) return { status: 'unsupported', ...where };
          const id = randomUUID();
          const delivery = await ctx.host.tell(state.workflowId, task.taskId, `[主 agent 留言 ${id.slice(0, 8)}]\n${text}\n\n`
            + '（这是工作流主 agent 在你工作途中发来的留言，不是新任务：按它调整后继续当前任务。需要答复时运行 '
            + 'node "$AGENT_WORKFLOW_CLI" workflow reply_main --input \'{"text":"..."}\' --json，每条留言最多回复一次；回复会唤醒主 agent，无需答复就不要调用。）', id);
          if (delivery === 'accepted' || delivery === 'unknown') {
            change(current => record(current, { id, taskId: task.taskId, from: 'main', text, createdAt: ctx.now(), delivery }));
          }
          return { status: delivery, messageId: id, ...where };
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
