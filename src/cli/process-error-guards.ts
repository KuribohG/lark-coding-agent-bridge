import type { EventEmitter } from 'node:events';
import { log, reportError } from '../core/logger';

const DEFAULT_EMERGENCY_EXIT_MS = 10_000;

export interface ProcessErrorGuardOptions {
  target?: Pick<EventEmitter, 'on' | 'off'>;
  onError?: (kind: 'unhandledRejection' | 'uncaughtException', error: unknown) => void;
  /** Return false when no graceful SIGTERM handler is installed. */
  requestShutdown?: () => boolean;
  forceExit?: (code: number) => void;
  emergencyExitMs?: number;
}

/**
 * Keep ordinary async integration failures alive, but fail closed on an
 * uncaught exception. Continuing after Node reports an uncaught exception can
 * leave a process listening locally while its event loop, locks, or network
 * clients are compromised.
 */
export function installProcessErrorGuards(options: ProcessErrorGuardOptions = {}): () => void {
  const target = options.target ?? process;
  const onError = options.onError ?? reportProcessError;
  const forceExit = options.forceExit ?? ((code: number) => process.exit(code));
  let fatalShutdownStarted = false;

  const onUnhandledRejection = (reason: unknown): void => {
    onError('unhandledRejection', reason);
  };

  const onUncaughtException = (error: unknown): void => {
    onError('uncaughtException', error);
    if (fatalShutdownStarted) return;
    fatalShutdownStarted = true;

    let requested = false;
    try {
      requested = options.requestShutdown?.()
        ?? process.emit('SIGTERM', 'SIGTERM');
    } catch {
      requested = false;
    }
    if (!requested) {
      forceExit(1);
      return;
    }

    // Graceful shutdown normally exits well before this. If it is itself stuck,
    // exit with a failure status so a service manager can restart the process.
    setTimeout(() => forceExit(1), options.emergencyExitMs ?? DEFAULT_EMERGENCY_EXIT_MS).unref();
  };

  target.on('unhandledRejection', onUnhandledRejection);
  target.on('uncaughtException', onUncaughtException);
  return () => {
    target.off('unhandledRejection', onUnhandledRejection);
    target.off('uncaughtException', onUncaughtException);
  };
}

function reportProcessError(
  kind: 'unhandledRejection' | 'uncaughtException',
  error: unknown,
): void {
  log.fail('process', error, { kind });
  reportError(error, { kind });
}
