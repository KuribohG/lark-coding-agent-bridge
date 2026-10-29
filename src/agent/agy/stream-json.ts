import type { AgentEvent } from '../types';
import type { ProcessEventTranslator, ProcessStreamFinish } from '../process-run';
import { classifyAgentFailure } from '../execution';

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue => value && typeof value === 'object' && !Array.isArray(value)
  ? value as ObjectValue : {};
const text = (value: unknown): string => typeof value === 'string' ? value : '';
const number = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;

/** One native prompt per process; result.response is the authoritative final answer. */
export class AgyStreamTranslator implements ProcessEventTranslator {
  private sessionId?: string;
  private terminal = false;
  private completed = new Set<number>();
  private tools = new Set<number>();
  private finishedTools = new Set<number>();
  private steps = new Map<number, ObjectValue>();
  private usage = new Map<number, ObjectValue>();
  private notices: AgentEvent[] = [];

  stderr(line: string): void {
    if (/denied|requires? approval|permission.*(?:reject|block|allow)/i.test(line)) {
      this.notices.push({ type: 'status', code: 'tool-permission-denied', content: line.slice(0, 2000) });
    }
  }

  translate(value: unknown): AgentEvent[] {
    if (this.terminal) return [];
    const raw = object(value);
    const events = this.notices.splice(0);
    if (raw.event === 'init') {
      this.sessionId = text(raw.conversation_id) || this.sessionId;
      const init = object(raw.init);
      events.push({ type: 'system', sessionId: this.sessionId,
        cwd: text(init.cwd) || undefined, model: text(init.model) || undefined });
    } else if (raw.event === 'step_update') {
      const update = object(raw.step_update);
      const index = number(update.step_index);
      if (index === undefined) return events;
      const previous = this.steps.get(index);
      const step: ObjectValue = { ...previous, ...update,
        tool_info: { ...object(previous?.tool_info), ...object(update.tool_info) } };
      this.steps.set(index, step);
      if (this.completed.has(index) && step.step_type !== 'tool') return events;
      this.sessionId = text(step.conversation_id) || this.sessionId;
      if (step.state === 'DONE') {
        this.completed.add(index);
        if (step.usage) this.usage.set(index, object(step.usage));
      }
      const delta = text(update.text_delta);
      if (step.step_type === 'agent_response' && delta) events.push({ type: 'text', delta });
      if (step.step_type === 'thinking' && delta) events.push({ type: 'thinking', delta });
      if (step.step_type === 'tool') {
        const info = object(step.tool_info);
        const name = text(info.name) || text(step.tool_name);
        const id = `agy:${this.sessionId ?? 'run'}:${index}`;
        if (name && !this.tools.has(index)) {
          this.tools.add(index);
          events.push({ type: 'tool_use', id, name, input: info.parameters ?? {} });
        }
        if (step.state === 'DONE' && this.tools.has(index) && !this.finishedTools.has(index)
          && ('output' in info || 'error' in info)) {
          this.finishedTools.add(index);
          const error = object(info.error);
          events.push({ type: 'tool_result', id,
            output: text(info.output) || text(error.message) || (info.output ? JSON.stringify(info.output) : ''),
            isError: Boolean(info.error) });
        }
      }
    } else if (raw.event === 'result') {
      this.terminal = true;
      const result = object(raw.result);
      this.sessionId = text(result.conversation_id) || this.sessionId;
      const usage = this.usage.size ? this.sumUsage() : object(result.usage);
      if (Object.keys(usage).length) events.push({ type: 'usage',
        inputTokens: number(usage.input_tokens), outputTokens: number(usage.output_tokens),
        cachedInputTokens: number(usage.cache_read_tokens), reasoningOutputTokens: number(usage.thinking_tokens) });
      if (result.status === 'SUCCESS') {
        if (typeof result.response !== 'string') return [...events, this.error('agy SUCCESS result is missing response')];
        events.push({ type: 'final_text', content: result.response }, this.done('normal'));
      } else if (result.status === 'CANCELED' || result.status === 'INTERRUPTED') {
        events.push(this.done('interrupted'));
      } else {
        events.push(this.error(text(result.error) || `agy ended with status ${text(result.status) || 'unknown'}`));
      }
    }
    return events;
  }

  finish(state: ProcessStreamFinish): AgentEvent[] {
    if (this.terminal) return [];
    this.terminal = true;
    const events = this.notices.splice(0);
    if (state.timedOut) return [...events, this.done('timeout')];
    if (state.interrupted) return [...events, this.done('interrupted')];
    const message = state.runtimeError?.message || state.stderr || `agy exited with code ${state.exitCode} without a result`;
    return [...events, this.error(message)];
  }

  terminalEmitted(): boolean { return this.terminal; }

  private sumUsage(): ObjectValue {
    const result: Record<string, number> = {};
    for (const usage of this.usage.values()) for (const key of ['input_tokens', 'output_tokens', 'cache_read_tokens', 'thinking_tokens']) {
      const count = number(usage[key]);
      if (count !== undefined) result[key] = (result[key] ?? 0) + count;
    }
    return result;
  }

  private done(terminationReason: 'normal' | 'interrupted' | 'timeout'): AgentEvent {
    return { type: 'done', sessionId: this.sessionId, terminationReason };
  }

  private error(message: string): AgentEvent {
    return { type: 'error', message: message.slice(0, 4096), terminationReason: 'failed',
      failureKind: /sign in|log ?in|not authenticated|authentication required/i.test(message)
        ? 'authentication' : classifyAgentFailure(message) };
  }
}
