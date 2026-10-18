import { expect, it, vi } from 'vitest';
import { createInvestigator } from '../../../src/work-items/investigation';
import type { InvestigationDriver } from '../../../src/work-items/contracts';
import type { WorkItem } from '../../../src/work-items/types';

const item = { id: 'item' } as WorkItem;
const result = { text: 'report', inputTokens: 1, outputTokens: 2 };

it('shares preparation, execution and completion while preserving the configured model settings', async () => {
  const prepared = { cwd: '/private/fixture', prompt: 'investigate' };
  const driver: InvestigationDriver = { prepare: vi.fn(async () => prepared), completed: vi.fn(async () => {}) };
  const execute = vi.fn(async () => result); const signal = new AbortController().signal;
  expect(await createInvestigator(driver, execute, { model: 'flash' })(item, signal)).toEqual(result);
  expect(execute).toHaveBeenCalledWith(prepared, item, signal);
  expect(driver.completed).toHaveBeenCalledWith(item, result, { model: 'flash' });
});

it('returns a source-verified obsolete result without invoking a model or overwriting archived output', async () => {
  const cached = { ...result, businessState: 'resolved' as const };
  const driver = { prepare: vi.fn(async () => ({ cwd: '', prompt: '', cached })), completed: vi.fn() };
  const execute = vi.fn();
  expect(await createInvestigator(driver, execute)(item, new AbortController().signal)).toEqual(cached);
  expect(execute).not.toHaveBeenCalled(); expect(driver.completed).not.toHaveBeenCalled();
});

it('does not execute or archive a task cancelled while preparing evidence or running the model', async () => {
  const controller = new AbortController(); const execute = vi.fn(); const completed = vi.fn();
  const prepare = vi.fn(async () => { controller.abort(); return { cwd: '', prompt: '' }; });
  await expect(createInvestigator({ prepare, completed }, execute)(item, controller.signal)).rejects.toThrow();
  expect(execute).not.toHaveBeenCalled(); expect(completed).not.toHaveBeenCalled();
  const second = new AbortController();
  await expect(createInvestigator({ prepare: async () => ({ cwd: '', prompt: '' }), completed },
    async () => { second.abort(); return result; })(item, second.signal)).rejects.toThrow();
  expect(completed).not.toHaveBeenCalled();
});
