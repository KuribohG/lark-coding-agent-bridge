import { WAKE_MAX_MINUTES } from '../limits';
import { STATUS_MAX_TEXT, setGoal, setMainWake, setStatus } from '../steering';
import { setMemberTimer } from '../swarm';
import { memberOperation } from './members';
import type { WorkflowToolPlugin } from './types';
import { versioned } from './versioned';

/** Keeping long-running work on course: the goal, the status notes of the leads, and wake-ups that nothing else brings about. */
export const steeringTools: WorkflowToolPlugin = {
  id: 'steering',
  memberInstructions: [
    'The prompt of every turn carries the goal in force, when the main agent has set one, and the status notes of the leads you work under (read_context has both). The goal says what is wanted and how to tell that it is met; '
      + 'where it differs from the request, the task or earlier rulings, the goal wins, and only the main agent changes it. A status says how the work stands: how far off the goal is, what is being tried, what was ruled out and the priorities.',
    `wake_me({operationId,afterMinutes,note?}) wakes a swarm member for one turn after afterMinutes minutes (1–${WAKE_MAX_MINUTES}) without anyone asking for it. To wait for a long build, test or queue, or to check on something later, `
      + 'save a checkpoint, set it and end the turn; do not hold the turn polling or sleeping. A member has one timer: calling again replaces it, and afterMinutes 0 cancels it. '
      + 'It stays set when something else wakes you earlier, and it counts as a wake-up.',
  ].join('\n'),
  leadInstructions: `set_status({operationId,text}) replaces your status note (at most ${STATUS_MAX_TEXT} characters): how far off the goal your part is now by its test, what is being tried, what was ruled out and where the evidence is, `
    + 'what is not known yet that would change the plan, the priorities, and what each part that has a lead of its own must deliver. The members that work under you are given it at every turn, and writing it wakes nobody. '
    + 'It does not change the goal: when results show that the goal cannot be met as stated or is not what is wanted, ask whoever stands above you.',
  tools: [
    {
      name: 'set_goal',
      main: { doc: 'set_goal(text)', ...versioned((ctx, state, args) => setGoal(state, args, ctx.now()), { allowInterrupted: true, appendOnly: true }) },
    },
    {
      name: 'set_status',
      worker: { verifiesRoot: true,
        call: (ctx, state, task, _caller, args) => memberOperation(ctx, state, task, 'set_status', args, agent => setStatus(state, agent.key, args, ctx.now())) },
    },
    {
      name: 'wake_me',
      main: { doc: 'wake_me(afterMinutes?,everyMinutes?,note?)', ...versioned((ctx, state, args) => setMainWake(state, args, ctx.now()), { appendOnly: true }) },
      worker: { verifiesRoot: true,
        call: (ctx, state, task, _caller, args) => memberOperation(ctx, state, task, 'wake_me', args, agent => setMemberTimer(state, agent.key, args, ctx.now())) },
    },
  ],
};
