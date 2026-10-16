import type { InboxJob } from './types';
import { handlingState, replyContent } from './reply';

export const guiSummary = (job: InboxJob) => ({ id: job.id, name: job.source.name.slice(0, 80),
  chatId: job.source.chatId, type: job.source.type, state: job.state,
  preview: job.messages.at(-1)?.text.slice(0, 80) || '', messageCount: job.messages.length,
  updatedAt: job.updatedAt, dueAt: job.dueAt, automatic: job.automatic, alert: job.alert,
  attention: job.attention,
  revision: job.revision ?? 0, handlingState: handlingState(job) });

export function guiContent(job: InboxJob) {
  const legacy = replyContent(job.result);
  const content = { replyDraft: job.replyDraft ?? legacy.replyDraft, analysis: (job.analysis ?? legacy.analysis).slice(0, 8000),
    missingInfo: job.missingInfo ?? legacy.missingInfo, draftEdited: Boolean(job.draftEdited), draftStale: Boolean(job.draftStale),
    error: job.error?.slice(0, 1000), sourceUrl: job.messages.find(m => /^https:\/\/applink\.(feishu\.cn|larksuite\.com)\//.test(m.link || ''))?.link?.slice(0, 1000) ||
      `https://applink.feishu.cn/client/chat/open?openChatId=${job.source.chatId}`,
    messages: job.messages.slice(-5).map(m => ({ name: m.senderName.slice(0, 80), time: m.time, text: m.text.slice(0, 300) })),
    inputTokens: job.inputTokens, outputTokens: job.outputTokens };
  while (JSON.stringify(content).length > 22000) {
    if (content.analysis.length) content.analysis = content.analysis.slice(0, Math.floor(content.analysis.length / 2));
    else if (content.messages.length) content.messages.pop();
    else content.missingInfo = content.missingInfo.slice(0, Math.floor(content.missingInfo.length / 2));
  }
  return content;
}

/** Keep the list intact; prefetch content only while the snapshot budget permits. */
export function guiJobs(all: InboxJob[]) {
  const selected = all.slice(0, 500);
  const jobs = selected.map(job => ({ ...guiSummary(job), detail: undefined as ReturnType<typeof guiContent> | undefined }));
  while (Buffer.byteLength(JSON.stringify(jobs)) > 600000) { jobs.pop(); selected.pop(); }
  let bytes = Buffer.byteLength(JSON.stringify(jobs));
  for (let i = 0; i < jobs.length; i++) {
    const detail = guiContent(selected[i]!);
    const extra = Buffer.byteLength(JSON.stringify(detail)) + 10;
    if (bytes + extra <= 700000) { jobs[i]!.detail = detail; bytes += extra; }
  }
  return jobs;
}
