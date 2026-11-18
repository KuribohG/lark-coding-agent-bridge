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
        kind: 'direct', doc: 'configure_landing(checks?,precheck?,protect?,batch?,reset?,branch?)',
        run: async (ctx, state, args) => {
          // The landing is not part of the versioned state: an operationId or version passed out of habit is ignored.
          const input = Object.fromEntries(Object.entries(args).filter(([key]) => !CONTROL_ARGS.includes(key)));
          if (!ctx.host.landing) throw new Error('Landing is unavailable in this workflow');
          if (['completed', 'cancelled', 'cancelling'].includes(state.status) && Object.keys(input).length) throw new Error('The workflow has ended; its landing can no longer be changed');
          return ctx.host.landing(ctx.store.public(state), input);
        },
      },
    },
  ],
};
