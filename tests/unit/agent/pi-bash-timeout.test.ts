import { describe, expect, it } from 'vitest';
import {
  bashTimeoutEnv, bashTimeoutInstructions, bashTimeoutsFromEnv, boundBashTimeout, piBashTimeouts, piToolTimeoutMs,
} from '../../../src/agent/pi/bash-timeout';
import bashTimeoutExtension from '../../../src/agent/pi/bash-timeout-extension';
import { normalizePi } from '../../../src/agent/pi/config';

type Content = Array<{ type: string; text?: string }>;
type CallHandler = (event: { toolName?: string; toolCallId?: string; input?: Record<string, unknown> }) => void;
type ResultHandler = (event: { toolCallId?: string; content?: Content; isError?: boolean }) => { content: Content } | undefined;

/** The two handlers the extension registers with Pi. */
function load(limits: { defaultSeconds?: number; maxSeconds?: number }) {
  const handlers: { tool_call?: CallHandler; tool_result?: ResultHandler } = {};
  bashTimeoutExtension({
    on(event: 'tool_call' | 'tool_result', handler: CallHandler | ResultHandler) { (handlers as Record<string, unknown>)[event] = handler; },
  }, { limits });
  return handlers;
}

describe('Pi shell time limits', () => {
  it('defaults to ten minutes without a timeout and four hours at most', () => {
    expect(piBashTimeouts()).toEqual({ defaultSeconds: 600, maxSeconds: 14_400 });
  });

  it('lets a profile change either limit or switch it off with 0', () => {
    expect(piBashTimeouts({ bashDefaultTimeoutSeconds: 120, bashMaxTimeoutSeconds: 3600 })).toEqual({ defaultSeconds: 120, maxSeconds: 3600 });
    expect(piBashTimeouts({ bashDefaultTimeoutSeconds: 0 })).toEqual({ maxSeconds: 14_400 });
    expect(piBashTimeouts({ bashMaxTimeoutSeconds: 0 })).toEqual({ defaultSeconds: 600 });
    expect(piBashTimeouts({ bashDefaultTimeoutSeconds: 0, bashMaxTimeoutSeconds: 0 })).toEqual({});
  });

  it('never lets the default exceed the cap', () => {
    expect(piBashTimeouts({ bashDefaultTimeoutSeconds: 900, bashMaxTimeoutSeconds: 300 })).toEqual({ defaultSeconds: 300, maxSeconds: 300 });
  });

  it('rejects limits that are not whole non-negative seconds', () => {
    expect(() => normalizePi({ binaryPath: '/opt/pi', bashDefaultTimeoutSeconds: -1 })).toThrow(/bashDefaultTimeoutSeconds/);
    expect(() => normalizePi({ binaryPath: '/opt/pi', bashMaxTimeoutSeconds: 1.5 })).toThrow(/bashMaxTimeoutSeconds/);
    expect(normalizePi({ binaryPath: '/opt/pi', bashDefaultTimeoutSeconds: 0, bashMaxTimeoutSeconds: 7200 }))
      .toMatchObject({ bashDefaultTimeoutSeconds: 0, bashMaxTimeoutSeconds: 7200 });
  });

  it('gives a call the default only when it names no timeout, and caps one that asks for too much', () => {
    const limits = { defaultSeconds: 600, maxSeconds: 14_400 };
    expect(boundBashTimeout(undefined, limits)).toEqual({ seconds: 600, source: 'default' });
    expect(boundBashTimeout(1800, limits)).toEqual({ seconds: 1800, source: 'declared' });
    expect(boundBashTimeout(86_400, limits)).toEqual({ seconds: 14_400, source: 'capped' });
    // The event stream carries arguments as the model wrote them.
    expect(boundBashTimeout('900', limits)).toEqual({ seconds: 900, source: 'declared' });
    // Pi refuses these itself; nothing is put in their place.
    expect(boundBashTimeout(-5, limits)).toEqual({ seconds: undefined, source: 'declared' });
    expect(boundBashTimeout('soon', limits)).toEqual({ seconds: undefined, source: 'declared' });
    expect(boundBashTimeout(undefined, {})).toEqual({ seconds: undefined, source: 'default' });
  });

  it('reports how long Pi lets each tool run', () => {
    const limits = { defaultSeconds: 600, maxSeconds: 14_400 };
    expect(piToolTimeoutMs('bash', { command: 'ls' }, limits)).toBe(600_000);
    expect(piToolTimeoutMs('bash', { command: 'make', timeout: 3600 }, limits)).toBe(3_600_000);
    expect(piToolTimeoutMs('bash', { command: 'make', timeout: 99_999 }, limits)).toBe(14_400_000);
    expect(piToolTimeoutMs('grep', { pattern: 'x' }, limits)).toBe(600_000);
    // A tool of an extension may wait as long as it likes.
    expect(piToolTimeoutMs('wait_for_review', {}, limits)).toBeUndefined();
    expect(piToolTimeoutMs('bash', { command: 'ls' }, {})).toBeUndefined();
    expect(piToolTimeoutMs('bash', { command: 'make', timeout: 120 }, {})).toBe(120_000);
  });

  it('carries the limits to the Pi process through its environment', () => {
    const limits = { defaultSeconds: 600, maxSeconds: 14_400 };
    expect(bashTimeoutsFromEnv(bashTimeoutEnv(limits))).toEqual(limits);
    expect(bashTimeoutsFromEnv(bashTimeoutEnv({ maxSeconds: 60 }))).toEqual({ maxSeconds: 60 });
    expect(bashTimeoutsFromEnv({})).toEqual({});
    expect(bashTimeoutsFromEnv({ LARK_PI_BASH_DEFAULT_TIMEOUT: 'soon' })).toEqual({});
  });

  it('tells the model both limits and what to do about a long command', () => {
    const text = bashTimeoutInstructions({ defaultSeconds: 600, maxSeconds: 14_400 })!;
    expect(text).toContain('stopped after 600 seconds');
    expect(text).toContain('cannot exceed 14400 seconds');
    expect(text).toContain('setsid nohup');
    expect(bashTimeoutInstructions({})).toBeUndefined();
  });
});

describe('Pi shell time limit extension', () => {
  it('registers nothing when both limits are off', () => {
    expect(load({})).toEqual({});
  });

  it('fills in the default and leaves a timeout the model chose alone', () => {
    const { tool_call: onCall } = load({ defaultSeconds: 600, maxSeconds: 14_400 });
    const bare = { command: 'find / -name x' } as Record<string, unknown>;
    onCall!({ toolName: 'bash', toolCallId: 'a', input: bare });
    expect(bare.timeout).toBe(600);
    const chosen = { command: 'cargo build', timeout: 3600 } as Record<string, unknown>;
    onCall!({ toolName: 'bash', toolCallId: 'b', input: chosen });
    expect(chosen.timeout).toBe(3600);
    const greedy = { command: 'sleep 1d', timeout: 86_400 } as Record<string, unknown>;
    onCall!({ toolName: 'bash', toolCallId: 'c', input: greedy });
    expect(greedy.timeout).toBe(14_400);
  });

  it('touches no tool but the shell ones and survives a malformed call', () => {
    const { tool_call: onCall } = load({ defaultSeconds: 600 });
    const read = { path: 'a.txt' } as Record<string, unknown>;
    onCall!({ toolName: 'read', toolCallId: 'a', input: read });
    expect(read).toEqual({ path: 'a.txt' });
    // Pi blocks a call whose handler throws.
    expect(() => onCall!({ toolName: 'bash', toolCallId: 'b' })).not.toThrow();
    expect(() => onCall!({ toolName: 'bash', toolCallId: 'c', input: Object.freeze({ command: 'ls' }) as Record<string, unknown> })).not.toThrow();
  });

  it('explains a stop by a limit the model did not choose, once', () => {
    const { tool_call: onCall, tool_result: onResult } = load({ defaultSeconds: 600, maxSeconds: 14_400 });
    const timedOut = (seconds: number): Content => [{ type: 'text', text: `partial output\n\nCommand timed out after ${seconds} seconds` }];

    onCall!({ toolName: 'bash', toolCallId: 'a', input: { command: 'grep -r x /mnt' } });
    const defaulted = onResult!({ toolCallId: 'a', content: timedOut(600), isError: true });
    expect(defaulted!.content).toHaveLength(2);
    expect(defaulted!.content[0]!.text).toContain('partial output');
    expect(defaulted!.content[1]!.text).toMatch(/No timeout was given.*default of 600 seconds.*at most 14400/);
    expect(onResult!({ toolCallId: 'a', content: timedOut(600), isError: true })).toBeUndefined();

    onCall!({ toolName: 'bash', toolCallId: 'b', input: { command: 'sleep 1d', timeout: 86_400 } });
    expect(onResult!({ toolCallId: 'b', content: timedOut(14_400), isError: true })!.content[1]!.text).toMatch(/reduced to 14400 seconds/);
  });

  it('adds nothing to a call that returned, failed on its own, or ran under its own timeout', () => {
    const { tool_call: onCall, tool_result: onResult } = load({ defaultSeconds: 600, maxSeconds: 14_400 });
    onCall!({ toolName: 'bash', toolCallId: 'ok', input: { command: 'ls' } });
    expect(onResult!({ toolCallId: 'ok', content: [{ type: 'text', text: 'a.txt' }], isError: false })).toBeUndefined();
    onCall!({ toolName: 'bash', toolCallId: 'failed', input: { command: 'false' } });
    expect(onResult!({ toolCallId: 'failed', content: [{ type: 'text', text: 'Command exited with code 1' }], isError: true })).toBeUndefined();
    onCall!({ toolName: 'bash', toolCallId: 'own', input: { command: 'make', timeout: 60 } });
    expect(onResult!({ toolCallId: 'own', content: [{ type: 'text', text: 'Command timed out after 60 seconds' }], isError: true })).toBeUndefined();
  });
});
