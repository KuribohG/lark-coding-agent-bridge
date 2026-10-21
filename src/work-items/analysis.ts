import type { AgentAdapter, AgentEvent, AgentRunOptions } from '../agent/types';
import { executeBackgroundRun } from '../runtime/background-executor';
import { backgroundAnalysisError, WorkItemAnalysisError } from './analysis-error';
import { parseModelJson } from '../utils/model-json';

/** Validate the report schema shared by inbox and CI investigations. */
export async function processAnalysis(agent: AgentAdapter, options: AgentRunOptions & { cwd: string }, signal: AbortSignal,
  onEvent?: (event: AgentEvent) => void) {
  try {
    const { text, ...usage } = await executeBackgroundRun(agent, options, signal, onEvent);
    if (text.length > 30_000) throw new WorkItemAnalysisError('incomplete');
    let fields: Record<string, unknown>;
    try {
      const parsed = parseModelJson(text);
      fields = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {};
    }
    catch { throw new WorkItemAnalysisError('invalid_result'); }
    if (typeof fields.replyDraft !== 'string' || typeof fields.analysis !== 'string' || !fields.analysis.trim() || typeof fields.missingInfo !== 'string') {
      throw new WorkItemAnalysisError('invalid_result');
    }
    return { text: JSON.stringify({ replyDraft: fields.replyDraft.slice(0, 6000), analysis: fields.analysis.slice(0, 8000),
      missingInfo: fields.missingInfo.slice(0, 2000) }), ...usage };
  } catch (error) { throw backgroundAnalysisError(error); }
}
