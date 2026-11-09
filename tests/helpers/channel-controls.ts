import type { BtwCommandControl, ChannelControls } from '../../src/commands/types';

const noBtw: BtwCommandControl = {
  enqueue: async () => {},
  excludes: () => false,
  reset: () => {},
  cancel: () => {},
};

/** Inert channel controls; tests override the members they observe. */
export function fakeChannelControls(overrides: Partial<ChannelControls> = {}): ChannelControls {
  return {
    workflow: () => undefined,
    btw: noBtw,
    cancelPendingInput: () => 0,
    flushPendingInput: async () => {},
    pausePendingInput: () => {},
    resumePendingInput: () => {},
    detachPendingInput: () => {},
    reloadPendingInput: async () => {},
    launchTimedRun: async () => {},
    cancelTimedRun: () => {},
    activeTimedRun: () => undefined,
    meeting: () => undefined,
    reconcileMeeting: async () => {},
    onConfigApplied: () => {},
    ...overrides,
  };
}
