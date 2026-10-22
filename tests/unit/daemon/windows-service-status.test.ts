import { describe, expect, it } from 'vitest';
import { readTaskStatus } from '../../../src/daemon/schtasks.js';

describe('Windows Task Scheduler structured status', () => {
  it('maps stable COM fields without locale-dependent text', () => {
    expect(readTaskStatus('work', () => [
      'STATE=4',
      'PID=12345',
      'LAST_RESULT=3221225786',
      'LAST_RUN_TIME=2026-10-22T12:00:00.0000000+08:00',
    ].join('\r\n'))).toEqual({
      state: 'running',
      pid: 12345,
      lastExit: 3221225786,
      lastRunAt: '2026-10-22T12:00:00.0000000+08:00',
    });
  });

  it.each([
    ['1', 'stopped'],
    ['2', 'running'],
    ['3', 'stopped'],
    ['4', 'running'],
    ['0', 'unknown'],
  ] as const)('maps TASK_STATE=%s to %s', (taskState, expected) => {
    expect(readTaskStatus('work', () => `STATE=${taskState}\r\nLAST_RESULT=0\r\n`).state)
      .toBe(expected);
  });

  it('reports a ready task with a real failed exit as failed', () => {
    expect(readTaskStatus('work', () => 'STATE=3\r\nLAST_RESULT=3221225786\r\n')).toMatchObject({
      state: 'failed',
      lastExit: 3221225786,
    });
  });

  it('does not expose Task Scheduler sentinel results as process exits', () => {
    expect(readTaskStatus('work', () => 'STATE=1\r\nPID=\r\nLAST_RESULT=1056\r\n').lastExit)
      .toBeUndefined();
    for (let result = 267008; result <= 267015; result++) {
      expect(readTaskStatus('work', () => `STATE=1\r\nLAST_RESULT=${result}\r\n`).lastExit)
        .toBeUndefined();
    }
  });
});
