import { leadsAbove, takesTurns } from '../swarm';
import { deferTodo, passTodo } from '../todos';
import type { WorkflowView } from '../types';
import { memberOperation } from './members';
import type { WorkflowToolPlugin } from './types';
import { versioned } from './versioned';

const above = (state: WorkflowView) => (name: string) => leadsAbove(state, name);
const runs = (state: WorkflowView) => (name: string) => takesTurns(state, name);

/** What waits on someone (todos.ts): saying "not now" to a to-do, and handing one to someone else. */
export const todoTools: WorkflowToolPlugin = {
  id: 'todos',
  memberInstructions: 'A to-do is something that waits on you: an ask, or a state of things you answer for. The brief of a swarm member lists them with their ids, and read_context.todos has them at any time. '
    + 'A to-do goes by itself once its cause is gone, and one you leave open goes to whoever stands above you. '
    + 'defer_todo({operationId,id,note,minutes?}) says "not now" and why: the to-do is not put in front of you and does not go up until minutes (1–1440) have passed or, without minutes, for as long as its cause lasts. '
    + 'pass_todo({operationId,id,to,note?}) hands it to another member, which is woken for it, or to "main" when no lead stands above you.',
  tools: [
    {
      name: 'defer_todo',
      main: { doc: 'defer_todo(id,note,minutes?)', ...versioned((ctx, state, args) => deferTodo(state, 'main', args, ctx.now(), above(state)), { appendOnly: true }) },
      worker: { verifiesRoot: true,
        call: (ctx, state, task, _caller, args) => memberOperation(ctx, state, task, 'defer_todo', args, agent => deferTodo(state, agent.key, args, ctx.now(), above(state))) },
    },
    {
      name: 'pass_todo',
      main: { doc: 'pass_todo(id,to,note?)', ...versioned((ctx, state, args) => passTodo(state, 'main', args, ctx.now(), above(state), runs(state)), { appendOnly: true }) },
      worker: { verifiesRoot: true,
        call: (ctx, state, task, _caller, args) => memberOperation(ctx, state, task, 'pass_todo', args, agent => passTodo(state, agent.key, args, ctx.now(), above(state), runs(state))) },
    },
  ],
};
