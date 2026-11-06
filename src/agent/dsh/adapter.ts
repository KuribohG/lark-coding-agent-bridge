import type { AgentAdapter, AgentEvent, AgentRun, AgentRunOptions, NativeTurnBinding, PreparedAgentRun } from '../types';
import { classifyAgentFailure } from '../execution';
import { preparedRun } from '../prepared-run';
import { DSH_EXECUTION_CAPABILITIES } from './capabilities';

class Events {
  private items: AgentEvent[] = [];
  private wake?: () => void;
  private ended = false;
  push(event: AgentEvent): void { this.items.push(event); this.wake?.(); }
  close(): void { this.ended = true; this.wake?.(); }
  async *stream(): AsyncGenerator<AgentEvent> {
    while (!this.ended || this.items.length) {
      if (this.items.length) yield this.items.shift()!;
      else await new Promise<void>(resolve => { this.wake = resolve; });
    }
  }
}

export class DshAdapter implements AgentAdapter {
  readonly id = 'dsh';
  readonly displayName = 'DSH';
  readonly capabilities = DSH_EXECUTION_CAPABILITIES;
  async isAvailable(): Promise<boolean> { return true; }
  async prepareRun(options: AgentRunOptions): Promise<PreparedAgentRun> {
    if (!options.nativeTurn?.session) throw new Error('DSH requires a trusted host native-session binding');
    return preparedRun({ model: options.model, reasoningEffort: options.reasoningEffort }, () => this.start(options, options.nativeTurn!));
  }
  private start(options: AgentRunOptions, binding: NativeTurnBinding): AgentRun {
    const events = new Events();
    const session = binding.session;
    let terminal = false;
    const end = () => { terminal = true; unsubscribe(); events.close(); };
    const unsubscribe = session.subscribe((event: any) => {
      if (event.turnId !== binding.turnId || terminal) return;
      if (event.type === 'accepted') events.push({ type: 'system', sessionId: session.handle()?.nativeSessionId, model: options.model });
      else if (event.type === 'output-delta') events.push({ type: 'text', delta: event.text });
      else if (event.type === 'tool-request') {
        let input; try { input = JSON.parse(event.call.function.arguments); } catch { input = {}; }
        events.push({ type: 'tool_use', id: event.call.id, name: event.call.function.name, input });
      } else if (event.type === 'tool-result') events.push({ type: 'tool_result', id: event.call.id, output: JSON.stringify(event.result), isError: false });
      else if (event.type === 'completed') {
        events.push({ type: 'final_text', content: event.result?.content || '' });
        const usage = event.result?.usage;
        if (usage) events.push({ type: 'usage', inputTokens: usage.promptTokens, outputTokens: usage.completionTokens, cachedInputTokens: usage.cacheHitTokens });
        events.push({ type: 'done', sessionId: session.handle()?.nativeSessionId, terminationReason: 'normal' }); end();
      } else if (event.type === 'cancelled') { events.push({ type: 'done', terminationReason: 'interrupted' }); end(); }
      else if (event.type === 'failed' || event.type === 'connection-lost') {
        events.push({ type: 'error', message: event.error?.message || 'Native result is unavailable', terminationReason: 'failed',
          failureKind: event.type === 'connection-lost' || event.error?.reason === 'unknown' ? 'delivery_unknown' : classifyAgentFailure(event.error?.message || '') }); end();
      }
    });
    void session.submit({ turnId: binding.turnId, input: binding.input, invocation: binding.invocation, signal: binding.signal }).catch((error: any) => {
      if (terminal) return;
      events.push({ type: 'error', message: String(error.message || error), terminationReason: 'failed',
        failureKind: error.reason === 'unknown' ? 'delivery_unknown' : classifyAgentFailure(String(error.message || error)) }); end();
    });
    return { runId: options.runId, capabilities: this.capabilities, events: events.stream(),
      async stop() { await session.cancel({ turnId: binding.turnId }); },
      waitForQuiescence: timeoutMs => session.waitForQuiescence(timeoutMs),
      // A warm, drained session is deliberately not reported as an exited process.
      async waitForExit() { return session.state() === 'closed'; },
    };
  }
}
