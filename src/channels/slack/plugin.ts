import { join } from 'node:path';
import type { AgentBotIdentity } from '../../agent/types';
import type { ChannelPlugin } from '../plugin';
import { log } from '../../core/logger';
import {
  createConversationRuntime,
  type ConversationIdentity,
  type ConversationRuntime,
  type ConversationRuntimeOptions,
} from '../../runtime/conversation';
import { acquireHostLock } from '../../runtime/host-lock';
import { createSlackApi, type SlackApi, type SlackAuthIdentity } from './api';
import { SLACK_DISPLAY_DEFAULTS, SLACK_SYSTEM_PROMPT, type SlackDisplayConfig } from './config';
import { normalizeSlackText, toSlackMrkdwn } from './format';
import { createSlackRunOutput } from './output';
import { SlackThreadStore } from './thread-store';
import {
  createSocketModeSlackTransport,
  type SlackEventEnvelope,
  type SlackMessageEvent,
  type SlackTransport,
} from './transport';

export interface SlackChannelOptions extends Omit<
  ConversationRuntimeOptions,
  'channelId' | 'authorize' | 'systemPrompt'
> {
  botToken?: string;
  appToken?: string;
  teamId?: string;
  allowedUsers?: string[];
  allowedChannels?: string[];
  allowAllUsers?: boolean;
  display?: Partial<SlackDisplayConfig>;
  progressIntervalMs?: number;
  systemPrompt?: string;
  api?: SlackApi;
  transport?: SlackTransport;
}

export interface SlackConnection {
  teamId: string;
  botUserId: string;
  close(): Promise<void>;
}

type MessageEvent = SlackMessageEvent & {
  type: 'message' | 'app_mention';
  user: string;
  text: string;
};

export function createSlackPlugin(options: SlackChannelOptions): ChannelPlugin<SlackConnection> {
  return {
    id: `slack:${options.namespace}`,
    connect: () => startSlackChannel(options),
  };
}

async function startSlackChannel(options: SlackChannelOptions): Promise<SlackConnection> {
  const lock = await acquireHostLock(join(options.stateDir, 'slack-host.lock'));
  if (!lock) throw new Error('Slack state directory is already in use or cannot be locked');

  const api = options.api ?? createSlackApi(requireValue(options.botToken, 'Slack bot token'));
  const transport = options.transport
    ?? createSocketModeSlackTransport(requireValue(options.appToken, 'Slack app-level token'));
  let runtime: ConversationRuntime | undefined;
  let closed = false;

  try {
    const identity = await api.authTest();
    if (options.teamId && options.teamId !== identity.teamId) {
      throw new Error(`Slack token belongs to team ${identity.teamId}, not configured team ${options.teamId}`);
    }

    const allowedUsers = new Set(options.allowedUsers ?? []);
    const allowedChannels = new Set(options.allowedChannels ?? []);
    if (!options.allowAllUsers && allowedUsers.size === 0) {
      throw new Error('Slack requires allowedUsers or explicit allowAllUsers=true');
    }

    const display = { ...SLACK_DISPLAY_DEFAULTS, ...options.display };
    const threads = new SlackThreadStore(options.stateDir);
    await threads.load();

    const botIdentity: AgentBotIdentity = {
      openId: identity.userId,
      ...(identity.userName ? { name: identity.userName } : {}),
    };
    options.execution?.setBotIdentity(botIdentity);
    options.agent?.setBotIdentity?.(botIdentity);

    runtime = await createConversationRuntime({
      ...options,
      channelId: 'slack',
      systemPrompt: options.systemPrompt ?? SLACK_SYSTEM_PROMPT,
      authorize: async input => authorizeSlackIdentity(
        input,
        allowedUsers,
        allowedChannels,
        options.allowAllUsers === true,
      ),
    });
    const activeRuntime = runtime;
    const seenEvents = new SeenEvents();

    const handle = async (incoming: SlackEventEnvelope): Promise<void> => {
      if (closed || incoming.teamId !== identity.teamId) return;
      const event = normalizeEvent(incoming.event, identity);
      if (!event) return;

      const isDm = event.channel_type === 'im' || event.channel.startsWith('D');
      const rootTs = event.thread_ts ?? event.ts;
      const isThreadFollowup = !isDm && Boolean(event.thread_ts) && threads.has(event.channel, rootTs);
      if (!isDm && incoming.event.type === 'message' && !isThreadFollowup) return;
      if (!isDm && !allowedChannels.has(event.channel)) return;
      if (seenEvents.has(incoming)) return;

      const senderAllowed = options.allowAllUsers === true || allowedUsers.has(event.user);
      if (!senderAllowed) {
        if (incoming.event.type === 'app_mention' || isDm || isThreadFollowup) {
          await reply(api, event, 'You are not allowed to use this bridge.');
        }
        return;
      }

      const prompt = normalizeSlackText(event.text, identity.userId);
      if (!prompt) {
        await reply(api, event, helpText(identity));
        return;
      }

      if (!isDm) await threads.add(event.channel, rootTs);

      const command = parseCommand(prompt);
      if (command) {
        await handleCommand(command, activeRuntime, api, event, identity, botIdentity);
        return;
      }

      const reactionAdded = await addReaction(api, event, 'eyes');
      try {
        const result = await activeRuntime.start(
          {
            actorId: event.user,
            conversationId: conversationId(event.channel, rootTs),
            prompt,
          },
          createSlackRunOutput({
            api,
            channel: event.channel,
            threadTs: rootTs,
            display,
            progressIntervalMs: options.progressIntervalMs,
          }),
        );
        if (!result.ok) {
          await reply(api, event, result.rejectReason.userVisible);
          return;
        }
        await result.done;
        await result.execution.result;
      } catch (error) {
        log.fail('slack', error, { step: 'run', channel: event.channel });
        await reply(api, event, `Run failed: ${errorMessage(error)}`).catch(() => {});
      } finally {
        if (reactionAdded) await removeReaction(api, event, 'eyes');
      }
    };

    transport.onEvent('app_mention', handle);
    transport.onEvent('message', handle);
    transport.onError(error => log.fail('slack', error, { step: 'socket' }));
    await transport.start();

    return {
      teamId: identity.teamId,
      botUserId: identity.userId,
      async close() {
        if (closed) return;
        closed = true;
        try {
          await transport.close();
          await activeRuntime.close();
        } finally {
          await lock.release();
        }
      },
    };
  } catch (error) {
    closed = true;
    await runtime?.close().catch(() => {});
    await transport.close().catch(() => {});
    await lock.release();
    throw error;
  }
}

function authorizeSlackIdentity(
  input: ConversationIdentity,
  allowedUsers: Set<string>,
  allowedChannels: Set<string>,
  allowAllUsers: boolean,
): boolean {
  const parsed = parseConversationId(input.conversationId);
  if (!parsed) return false;
  if (!allowAllUsers && !allowedUsers.has(input.actorId)) return false;
  if (parsed.channel.startsWith('D')) return true;
  return allowedChannels.has(parsed.channel);
}

function normalizeEvent(
  event: SlackMessageEvent,
  identity: SlackAuthIdentity,
): MessageEvent | undefined {
  if (event.bot_id || event.subtype || !event.user || !event.ts || !event.text) return undefined;
  if (event.user === identity.userId) return undefined;
  return event as MessageEvent;
}

function parseCommand(input: string): string | undefined {
  const match = /^\/([a-z][a-z0-9_-]*)\b/i.exec(input);
  return match?.[1]?.toLowerCase();
}

async function handleCommand(
  command: string,
  runtime: ConversationRuntime,
  api: SlackApi,
  event: MessageEvent,
  identity: SlackAuthIdentity,
  botIdentity: AgentBotIdentity,
): Promise<void> {
  const who = {
    actorId: event.user,
    conversationId: conversationId(event.channel, event.thread_ts ?? event.ts),
  };
  switch (command) {
    case 'help':
      await reply(api, event, helpText(identity));
      return;
    case 'new': {
      try {
        const reset = await runtime.reset(who);
        await reply(api, event, reset ? 'Started a new session in this thread.' : 'This thread has no previous session.');
      } catch (error) {
        await reply(api, event, errorMessage(error));
      }
      return;
    }
    case 'status': {
      try {
        const status = await runtime.status(who);
        await reply(
          api,
          event,
          [
            `*Engine:* ${status.agentKind}`,
            `*State:* ${status.activeRunId ? 'running' : 'idle'}`,
            ...(status.activeRunId ? [`*Run:* \`${status.activeRunId}\``] : []),
          ].join('\n'),
        );
      } catch (error) {
        await reply(api, event, errorMessage(error));
      }
      return;
    }
    case 'stop': {
      try {
        const status = await runtime.status(who);
        if (!status.activeRunId) {
          await reply(api, event, 'No active run in this thread.');
          return;
        }
        const stopped = await runtime.stop(who, status.activeRunId);
        await reply(api, event, stopped ? 'Stopping the active run.' : 'The run is no longer active.');
      } catch (error) {
        await reply(api, event, errorMessage(error));
      }
      return;
    }
    case 'model': {
      const status = await runtime.status(who);
      await reply(api, event, `This thread is using *${status.agentKind}*. Engine switching is available through the API in this version.`);
      return;
    }
    default:
      await reply(api, event, `Unknown command: /${command}\n\n${helpText(identity, botIdentity)}`);
  }
}

function helpText(identity: SlackAuthIdentity, botIdentity?: AgentBotIdentity): string {
  return [
    '*Bridge commands*',
    '• `/status` — show engine and run state',
    '• `/stop` — stop the active run',
    '• `/new` — forget this thread\'s native session',
    '• `/model` — show the current engine',
    '',
    `Mention <@${botIdentity?.openId ?? identity.userId}> in a channel to start a new thread conversation. DMs do not need a mention.`,
  ].join('\n');
}

async function reply(api: SlackApi, event: MessageEvent, text: string): Promise<void> {
  await api.postMessage({
    channel: event.channel,
    threadTs: event.thread_ts ?? event.ts,
    text: toSlackMrkdwn(text),
  });
}

async function addReaction(api: SlackApi, event: MessageEvent, name: string): Promise<boolean> {
  try {
    await api.addReaction({ channel: event.channel, timestamp: event.ts, name });
    return true;
  } catch (error) {
    if (!isIgnorableReactionError(error)) log.fail('slack', error, { step: 'reaction-add', name });
    return reactionErrorCode(error) === 'already_reacted';
  }
}

async function removeReaction(api: SlackApi, event: MessageEvent, name: string): Promise<void> {
  try {
    await api.removeReaction({ channel: event.channel, timestamp: event.ts, name });
  } catch (error) {
    if (!isIgnorableReactionError(error)) log.fail('slack', error, { step: 'reaction-remove', name });
  }
}

function reactionErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('data' in error)) return undefined;
  return (error as { data?: { error?: string } }).data?.error;
}

function isIgnorableReactionError(error: unknown): boolean {
  const code = reactionErrorCode(error);
  return code === 'already_reacted' || code === 'no_reaction';
}

function conversationId(channel: string, threadTs: string): string {
  return `${channel}/${threadTs}`;
}

function parseConversationId(value: string): { channel: string; threadTs: string } | undefined {
  const separator = value.indexOf('/');
  if (separator <= 0 || separator === value.length - 1) return undefined;
  return { channel: value.slice(0, separator), threadTs: value.slice(separator + 1) };
}

function requireValue(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new Error(`${name} is required`);
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class SeenEvents {
  private readonly entries = new Map<string, number>();

  has(input: SlackEventEnvelope): boolean {
    const messageKey = `message:${input.teamId}:${input.event.channel}:${input.event.ts}`;
    const key = input.eventId
      ? `event:${input.eventId}`
      : messageKey;
    const now = Date.now();
    for (const [entry, expiresAt] of this.entries) {
      if (expiresAt > now) break;
      this.entries.delete(entry);
    }
    if (this.entries.has(key) || this.entries.has(messageKey)) return true;
    this.entries.set(key, now + 10 * 60_000);
    this.entries.set(messageKey, now + 10 * 60_000);
    return false;
  }
}
