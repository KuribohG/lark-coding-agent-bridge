import { LANDING_HALTED, settle } from '../kernel-state';
import type { LandingChange } from '../workspace-types';
import { CONTROL_ARGS } from './control-args';
import type { WorkflowToolPlugin } from './types';

/**
 * The main agent's hold on the landing while the workflow runs. Members land with submit_work (work-queue.ts); what a
 * landing must pass is otherwise fixed by the script, which only runs again on a replay.
 */
export const landingTools: WorkflowToolPlugin = {
  id: 'landing',
  tools: [
    {
      name: 'configure_landing',
      main: {
        kind: 'direct', doc: 'configure_landing(checks?,precheck?,protect?,batch?,reset?,branch?,trains?)',
        run: async (ctx, state, args, change) => {
          if (state.script?.readOnly) throw new Error('Landing configuration is disabled in read-only workflows');
          // The landing is not part of the versioned state: an operationId or version passed out of habit is ignored.
          const input = Object.fromEntries(Object.entries(args).filter(([key]) => !CONTROL_ARGS.includes(key)));
          if (!ctx.host.landing) throw new Error('Landing is unavailable in this workflow');
          // `trains` only reads the ledger, which outlives the workflow.
          if (['completed', 'cancelled', 'cancelling'].includes(state.status) && Object.keys(input).some(key => key !== 'trains')) throw new Error('The workflow has ended; its landing can no longer be changed');
          const result = await ctx.host.landing(ctx.store.workspaceView(state), input) as LandingChange;
          // With no branch halted any more, the notice that one was has nothing left to say.
          if (result.landing?.branches.every(branch => !branch.halted)) change(current => settle(current, LANDING_HALTED, ctx.now()));
          return result;
        },
      },
    },
  ],
};
