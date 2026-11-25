import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installProcessErrorGuards } from '../../../src/cli/process-error-guards';

const disposers: Array<() => void> = [];

afterEach(() => {
  while (disposers.length) disposers.pop()?.();
});

describe('process error guards', () => {
  it('keeps serving after an unhandled rejection', () => {
    const target = new EventEmitter();
    const onError = vi.fn();
    const requestShutdown = vi.fn(() => true);
    disposers.push(installProcessErrorGuards({ target, onError, requestShutdown }));

    target.emit('unhandledRejection', new Error('late async reply'));

    expect(onError).toHaveBeenCalledWith('unhandledRejection', expect.any(Error));
    expect(requestShutdown).not.toHaveBeenCalled();
  });

  it('requests exactly one graceful shutdown for repeated uncaught exceptions', () => {
    const target = new EventEmitter();
    const onError = vi.fn();
    const requestShutdown = vi.fn(() => true);
    const forceExit = vi.fn();
    disposers.push(installProcessErrorGuards({
      target,
      onError,
      requestShutdown,
      forceExit,
      emergencyExitMs: 60_000,
    }));

    target.emit('uncaughtException', new Error('broken lock'));
    target.emit('uncaughtException', new Error('second failure'));

    expect(onError).toHaveBeenCalledTimes(2);
    expect(requestShutdown).toHaveBeenCalledTimes(1);
    expect(forceExit).not.toHaveBeenCalled();
  });

  it('exits unsuccessfully when no graceful shutdown handler exists', () => {
    const target = new EventEmitter();
    const forceExit = vi.fn();
    disposers.push(installProcessErrorGuards({
      target,
      onError: vi.fn(),
      requestShutdown: () => false,
      forceExit,
    }));

    target.emit('uncaughtException', new Error('fatal'));

    expect(forceExit).toHaveBeenCalledWith(1);
  });
});
