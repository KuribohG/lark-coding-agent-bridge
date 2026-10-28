import { Readable } from 'node:stream';
import type { AgentEvent } from '../agent/types';
import { consumeCotEvents, CotPublisher, type CotClient } from '../bot/cot';
import type { CotMessagesMode } from '../config/schema';
import { log } from '../core/logger';
import type { InboxLark } from './lark';
import { larkTarget } from './lark-target';
import type { InboxJob } from './types';

/** Progress is separate from the structured result and never carries raw reasoning. */
export async function startInboxProgress(job: InboxJob, lark: InboxLark,
  client: Pick<CotClient, 'create' | 'update' | 'complete'>, mode: CotMessagesMode, signal: AbortSignal) {
  if (mode === 'off' || !job.analysisTarget || signal.aborted) return;
  try {
    const originMessageId = await lark.progressAnchor(job, signal);
    signal.throwIfAborted();
    const topic = larkTarget(job.analysisTarget);
    const publisher = new CotPublisher({ client, chatId: topic.chatId, originMessageId,
      runId: `inbox-${job.id}-${job.attempt ?? 0}`, scope: `${topic.chatId}:${topic.threadId}`,
      inputPreview: '会话待办深入分析' });
    await publisher.start();
    if (publisher.disabled) return;
    const stream = new Readable({ objectMode: true, read() {} });
    const done = consumeCotEvents(stream as AsyncIterable<AgentEvent>, publisher, { detail: 'brief' });
    let closed = false, analyzing = false;
    const finish = async (success: boolean) => {
      if (!closed) {
        closed = true;
        stream.push(success ? { type: 'done', terminationReason: 'normal' } :
          { type: 'error', message: signal.aborted ? '分析已取消' : '分析未完成，请在工作台查看', terminationReason: signal.aborted ? 'interrupted' : 'failed' });
        stream.push(null);
      }
      await done;
    };
    if (signal.aborted) { await finish(false); return; }
    return {
      event(event: AgentEvent) {
        if (closed || publisher.disabled || signal.aborted) return;
        if (event.type === 'thinking') {
          if (!analyzing) stream.push({ type: 'text', delta: '正在分析和核对信息。' });
          analyzing = true;
        } else if (['text', 'tool_use', 'tool_result', 'retry'].includes(event.type)) {
          analyzing = false;
          stream.push(event);
        }
      },
      finish,
    };
  } catch {
    log.warn('inbox', 'progress-unavailable', { jobId: job.id });
    // A progress API failure must not discard the analysis or trigger another run.
    return;
  }
}
