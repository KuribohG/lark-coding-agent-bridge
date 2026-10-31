import type { AgentEvent } from '../agent/types';
import type { SessionContextUsage } from '../session/catalog';
import { log } from '../core/logger';
import type { ActiveRuns } from './active-runs';
import type { RunExecution } from './run-executor';
import { recordRunSessionEvent, type RecordRunSessionEventInput } from './run-flow';

type SessionInput =
  | { kind: 'message'; messageId?: string; summary?: string;
      history?: { seenMessageIds: readonly string[]; completeThrough?: number } }
  | { kind: 'internal' };

interface SessionProgressInput extends Omit<RecordRunSessionEventInput, 'event'> {
  execution: RunExecution;
  activeRuns: ActiveRuns;
  resumeFrom?: string;
  source: SessionInput;
}

/** Own session persistence independently of output delivery. Source hosts supply
 * only the history actually included in the prompt, never an internal wake's anchor.
 */
export async function trackRunSession(input: SessionProgressInput): Promise<void> {
  const { execution, activeRuns, capability, scopeId, source, sessionCatalog } = input;
  const generation = activeRuns.generation(scopeId);
  let cwdRealpath = input.policy.cwdRealpath;
  let nativeId = input.resumeFrom;
  let contextUsage: SessionContextUsage | undefined;
  const current = () => !execution.handle.interrupted && activeRuns.generation(scopeId) === generation
    && activeRuns.isLatest(scopeId, execution.run);
  const record = (event: AgentEvent) => {
    if (!current()) return;
    if (event.type === 'retry') contextUsage = undefined;
    if (event.type === 'system') {
      const id = capability.sessionIdField === 'sessionId' ? event.sessionId : event.threadId;
      if (id) {
        nativeId = id;
        cwdRealpath = capability.sessionIdField === 'sessionId' ? event.cwd ?? input.policy.cwdRealpath : input.policy.cwdRealpath;
        recordRunSessionEvent({ ...input, event });
        activeRuns.identifySession(scopeId, execution.run, { agentId: capability.agentId, [capability.sessionIdField]: id });
        log.info('session', capability.sessionIdField === 'sessionId' ? 'set' : 'set-thread', { [capability.sessionIdField]: id });
      }
      if (event.model) log.info('session', 'model', {
        requested: execution.handle.modelSettings?.model ?? 'default', actual: event.model,
      });
    }
    if (event.type === 'usage' && event.inputTokens !== undefined && event.contextWindowTokens !== undefined
      && event.inputTokens > 0 && event.contextWindowTokens > 0) {
      contextUsage = { inputTokens: event.inputTokens, contextWindowTokens: event.contextWindowTokens, updatedAt: Date.now() };
    }
  };
  for await (const event of execution.subscribe()) record(event);
  if (await execution.result !== 'completed' || !current() || !nativeId || !sessionCatalog) return;
  const identity = { scopeId, agentId: capability.agentId, cwdRealpath, policyFingerprint: input.policy.policyFingerprint };
  // A completed old run cannot advance history on a newly selected native session.
  const entry = sessionCatalog.activeFor(identity);
  if (!entry || entry[capability.sessionIdField] !== nativeId) return;
  const delivered = [...execution.handle.inputMessageIds];
  if (source.kind === 'internal' && delivered.length === 0) return;
  sessionCatalog.markCompleted({
    ...identity,
    sourceMessageId: source.kind === 'message' ? source.messageId : delivered.at(-1),
    ...(source.kind === 'message' ? { lastSummary: source.summary } : {}),
    ...(source.kind === 'message' && source.history ? {
      topicContextThrough: source.history.completeThrough,
      topicContextSeenMessageIds: [...source.history.seenMessageIds, ...delivered],
    } : source.kind === 'internal' ? { topicContextSeenMessageIds: delivered } : {}),
    ...(contextUsage ? { contextUsage } : {}),
  });
}
