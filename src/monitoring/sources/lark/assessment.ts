import { log } from '../../../core/logger';
import type { ItemAssessmentPolicy } from '../../../work-items/contracts';
import type { InboxIO } from '../../../inbox/types';
import { triageFailureReason } from './codex-triage';
import { analysisChanges, messageBasis, validFollowUp } from '../../../inbox/updates';

export function createLarkAssessment(io: InboxIO): ItemAssessmentPolicy {
  return {
    kind: 'item', failureReason: triageFailureReason,
    available: Boolean(io.triage),
    evaluate: (item, signal, progress) => io.triage!(item, signal, progress),
    valid: validFollowUp,
    interpret(input, result) {
      const followUp = Boolean(input.result);
      if (followUp) log.info('inbox', 'analysis-update-reviewed', { jobId: input.id, decision: result.followUp ?? result.state,
        changedMessages: analysisChanges(input).length });
      return {
        attention: { state: result.state, reason: result.reason, priority: result.priority,
          ...(result.mentionedPrincipalMessageIds === undefined
            ? {}
            : { mentionedPrincipalMessageIds: result.mentionedPrincipalMessageIds }) },
        followUp: followUp ? result.followUp : undefined,
        basis: followUp ? messageBasis(input.messages) : undefined,
        autoAnalyze: Boolean(io.beginAnalysis),
      };
    },
  };
}
