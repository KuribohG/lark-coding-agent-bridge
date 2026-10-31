import type { RunOutputPlugin } from '../../runtime/run-output';
import { processAgentStream } from '../../runtime/run-stream';
import type { RunState, ToolEntry } from '../../runtime/run-state';
import type { SlackApi } from './api';
import type { SlackDisplayConfig } from './config';
import { boundSlackText, splitSlackText, toSlackMrkdwn } from './format';

export interface SlackRunOutputOptions {
  api: SlackApi;
  channel: string;
  threadTs: string;
  display: SlackDisplayConfig;
  progressIntervalMs?: number;
}

export function createSlackRunOutput(options: SlackRunOutputOptions): RunOutputPlugin {
  return {
    id: 'slack',
    render: input => renderSlackOutput(input, options),
  };
}

type SlackRunOutputInput = Parameters<RunOutputPlugin['render']>[0];

async function renderSlackOutput(
  input: SlackRunOutputInput,
  options: SlackRunOutputOptions,
): Promise<void> {
  const progressIntervalMs = options.progressIntervalMs ?? 1_200;
  let messageTs: string | undefined;
  let lastText = '';
  let lastUpdateAt = 0;

  const state = await processAgentStream(
    input.handle,
    input.events,
    input.scope,
    input.idleTimeoutMs,
    () => {},
    async current => {
      if (!options.display.show_progress && current.terminal === 'running') return;
      const text = toSlackMrkdwn(renderSlackState(current, options.display));
      if (!text || text === lastText) return;
      const terminal = current.terminal !== 'running';
      if (!terminal && messageTs && Date.now() - lastUpdateAt < progressIntervalMs) return;

      if (!messageTs) {
        messageTs = await options.api.postMessage({
          channel: options.channel,
          threadTs: options.threadTs,
          text: boundSlackText(text),
        });
      } else {
        await options.api.updateMessage({
          channel: options.channel,
          ts: messageTs,
          text: boundSlackText(text),
        });
      }
      lastText = text;
      lastUpdateAt = Date.now();
    },
  );

  const finalText = toSlackMrkdwn(renderSlackState(state, options.display, true));
  const chunks = splitSlackText(finalText);
  if (!messageTs) {
    messageTs = await options.api.postMessage({
      channel: options.channel,
      threadTs: options.threadTs,
      text: chunks.shift() ?? 'Run finished without a text response.',
    });
  } else {
    await options.api.updateMessage({
      channel: options.channel,
      ts: messageTs,
      text: chunks.shift() ?? 'Run finished without a text response.',
    });
  }
  for (const chunk of chunks) {
    await options.api.postMessage({
      channel: options.channel,
      threadTs: options.threadTs,
      text: chunk,
    });
  }
}

export function renderSlackState(
  state: RunState,
  display: SlackDisplayConfig,
  final = false,
): string {
  const textBlocks = state.blocks
    .filter((block): block is Extract<RunState['blocks'][number], { kind: 'text' }> => block.kind === 'text')
    .map(block => block.content.trim())
    .filter(Boolean);
  const answer = state.finalText?.trim() || textBlocks.join('\n\n').trim();
  const tools = display.show_tools
    ? state.blocks
        .filter((block): block is Extract<RunState['blocks'][number], { kind: 'tool' }> => block.kind === 'tool')
        .slice(-8)
        .map(block => renderTool(block.tool))
        .join('\n')
    : '';
  const parts: string[] = [];

  if (answer) parts.push(answer);
  if (!final && display.show_progress && tools) parts.push(tools);
  if (state.terminal === 'interrupted') parts.push('_Stopped._');
  if (state.terminal === 'idle_timeout') {
    parts.push(`_Stopped after ${state.idleTimeoutMinutes ?? 0} minutes without activity._`);
  }
  if (state.terminal === 'error') {
    parts.push(`*Agent failed:* ${state.errorMsg ?? 'unknown error'}`);
  }
  if (!parts.length) {
    if (state.terminal === 'running') return display.show_progress ? '_Working…_' : '';
    return '_Run finished without a text response._';
  }
  return parts.join('\n\n');
}

function renderTool(tool: ToolEntry): string {
  const icon = tool.status === 'done' ? '✓' : tool.status === 'error' ? '✗' : '…';
  return `> ${icon} ${tool.name}`;
}
