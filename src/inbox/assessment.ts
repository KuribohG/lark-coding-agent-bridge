import { log } from '../core/logger';
import type { BatchAssessmentPolicy } from '../work-items/contracts';
import type { InboxConfig } from './config';
import type { InboxIO } from './types';
import { triageBatch } from './codex-triage';
import { analysisChanges, messageBasis, validFollowUp } from './updates';

export function createLarkAssessment(config: InboxConfig, io: InboxIO): BatchAssessmentPolicy {
  return {
    kind: 'batch',
    available: Boolean(io.triage),
    select: triageBatch,
    evaluate: (items, signal, progress) => io.triage!(items, signal, progress),
    valid: validFollowUp,
    apply(job, input, result) {
      const followUp = Boolean(input.result);
      if (followUp) log.info('inbox', 'analysis-update-reviewed', { jobId: job.id, decision: result.followUp ?? result.state,
        changedMessages: analysisChanges(input).length });
      if (followUp && result.followUp === 'unchanged') {
        job.attention = job.analysisBasis?.attention ?? { state: 'needed', reason: '已有分析仍适用' };
        job.analysisBasis = { messages: messageBasis(job.messages), attention: { ...job.attention } };
        job.analyzedVersion = job.evidenceVersion;
        job.draftStale = job.attention.state === 'quiet'; job.error = undefined;
        job.state = job.draftStale || job.deliveredAt || job.analysisPaused || job.draftEdited ? 'done' : 'ready';
        return;
      }
      job.attention = { state: result.state, reason: result.reason, priority: result.priority };
      if (followUp && result.followUp === 'resolved') {
        job.businessState = 'resolved';
        job.analysisBasis = { messages: messageBasis(job.messages), attention: { ...job.attention } };
        job.state = 'done'; job.draftStale = true; job.error = undefined;
      }
      if (result.state === 'needed') job.businessState = 'open';
      if (result.state === 'needed' && io.beginAnalysis && !job.draftEdited && !job.analysisPaused) {
        job.state = 'queued'; job.automatic = true; job.analysisRequested = true;
        job.destination = { ...config.destination };
        job.resultDelivery = undefined; job.deliveredAt = undefined; job.error = undefined;
      }
    },
  };
}
