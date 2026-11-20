/**
 * Shell time limits for Pi CLI runs; see `bash-timeout.ts` for the reasoning.
 *
 * Pi lets a `tool_call` handler change a call's arguments in place, which is
 * the one place a default can be given to its built-in shell tool without
 * replacing the tool. It is built to `dist/pi-bash-timeout.js` and loaded with
 * `pi --extension <that file>`; the bridge passes the limits in the environment.
 *
 * Nothing here may break a run. Pi blocks a tool call whose `tool_call`
 * handler throws, so the handler swallows its own failures and the call then
 * runs as the model wrote it.
 */
import {
  bashTimeoutHint, bashTimeoutsFromEnv, boundBashTimeout, isPiShellTool,
  type BashTimeoutSource, type PiBashTimeouts,
} from './bash-timeout';

interface ToolContent { type: string; text?: string }

interface ToolCallEvent {
  toolName?: string;
  toolCallId?: string;
  input?: Record<string, unknown>;
}

interface ToolResultEvent {
  toolCallId?: string;
  content?: ToolContent[];
  isError?: boolean;
}

/** The slice of Pi's extension API this file uses. */
interface BashTimeoutExtensionApi {
  on(event: 'tool_call', handler: (event: ToolCallEvent) => void): unknown;
  on(event: 'tool_result', handler: (event: ToolResultEvent) => { content: ToolContent[] } | undefined): unknown;
}

export interface BashTimeoutExtensionOptions {
  limits?: PiBashTimeouts;
}

export default function bashTimeoutExtension(pi: BashTimeoutExtensionApi, options: BashTimeoutExtensionOptions = {}): void {
  const limits = options.limits ?? bashTimeoutsFromEnv(process.env);
  if (limits.defaultSeconds === undefined && limits.maxSeconds === undefined) return;

  /** Calls whose limit is not the model's own, until their result arrives. */
  const adjusted = new Map<string, { source: BashTimeoutSource; seconds: number }>();

  pi.on('tool_call', (event) => {
    try {
      const input = event.input;
      if (!isPiShellTool(event.toolName) || !input || typeof input !== 'object') return;
      const { seconds, source } = boundBashTimeout(input.timeout, limits);
      if (source === 'declared' || seconds === undefined) return;
      input.timeout = seconds;
      if (event.toolCallId) adjusted.set(event.toolCallId, { source, seconds });
    } catch {
      // The call runs as the model wrote it.
    }
  });

  pi.on('tool_result', (event) => {
    const bound = event.toolCallId ? adjusted.get(event.toolCallId) : undefined;
    if (!bound) return undefined;
    adjusted.delete(event.toolCallId!);
    const content = Array.isArray(event.content) ? event.content : [];
    // Pi ends the output of a call it stopped with this line.
    const stopped = event.isError === true
      && content.some(part => part.type === 'text' && part.text?.includes(`Command timed out after ${bound.seconds} seconds`));
    const hint = stopped ? bashTimeoutHint(bound.source, bound.seconds, limits) : undefined;
    return hint ? { content: [...content, { type: 'text', text: hint }] } : undefined;
  });
}
