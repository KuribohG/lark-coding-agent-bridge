import type {
  AgentEvent, AgentExecutionCapabilities, AgentFailureKind, AgentInput, AgentInputReceipt, AgentRun, NativeAgentRun,
} from './types';

/** Text classification is confined to the adapter boundary; explicit kinds take precedence. */
export function classifyAgentFailure(message: string): AgentFailureKind {
  if (/delivery is unknown/i.test(message)) return 'delivery_unknown';
  if (/\[bridge-quota\]|insufficient_quota|quota_exceeded|budget_exceeded|budget has been exceeded|credit balance (?:is )?too low|daily (?:quota|budget) (?:is )?(?:exhausted|exceeded)/i.test(message)) return 'quota';
  if (/unauthorized|forbidden|invalid[_ ]api[_ ]key|authentication|\b40[13]\b/i.test(message)) return 'authentication';
  if (/\b429\b|too many requests|rate[_ -]limit(?:[_ -]exceeded|[_ -]error|ed)?/i.test(message)) return 'rate_limit';
  if (/stream disconnected before completion|stream closed before response\.completed|\b(?:ECONNRESET|ETIMEDOUT|EAI_AGAIN)\b|\bHTTP(?:\/[\d.]+)?\s+(?:408|500|502|503|504)\b/i.test(message)) return 'transient';
  // Claude Code reports gateway failures as "API Error: <status> ..." after its own retries.
  if (/^API Error:\s*(?:(?:500|502|503|504|529)\b|Upstream request failed\b|upstream stream disconnected\b)/im.test(message)) return 'transient';
  return 'runtime';
}

export function agentFailureKind(event: Extract<AgentEvent, { type: 'error' }>): AgentFailureKind {
  return event.failureKind ?? classifyAgentFailure(event.message);
}

export function supportsRunInput(run: AgentRun | undefined): boolean {
  return Boolean(run?.sendInput) && run!.capabilities.input !== 'unsupported';
}

export async function sendRunInput(run: AgentRun, input: AgentInput): Promise<AgentInputReceipt> {
  if (!supportsRunInput(run)) return { status: 'unsupported', messageId: input.messageId };
  return deliverInput(run.sendInput!.bind(run), input);
}

async function deliverInput(
  send: (input: AgentInput) => Promise<AgentInputReceipt>, input: AgentInput,
): Promise<AgentInputReceipt> {
  try {
    const receipt = await send(input);
    return receipt.messageId === input.messageId ? receipt
      : { status: 'unknown', messageId: input.messageId, message: 'Input receipt mismatch; delivery is unknown' };
  } catch (error) {
    // A lost acknowledgement is not proof of rejection. Never queue/replay this input.
    return { status: 'unknown', messageId: input.messageId, message: String(error) };
  }
}

/** Adapt a native run once, before retrying, rendering, or background execution. */
export function withExecutionContract(native: NativeAgentRun, capabilities: AgentExecutionCapabilities): AgentRun {
  let active = true;
  const run: AgentRun = {
    runId: native.runId,
    capabilities,
    ...(native.detachOnShutdown ? { detachOnShutdown: true } : {}),
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
    async stop(reason) { active = false; await native.stop(reason); },
    waitForExit: timeoutMs => native.waitForExit(timeoutMs),
  };
  if (native.answerUserInput) {
    const answer = native.answerUserInput.bind(native);
    run.answerUserInput = async (id, value) => active ? answer(id, value) : 'inactive';
  }
  const scope = capabilities.input;
  if (scope !== 'unsupported' && native.sendInput) {
    const send = native.sendInput.bind(native);
    run.sendInput = async input => {
      if (!active) return { status: 'inactive', messageId: input.messageId };
      const receipt = await deliverInput(send, input);
      return receipt.status === 'accepted' ? { ...receipt, scope } : receipt;
    };
  }
  return run;
}
