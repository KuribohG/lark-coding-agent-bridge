import type { AgentEvent } from '../types';
import type { ProcessEventTranslator, ProcessStreamFinish } from '../process-run';
import { classifyAgentFailure } from '../execution';

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue => value && typeof value === 'object' && !Array.isArray(value)
  ? value as ObjectValue : {};
const text = (value: unknown): string => typeof value === 'string' ? value : '';
const number = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;

function sanitizedSubagentsInput(subInfo: ObjectValue): ObjectValue {
  if (!Array.isArray(subInfo.subagents)) return {};
  return {
    subagents: subInfo.subagents.map(raw => {
      const sub = object(raw);
      const role = text(sub.role);
      const typeName = text(sub.type_name);
      const promptPreview = text(sub.initial_prompt).slice(0, 240);
      return {
        ...(role ? { role } : {}),
        ...(typeName ? { typeName } : {}),
        ...(promptPreview ? { promptPreview } : {}),
      };
    }),
  };
}

function sanitizedSubagentsOutput(subInfo: ObjectValue): string {
  if (!Array.isArray(subInfo.subagents) || subInfo.subagents.length === 0) return '';
  const subagents = subInfo.subagents.map(raw => {
    const sub = object(raw);
    const conversationId = text(sub.conversation_id);
    const role = text(sub.role);
    const typeName = text(sub.type_name);
    return {
      ...(conversationId ? { conversationId } : {}),
      ...(role ? { role } : {}),
      ...(typeName ? { typeName } : {}),
    };
  }).filter(item => Object.keys(item).length > 0);
  return subagents.length > 0 ? JSON.stringify({ subagents }) : '';
}

/** One native prompt per process; result.response is the authoritative final answer. */
export class AgyStreamTranslator implements ProcessEventTranslator {
  private sessionId?: string;
  private terminal = false;
  private completed = new Set<number>();
  private tools = new Set<number>();
  private finishedTools = new Set<number>();
  private steps = new Map<number, ObjectValue>();
  private usage = new Map<number, ObjectValue>();
  private responseSegments = new Map<number, string>();
  private nonResponseStepIndices = new Set<number>();
  private stepSubagentIds = new Map<string, string>();
  private subagentTasks = new Map<string, { label: string; agentId?: string; state: 'running' | 'completed' | 'failed' | 'stopped' }>();
  private latestUsageStep = -1;
  private latestUsage?: ObjectValue;
  private latestMainUsageStep = -1;
  private latestMainUsage?: ObjectValue;
  private notices: AgentEvent[] = [];

  constructor(private readonly answerIncludesInterimText = false) {}

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
      events.push(...this.flushCompletedTools(index));
      const previous = this.steps.get(index);
      const step: ObjectValue = {
        ...previous,
        ...update,
        tool_info: { ...object(previous?.tool_info), ...object(update.tool_info) },
        subagent_info: { ...object(previous?.subagent_info), ...object(update.subagent_info) },
      };
      this.steps.set(index, step);
      if (this.completed.has(index) && step.step_type !== 'tool' && step.step_type !== 'subagent') return events;
      this.sessionId = text(step.conversation_id) || this.sessionId;
      const stepTerminal = step.state === 'DONE' || step.state === 'ERROR';
      if (stepTerminal) {
        this.completed.add(index);
        if (step.usage) {
          const stepUsage = object(step.usage);
          this.usage.set(index, stepUsage);
          if (index >= this.latestUsageStep) {
            this.latestUsageStep = index;
            this.latestUsage = stepUsage;
          }
          if (step.step_type !== 'checkpoint' && index >= this.latestMainUsageStep) {
            this.latestMainUsageStep = index;
            this.latestMainUsage = stepUsage;
          }
        }
      }
      if (step.step_type === 'tool' || step.step_type === 'subagent' || step.step_type === 'system_message') {
        this.nonResponseStepIndices.add(index);
      }
      const delta = text(update.text_delta);
      if (step.step_type === 'agent_response' && delta) {
        this.responseSegments.set(index, (this.responseSegments.get(index) ?? '') + delta);
        events.push({ type: 'text', delta });
      }
      if (step.step_type === 'thinking' && delta) events.push({ type: 'thinking', delta });
      if (step.step_type === 'tool') {
        const info = object(step.tool_info);
        const name = text(info.name) || text(step.tool_name);
        const id = `agy:${this.sessionId ?? 'run'}:${index}`;
        if (name && !this.tools.has(index)) {
          this.tools.add(index);
          events.push({ type: 'tool_use', id, name, input: info.parameters ?? {} });
        }
        if (stepTerminal && this.tools.has(index) && !this.finishedTools.has(index)
          && ('output' in info || 'error' in info || step.state === 'ERROR')) {
          this.finishedTools.add(index);
          const error = object(info.error);
          events.push({ type: 'tool_result', id,
            output: text(info.output) || text(error.message) || (info.output ? JSON.stringify(info.output) : ''),
            isError: Boolean(info.error) || step.state === 'ERROR' });
        }
      }
      if (step.step_type === 'subagent') {
        const subInfo = object(step.subagent_info);
        const info = object(step.tool_info);
        const name = text(step.tool_name) || text(info.name) || 'invoke_subagent';
        const id = `agy:${this.sessionId ?? 'run'}:${index}`;
        if (!this.tools.has(index)) {
          this.tools.add(index);
          events.push({ type: 'tool_use', id, name, input: sanitizedSubagentsInput(subInfo) });
        }
        events.push(...this.emitSubagentTasks(index, step, false));
        const subs = Array.isArray(subInfo.subagents) ? subInfo.subagents : [];
        const hasConvId = subs.some(s => Boolean(text(object(s).conversation_id)));
        if (stepTerminal && this.tools.has(index) && !this.finishedTools.has(index)
          && (hasConvId || subs.length === 0 || 'output' in info || 'error' in info || step.state === 'ERROR')) {
          this.finishedTools.add(index);
          const error = object(info.error);
          const out = sanitizedSubagentsOutput(subInfo) || text(info.output) || text(error.message);
          events.push({
            type: 'tool_result',
            id,
            output: out,
            isError: Boolean(info.error) || step.state === 'ERROR',
          });
        }
      }
    } else if (raw.event === 'result') {
      this.terminal = true;
      const result = object(raw.result);
      this.sessionId = text(result.conversation_id) || this.sessionId;
      events.push(...this.flushCompletedTools());
      const settledState = result.status === 'SUCCESS'
        ? 'completed'
        : (result.status === 'CANCELED' || result.status === 'INTERRUPTED') ? 'stopped' : 'failed';
      events.push(...this.settleSubagentTasks(settledState));
      const usage = this.usage.size ? this.sumUsage() : object(result.usage);
      const latest = this.latestMainUsage ?? this.latestUsage ?? object(result.usage);
      const contextTokens = (number(latest.input_tokens) ?? 0)
        + (number(latest.cache_read_tokens) ?? 0)
        + (number(latest.output_tokens) ?? 0);
      if (Object.keys(usage).length || contextTokens > 0) events.push({
        type: 'usage',
        inputTokens: number(usage.input_tokens),
        outputTokens: number(usage.output_tokens),
        cachedInputTokens: number(usage.cache_read_tokens),
        reasoningOutputTokens: number(usage.thinking_tokens),
        ...(contextTokens > 0 ? { contextTokens } : {}),
      });
      if (result.status === 'SUCCESS') {
        if (typeof result.response !== 'string') return [...events, this.error('agy SUCCESS result is missing response')];
        let finalContent = result.response;
        if (!this.answerIncludesInterimText) {
          const segments = [...this.responseSegments.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([idx, body]) => ({ idx, body: body.trim() }))
            .filter(item => Boolean(item.body));
          if (segments.length >= 2) {
            const last = segments[segments.length - 1]!;
            const earlier = segments.slice(0, -1);
            const hasInterveningActivity = [...this.nonResponseStepIndices].some(i => i > earlier[0]!.idx && i < last.idx);
            const normRes = result.response.replace(/\r\n/g, '\n').trim();
            const normLast = last.body.replace(/\r\n/g, '\n').trim();
            if (hasInterveningActivity && normLast && normRes.endsWith(normLast)) {
              for (const seg of earlier) {
                events.push({ type: 'interim_answer', content: seg.body });
              }
              finalContent = last.body;
            }
          }
        }
        events.push({ type: 'final_text', content: finalContent }, this.done('normal'));
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
    events.push(...this.flushCompletedTools());
    events.push(...this.settleSubagentTasks(state.interrupted || state.timedOut ? 'stopped' : 'failed'));
    if (state.timedOut) return [...events, this.done('timeout')];
    if (state.interrupted) return [...events, this.done('interrupted')];
    const message = state.runtimeError?.message || state.stderr || `agy exited with code ${state.exitCode} without a result`;
    return [...events, this.error(message)];
  }

  terminalEmitted(): boolean { return this.terminal; }

  private emitSubagentTasks(index: number, step: ObjectValue, forceFallbackId: boolean): AgentEvent[] {
    const subInfo = object(step.subagent_info);
    const subagents = Array.isArray(subInfo.subagents) ? subInfo.subagents : [];
    const emitted: AgentEvent[] = [];
    const isError = step.state === 'ERROR';
    for (let subIdx = 0; subIdx < subagents.length; subIdx++) {
      const sub = object(subagents[subIdx]);
      const convId = text(sub.conversation_id);
      const role = text(sub.role);
      const typeName = text(sub.type_name);
      const label = role || typeName || 'Subagent';
      const description = text(sub.initial_prompt).slice(0, 400) || undefined;
      const key = `${index}:${subIdx}`;
      if (!this.stepSubagentIds.has(key)) {
        if (!convId && !isError && !forceFallbackId) continue;
        const taskId = convId || `agy:${this.sessionId ?? 'run'}:subagent:${index}:${subIdx}`;
        const state: 'running' | 'failed' = isError ? 'failed' : 'running';
        this.stepSubagentIds.set(key, taskId);
        this.subagentTasks.set(taskId, { label, agentId: convId || undefined, state });
        emitted.push({
          type: 'task',
          id: taskId,
          kind: 'agent',
          nativeType: typeName || 'subagent',
          state,
          name: label,
          ...(description ? { description } : {}),
          background: true,
          members: [{
            index: 0,
            label,
            ...(convId ? { agentId: convId } : {}),
            state: isError ? 'error' : 'running',
          }],
        });
      } else if (isError) {
        const taskId = this.stepSubagentIds.get(key)!;
        const tracked = this.subagentTasks.get(taskId);
        if (tracked && tracked.state !== 'failed') {
          tracked.state = 'failed';
          emitted.push({
            type: 'task',
            id: taskId,
            state: 'failed',
            members: [{
              index: 0,
              label: tracked.label,
              ...(tracked.agentId ? { agentId: tracked.agentId } : {}),
              state: 'error',
            }],
          });
        }
      }
    }
    return emitted;
  }

  private settleSubagentTasks(finalState: 'completed' | 'failed' | 'stopped'): AgentEvent[] {
    const settled: AgentEvent[] = [];
    const memberState = finalState === 'completed' ? 'done' : finalState === 'stopped' ? 'stopped' : 'error';
    for (const [taskId, tracked] of this.subagentTasks) {
      if (tracked.state !== 'running') continue;
      tracked.state = finalState;
      settled.push({
        type: 'task',
        id: taskId,
        state: finalState,
        members: [{
          index: 0,
          label: tracked.label,
          ...(tracked.agentId ? { agentId: tracked.agentId } : {}),
          state: memberState,
        }],
      });
    }
    return settled;
  }

  private flushCompletedTools(exceptIndex?: number): AgentEvent[] {
    const flushed: AgentEvent[] = [];
    for (const idx of this.tools) {
      if (idx !== exceptIndex && (exceptIndex === undefined || this.completed.has(idx)) && !this.finishedTools.has(idx)) {
        this.finishedTools.add(idx);
        const step = this.steps.get(idx);
        if (step?.step_type === 'subagent') {
          flushed.push(...this.emitSubagentTasks(idx, step, true));
        }
        const info = object(step?.tool_info);
        const error = object(info.error);
        const subOut = step?.step_type === 'subagent' ? sanitizedSubagentsOutput(object(step.subagent_info)) : '';
        flushed.push({
          type: 'tool_result',
          id: `agy:${this.sessionId ?? 'run'}:${idx}`,
          output: subOut || text(info.output) || text(error.message) || (info.output ? JSON.stringify(info.output) : ''),
          isError: Boolean(info.error) || step?.state === 'ERROR',
        });
      }
    }
    return flushed;
  }

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
