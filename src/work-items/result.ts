import type { WorkItem } from './types';

export const handlingState = (job: WorkItem): 'open' | 'handled' | 'ignored' =>
  job.handlingState ?? (job.state === 'ignored' ? 'ignored' : job.state === 'claimed' ? 'handled' : 'open');

export interface AnalysisFields { replyDraft: string; analysis: string; missingInfo: string }

/** Investigations return the validated JSON report produced by processAnalysis(). */
export function analysisFields(text: string): AnalysisFields {
  const value = JSON.parse(text) as AnalysisFields;
  return { replyDraft: value.replyDraft.slice(0, 6000), analysis: value.analysis.slice(0, 8000), missingInfo: value.missingInfo.slice(0, 2000) };
}

export function resultText(fields: AnalysisFields): string {
  return `## 分析结论\n${fields.analysis}\n\n## 建议回复\n${fields.replyDraft || '无需回复或信息不足，请查看待确认事项。'}\n\n## 待确认事项\n${fields.missingInfo || '无'}`;
}
