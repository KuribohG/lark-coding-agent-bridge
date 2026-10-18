import type { AgentRunOptions } from '../agent/types';
import type { AnalysisResult, InvestigationDriver, PreparedInvestigation } from './contracts';
import type { WorkItem } from './types';

export function createInvestigator(driver: InvestigationDriver,
  execute: (prepared: PreparedInvestigation, item: WorkItem, signal: AbortSignal) => Promise<AnalysisResult>,
  settings: Pick<AgentRunOptions, 'model' | 'reasoningEffort'> = {}) {
  return async (item: WorkItem, signal: AbortSignal): Promise<AnalysisResult> => {
    signal.throwIfAborted();
    const prepared = await driver.prepare(item, signal);
    signal.throwIfAborted();
    if (prepared.cached) return prepared.cached;
    const result = await execute(prepared, item, signal);
    signal.throwIfAborted();
    await driver.completed?.(item, result, settings);
    return result;
  };
}
