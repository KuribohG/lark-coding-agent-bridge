import { integer, table } from '../monitoring/validation';

export interface WorkItemConcurrency { analysis: number; triage: number }
export const WORK_ITEM_CONCURRENCY_DEFAULTS: Readonly<WorkItemConcurrency> = { analysis: 5, triage: 50 };
export const MAX_WORK_ITEM_CONCURRENCY = 100;

export function parseWorkItemConcurrency(input: unknown = {}, path = 'workItemConcurrency'): WorkItemConcurrency {
  const count = integer(1, MAX_WORK_ITEM_CONCURRENCY);
  table({ analysis: count, triage: count })(input, path);
  return { ...WORK_ITEM_CONCURRENCY_DEFAULTS, ...input as Partial<WorkItemConcurrency> };
}
