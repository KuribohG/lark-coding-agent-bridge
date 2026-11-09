import type { RunState } from '../../runtime/run-state';
import type { WebDisplayConfig } from '../../config/channel-display';

export function filterWebState(state: RunState, config: WebDisplayConfig): RunState {
  return {
    ...state,
    blocks: config.show_tools ? state.blocks : state.blocks.filter(block => block.kind !== 'tool'),
    reasoning: config.show_reasoning ? state.reasoning : { content: '', active: false },
  };
}
