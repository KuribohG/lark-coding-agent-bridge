import type { AgentEvent, AgentQuestion, AgentQuestionAnswer } from '../types';
import type { ClaudeStreamInput } from './stream-input';

type RawEvent = Record<string, unknown>;
const object = (value: unknown): RawEvent => value !== null && typeof value === 'object' ? value as RawEvent : {};
const text = (value: unknown): string => typeof value === 'string' ? value : '';

const ASK_USER_QUESTION_TOOL = 'AskUserQuestion';
const PERMISSION_UNAVAILABLE = 'Interactive permission prompts are not available in this host; continue without this tool.';

/**
 * Answers the stdio permission-prompt protocol. Only AskUserQuestion reaches
 * the host as a blocking user_input; every other prompt is denied, matching a
 * non-interactive run without --permission-prompt-tool.
 */
export class ClaudeQuestionControl {
  private readonly pending = new Map<string, RawEvent>();

  constructor(private readonly input: ClaudeStreamInput) {}

  /** Undefined when `raw` is not a control message; otherwise the events it produces. */
  receive(raw: unknown): AgentEvent[] | undefined {
    const event = object(raw);
    if (event.type === 'control_cancel_request') {
      this.pending.delete(text(event.request_id));
      return [];
    }
    if (event.type === 'control_response') return [];
    if (event.type !== 'control_request') return undefined;
    const id = text(event.request_id);
    const request = object(event.request);
    if (!id) return [];
    if (request.subtype !== 'can_use_tool') {
      this.input.control({ type: 'control_response', response: { subtype: 'error', request_id: id,
        error: `Unsupported control request: ${text(request.subtype) || 'unknown'}` } });
      return [];
    }
    const toolInput = object(request.input);
    const questions = request.tool_name === ASK_USER_QUESTION_TOOL ? parseQuestions(toolInput.questions) : [];
    if (!questions.length) {
      this.respond(id, { behavior: 'deny', message: PERMISSION_UNAVAILABLE });
      return [];
    }
    this.pending.set(id, toolInput);
    const sessionId = this.input.currentSessionId;
    return [{ type: 'user_input', id, mode: 'blocking', questions, ...(sessionId ? { sessionId } : {}) }];
  }

  async answer(id: string, answer: AgentQuestionAnswer): Promise<'accepted' | 'inactive'> {
    const toolInput = this.pending.get(id);
    if (!toolInput) return 'inactive';
    let response: object;
    if ('declined' in answer) response = { behavior: 'deny', message: answer.declined };
    else {
      const questions = Array.isArray(toolInput.questions) ? toolInput.questions.map(object) : [];
      if (answer.answers.length !== questions.length) throw new Error('answer count does not match the questions');
      // Claude Code keys answers by question text and joins multi-select labels.
      const answers = Object.fromEntries(questions.map((q, i) => [text(q.question), answer.answers[i]!.join(', ')]));
      response = { behavior: 'allow', updatedInput: { ...toolInput, answers } };
    }
    if (!this.respond(id, response)) return 'inactive';
    this.pending.delete(id);
    return 'accepted';
  }

  close(): void {
    this.pending.clear();
  }

  private respond(id: string, response: object): boolean {
    return this.input.control({ type: 'control_response', response: { subtype: 'success', request_id: id, response } });
  }
}

function parseQuestions(value: unknown): AgentQuestion[] {
  if (!Array.isArray(value)) return [];
  const questions = value.map(object).map(q => ({
    question: text(q.question),
    ...(text(q.header) ? { header: text(q.header) } : {}),
    options: (Array.isArray(q.options) ? q.options : []).map(object).filter(o => text(o.label).trim())
      .map(o => ({ label: text(o.label), ...(text(o.description) ? { description: text(o.description) } : {}) })),
    ...(q.multiSelect === true ? { multiSelect: true } : {}),
  }));
  // A partially parseable request cannot be answered in Claude's expected shape.
  return questions.every(q => q.question.trim()) ? questions : [];
}
