import type { AgentEvent, AgentExecutionCapabilities, AgentFailureKind, AgentInput, AgentInputReceipt, AgentRun } from './types';

export const LEGACY_EXECUTION_CAPABILITIES: AgentExecutionCapabilities = Object.freeze({
  finalAnswer: 'stream', input: 'unsupported',
});

export function executionCapabilities(source: { capabilities?: AgentExecutionCapabilities }): AgentExecutionCapabilities {
  return source.capabilities ?? LEGACY_EXECUTION_CAPABILITIES;
}

/** Text classification is confined to the adapter/legacy boundary; explicit kinds take precedence. */
export function classifyAgentFailure(message: string): AgentFailureKind {
  if (/delivery is unknown/i.test(message)) return 'delivery_unknown';
  if (/\[bridge-quota\]|insufficient_quota|quota_exceeded|budget_exceeded|budget has been exceeded|credit balance (?:is )?too low|daily (?:quota|budget) (?:is )?(?:exhausted|exceeded)/i.test(message)) return 'quota';
  if (/unauthorized|forbidden|invalid[_ ]api[_ ]key|authentication|\b40[13]\b/i.test(message)) return 'authentication';
  if (/\b429\b|too many requests|rate[_ -]limit(?:[_ -]exceeded|[_ -]error|ed)?/i.test(message)) return 'rate_limit';
  return 'runtime';
}

export function agentFailureKind(event: Extract<AgentEvent, { type: 'error' }>): AgentFailureKind {
  return event.failureKind ?? classifyAgentFailure(event.message);
}

export function supportsRunInput(run: AgentRun | undefined): boolean {
  if (!run) return false;
  if (run.capabilities?.input === 'unsupported') return false;
  return Boolean(run.sendInput || run.steer);
}

/** Legacy steer is isolated here until its adapter adopts the execution contract. */
export async function sendRunInput(run: AgentRun, input: AgentInput): Promise<AgentInputReceipt> {
  if (!supportsRunInput(run)) return { status: 'unsupported', messageId: input.messageId };
  try {
    if (run.sendInput) {
      const receipt = await run.sendInput(input);
      return receipt.messageId === input.messageId ? receipt
        : { status: 'unknown', messageId: input.messageId, message: 'Input receipt mismatch; delivery is unknown' };
    }
    const status = await run.steer!(input.text, input.messageId);
    return status === 'accepted'
      ? { status, messageId: input.messageId, scope: run.capabilities?.input === 'active-turn' ? 'active-turn' : 'active-session' }
      : { status, messageId: input.messageId };
  } catch (error) {
    // A lost acknowledgement is not proof of rejection. Never queue/replay this input.
    return { status: 'unknown', messageId: input.messageId, message: String(error) };
  }
}

/** Adapt a native run once, before retrying, rendering, or background execution. */
export function withExecutionContract(native: AgentRun, capabilities: AgentExecutionCapabilities): AgentRun {
  let active = true;
  const run: AgentRun = {
    runId: native.runId,
    capabilities,
    events: (async function* () {
      try {
        for await (const event of native.events) {
          if (event.type === 'done' || event.type === 'error') active = false;
          yield event.type === 'error' ? { ...event, failureKind: agentFailureKind(event) } : event;
        }
      } catch (error) {
        active = false;
        const message = String(error);
        yield { type: 'error', message, terminationReason: 'failed', failureKind: classifyAgentFailure(message) } as const;
      } finally { active = false; }
    })(),
    async stop() { active = false; await native.stop(); },
    waitForExit: timeoutMs => native.waitForExit(timeoutMs),
  };
  const scope = capabilities.input;
  if (scope !== 'unsupported') {
    run.sendInput = async input => {
      if (!active) return { status: 'inactive', messageId: input.messageId };
      const receipt = await sendRunInput(native, input);
      return receipt.status === 'accepted' ? { ...receipt, scope } : receipt;
    };
    // Keep existing adapter callers working during the migration.
    run.steer = async (text, messageId) => {
      const receipt = await run.sendInput!({ text, messageId });
      if (receipt.status === 'unknown') throw new Error(receipt.message);
      return receipt.status === 'accepted' ? 'accepted' : 'inactive';
    };
  }
  return run;
}
