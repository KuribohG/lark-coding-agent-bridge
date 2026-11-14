import type { KernelContext } from '../kernel-context';
import type { MainTool, ScriptState, ToolArgs } from './types';

/** A main mutation whose response is merged into `{stateVersion}`; an undefined response reports the status. */
export function versioned(apply: (ctx: KernelContext, state: ScriptState, args: ToolArgs, resolved?: unknown) => unknown,
  options: Omit<Extract<MainTool, { kind: 'mutate' }>, 'kind' | 'apply'> = {}): Extract<MainTool, { kind: 'mutate' }> {
  return {
    kind: 'mutate', ...options,
    apply: (ctx, state, args, commit, resolved) => {
      const response = apply(ctx, state, args, resolved);
      return commit(() => ({ stateVersion: state.stateVersion, ...(response as object ?? { status: state.status }) }));
    },
  };
}
