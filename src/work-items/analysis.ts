import type { AgentAdapter, AgentEvent, AgentRunOptions } from '../agent/types';
import { executeBackgroundRun } from '../runtime/background-executor';
import { backgroundAnalysisError, InboxAnalysisError } from '../inbox/analysis-error';
import { obj, parseModelJson } from '../inbox/values';

/** Validate the report schema shared by inbox and CI investigations. */
export async function processAnalysis(agent: AgentAdapter, options: AgentRunOptions & { cwd: string }, signal: AbortSignal,
  onEvent?: (event: AgentEvent) => void) {
  try {
    const { text, ...usage } = await executeBackgroundRun(agent, options, signal, onEvent);
    if (text.length > 30_000) throw new InboxAnalysisError('incomplete');
    let fields: Record<string, unknown>;
    try { fields = obj(parseModelJson(text)); }
    catch { throw new InboxAnalysisError('invalid_result'); }
    if (typeof fields.replyDraft !== 'string' || typeof fields.analysis !== 'string' || !fields.analysis.trim() || typeof fields.missingInfo !== 'string') {
      throw new InboxAnalysisError('invalid_result');
    }
    return { text: JSON.stringify({ replyDraft: fields.replyDraft.slice(0, 6000), analysis: fields.analysis.slice(0, 8000),
      missingInfo: fields.missingInfo.slice(0, 2000) }), ...usage };
  } catch (error) { throw backgroundAnalysisError(error); }
}
