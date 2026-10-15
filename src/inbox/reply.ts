import type { InboxJob } from './types';

export const handlingState = (job: InboxJob): 'open' | 'handled' | 'ignored' =>
  job.handlingState ?? (job.state === 'ignored' ? 'ignored' : job.state === 'claimed' ? 'handled' : 'open');

/** Old free-form results are evidence, never implicitly a sendable draft. */
export function replyContent(result = ''): { replyDraft: string; analysis: string; missingInfo: string } {
  try {
    const value = JSON.parse(result.replace(/^```(?:json)?\s*\n?|\n?```$/g, '').trim());
    if (value && typeof value.replyDraft === 'string' && typeof value.analysis === 'string' && typeof value.missingInfo === 'string') {
      return { replyDraft: value.replyDraft.slice(0, 6000), analysis: value.analysis.slice(0, 8000), missingInfo: value.missingInfo.slice(0, 2000) };
    }
  } catch { /* Legacy Markdown remains readable. */ }
  const parts: Record<string, string> = {};
  let section = '';
  for (const line of result.split('\n')) {
    const heading = line.trim().match(/^(?:#{1,6}\s+|\*\*)?(问题摘要|分析结论|建议回复|待确认事项)(?:\*\*)?[：:]?\s*$/);
    if (heading) { section = heading[1]!; parts[section] ??= ''; }
    else if (section) parts[section] += line + '\n';
  }
  return { replyDraft: (parts['建议回复'] || '').trim().slice(0, 6000),
    analysis: result.slice(0, 16000), missingInfo: (parts['待确认事项'] || '').trim().slice(0, 2000) };
}

export function resultText(text: string): string {
  const fields = replyContent(text);
  // Preserve legacy free-form output for existing result cards.
  if (!text.trim().startsWith('{') && !text.trim().startsWith('```json')) return text.slice(0, 20000);
  return `## 分析结论\n${fields.analysis}\n\n## 建议回复\n${fields.replyDraft || '无需回复或信息不足，请查看待确认事项。'}\n\n## 待确认事项\n${fields.missingInfo || '无'}`;
}
