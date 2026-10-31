import { expect, it, vi } from 'vitest';
import { preparedRun, snapshotRunOptions } from '../../../src/agent/prepared-run';
import type { AgentRun } from '../../../src/agent/types';

it('starts a prepared attempt once even if process startup fails', () => {
  const start = vi.fn((): AgentRun => { throw new Error('spawn failed'); });
  const prepared = preparedRun({ model: 'effective' }, start, { id: 'fixed', requestedId: 'other' });
  expect(prepared.modelSettings).toEqual({ model: 'effective' });
  expect(() => prepared.start()).toThrow('spawn failed');
  expect(() => prepared.start()).toThrow('already been started');
  expect(start).toHaveBeenCalledOnce();
});

it('keeps the caller from changing an attempt while it waits for preparation', () => {
  const source = { runId: 'r', prompt: 'original', env: { TOKEN: 'first' }, images: ['image'],
    modelProvider: { id: 'p', displayName: 'P', model: 'model', env: { KEY: 'key' } } };
  const snapshot = snapshotRunOptions(source);
  source.prompt = 'changed'; source.env.TOKEN = 'second'; source.images.push('extra');
  source.modelProvider.env.KEY = 'rotated';
  expect(snapshot).toMatchObject({ prompt: 'original', env: { TOKEN: 'first' }, images: ['image'],
    modelProvider: { env: { KEY: 'key' } } });
});
