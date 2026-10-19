import type { RunState } from '../../runtime/run-state';

export interface WebDisplayConfig {
  show_tools: boolean;
  show_reasoning: boolean;
}

export const WEB_DISPLAY_DEFAULTS: WebDisplayConfig = { show_tools: true, show_reasoning: true };

export function filterWebState(state: RunState, config: WebDisplayConfig): RunState {
  return {
    ...state,
    blocks: config.show_tools ? state.blocks : state.blocks.filter(block => block.kind !== 'tool'),
    reasoning: config.show_reasoning ? state.reasoning : { content: '', active: false },
  };
}
