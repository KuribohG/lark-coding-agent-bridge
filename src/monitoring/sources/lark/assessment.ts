import { log } from '../../../core/logger';
import type { BatchAssessmentPolicy } from '../../../work-items/contracts';
import type { InboxConfig } from '../../../inbox/config';
import type { InboxIO } from '../../../inbox/types';
import { triageBatch, triageFailureReason } from './codex-triage';
import { analysisChanges, messageBasis, validFollowUp } from '../../../inbox/updates';

export function createLarkAssessment(config: InboxConfig, io: InboxIO): BatchAssessmentPolicy {
  return {
    kind: 'batch', failureReason: triageFailureReason,
    available: Boolean(io.triage),
    select: items => triageBatch(items, config),
    evaluate: (items, signal, progress) => io.triage!(items, signal, progress),
    valid: validFollowUp,
    interpret(input, result) {
      const followUp = Boolean(input.result);
      if (followUp) log.info('inbox', 'analysis-update-reviewed', { jobId: input.id, decision: result.followUp ?? result.state,
        changedMessages: analysisChanges(input).length });
      return {
        attention: { state: result.state, reason: result.reason, priority: result.priority,
          ...(result.ownerMentionMessageIds === undefined ? {} : { ownerMentionMessageIds: result.ownerMentionMessageIds }) },
        followUp: followUp ? result.followUp : undefined,
        basis: followUp ? messageBasis(input.messages) : undefined,
        autoAnalyze: Boolean(io.beginAnalysis),
      };
    },
  };
}
