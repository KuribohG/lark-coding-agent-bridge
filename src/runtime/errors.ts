import type { RunStopReason } from '../agent/types';

export type RunRejectedCode =
  | 'deadline-expired'
  | 'run-cancelled'
  | 'pool-full'
  | 'policy-expired'
  | 'reconnect-in-progress'
  | 'run-already-active';
export class RunRejected extends Error {
  readonly code: RunRejectedCode;

  constructor(code: RunRejectedCode, message: string) {
    super(message);
    this.name = 'RunRejected';
    this.code = code;
  }
}

/** Also a RunRejected so pre-spawn cancellation retains the admission error contract. */
export class RunStopped extends RunRejected {
  constructor(readonly reason: RunStopReason) {
    super(reason === 'deadline' ? 'deadline-expired' : 'run-cancelled', `Run stopped: ${reason}`);
    this.name = 'RunStopped';
  }
}

export function abortStopReason(signal: AbortSignal): RunStopReason {
  return signal.reason instanceof RunStopped ? signal.reason.reason : 'cancelled';
}
