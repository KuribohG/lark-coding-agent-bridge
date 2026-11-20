import { CHARTER_MAX_TEXT, WAKE_MAX_MINUTES, setCharter, setMainWake } from '../steering';
import { setMemberTimer } from '../swarm';
import { memberOperation } from './members';
import type { WorkflowToolPlugin } from './types';
import { versioned } from './versioned';

/** Keeping long-running work on course: the charter that carries the current goal, and wake-ups that do not depend on a post. */
export const steeringTools: WorkflowToolPlugin = {
  id: 'steering',
  memberInstructions: [
    'The charter is the goal, the priorities and the standing rules of the workflow as they stand now. The prompt of every turn carries the current version (read_context has it in charter, where changed says that it was replaced since your last turn); '
      + 'where it differs from the request, the task or earlier announcements, the charter wins. Only the main agent and the lead of a swarm can change it.',
    `wake_me({operationId,afterMinutes,note?}) wakes a swarm member for one turn after afterMinutes minutes (1–${WAKE_MAX_MINUTES}) without anyone naming it. To wait for a long build, test or queue, or to check on something later, `
      + 'save a checkpoint, set it and end the turn; do not hold the turn polling or sleeping. A member has one timer: calling again replaces it, and afterMinutes 0 cancels it. '
      + 'It stays set when a post or new work wakes you earlier, and it counts as a wake-up like being named.',
  ].join('\n'),
  leadInstructions: `set_charter({operationId,text}), for the lead of a swarm, replaces the whole charter (at most ${CHARTER_MAX_TEXT} characters) with the goal, completion criteria that can be checked, the priorities, what is out of scope and how results are measured. `
    + 'When the direction, the priorities or the measures change, change the charter instead of only announcing it.',
  tools: [
    {
      name: 'set_charter',
      main: { doc: 'set_charter(text)', ...versioned((ctx, state, args) => setCharter(state, args, 'main', ctx.now()), { allowInterrupted: true, appendOnly: true }) },
      worker: { verifiesRoot: true,
        call: (ctx, state, task, _caller, args) => memberOperation(ctx, state, task, 'set_charter', args, agent => setCharter(state, args, agent.key, ctx.now())) },
    },
    {
      name: 'wake_me',
      main: { doc: 'wake_me(afterMinutes?,everyMinutes?,note?)', ...versioned((ctx, state, args) => setMainWake(state, args, ctx.now()), { appendOnly: true }) },
      worker: { verifiesRoot: true,
        call: (ctx, state, task, _caller, args) => memberOperation(ctx, state, task, 'wake_me', args, agent => setMemberTimer(state, agent.key, args, ctx.now())) },
    },
  ],
};
