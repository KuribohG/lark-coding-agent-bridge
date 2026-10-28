import { describe, expect, it } from 'vitest';
import { initialState, reduce } from '../../../src/runtime/run-state';

describe('run state status messages', () => {
  it('keeps bridge status visible without treating it as an agent text delta', () => {
    const state = reduce(initialState, {
      type: 'status',
      content: '上下文已自动压缩，任务继续执行。',
    });

    expect(state.blocks).toEqual([{
      kind: 'text',
      content: '上下文已自动压缩，任务继续执行。',
      streaming: false,
    }]);
    expect(state.footer).toBe('thinking');
  });

  it('closes an unterminated agent text block before adding a status', () => {
    const streaming = reduce(initialState, { type: 'text', delta: 'partial answer' });
    const state = reduce(streaming, {
      type: 'status',
      content: '上下文已自动压缩，任务继续执行。',
    });

    expect(state.blocks).toMatchObject([
      { kind: 'text', content: 'partial answer', streaming: false },
      { kind: 'text', content: '上下文已自动压缩，任务继续执行。', streaming: false },
    ]);
  });
});
