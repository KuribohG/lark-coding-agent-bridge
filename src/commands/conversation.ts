import type {
  ConversationIdentity,
  ConversationModelSettings,
  ConversationRuntime,
  ConversationStatus,
} from '../runtime/conversation';
import { REASONING_EFFORTS } from '../agent/model-settings';
import {
  commandDefinitionsFor,
  commandHelpLines,
  findCommand,
  parseSlashCommand,
  type CommandChannelId,
  type CommandDefinition,
} from './catalog';
import type { CommandChannel, CommandMessage } from './types';

/**
 * A front end whose conversations are served by `ConversationRuntime` (Slack,
 * the Web chat, another server-side host). Its command surface is the shared
 * catalogue; the handlers here need only the runtime, so they are implemented
 * once instead of per front end.
 */
export interface ConversationCommandHost {
  runtime: ConversationRuntime;
  /** Authorized by the front end before the command runs. */
  identity: ConversationIdentity;
  /** Where replies go; the channel is bound to this conversation already. */
  channel: CommandChannel;
  message: CommandMessage;
  /** Which catalogue entries this front end exposes (`slack`, `web`, …). */
  surface: CommandChannelId;
  /** Appended to `/help`, e.g. how to start a conversation on this platform. */
  helpFooter?: string;
  /**
   * A command the front end adds outside the catalogue, such as `/workflow`.
   * Returns the text to show, `null` when it was handled without a reply
   * (a queued turn), or `undefined` when this host does not own the name.
   */
  command?(name: string, args: string, host: ConversationCommandHost): Promise<string | null | undefined>;
}

type ConversationCommandHandler = (args: string, host: ConversationCommandHost) => Promise<void>;

const handlers = {
  help: async (args, host) => {
    const target = args.trim().split(/\s+/)[0]?.replace(/^\//, '').toLowerCase() ?? '';
    if (!target) {
      await reply(host, helpText(host.surface, host.helpFooter));
      return;
    }
    const definition = findCommand(target);
    if (!definition || !commandDefinitionsFor(host.surface).includes(definition)) {
      await reply(host, `Unknown command: /${target}\n\n${helpText(host.surface, host.helpFooter)}`);
      return;
    }
    await reply(host, commandSummary(definition, host.surface));
  },
  new: async (_args, host) => {
    const reset = await host.runtime.reset(host.identity);
    await reply(host, reset ? 'Started a new session in this thread.' : 'This thread has no previous session.');
  },
  status: async (_args, host) => {
    await reply(host, statusText(await host.runtime.status(host.identity)));
  },
  stop: async (_args, host) => {
    const status = await host.runtime.status(host.identity);
    if (!status.activeRunId) {
      await reply(host, 'No active run in this thread.');
      return;
    }
    const stopped = await host.runtime.stop(host.identity, status.activeRunId);
    await reply(host, stopped ? 'Stopping the active run.' : 'The run is no longer active.');
  },
  model: async (args, host) => {
    const [model, effort, ...rest] = args.trim().split(/\s+/).filter(Boolean);
    if (!model) {
      await reply(host, `${modelText(await host.runtime.modelSettings(host.identity))}\n\n${MODEL_USAGE}`);
      return;
    }
    if (rest.length > 0 || (effort !== undefined && effort !== 'default' && !(REASONING_EFFORTS as readonly string[]).includes(effort))) {
      await reply(host, MODEL_USAGE);
      return;
    }
    const settings = await host.runtime.setModelSettings(host.identity, { model: model === 'default' ? null : model,
      ...(effort === undefined ? {} : { reasoningEffort: effort === 'default' ? null : effort }) });
    await reply(host, `From the next run:\n${modelText(settings)}`);
  },
  effort: async (args, host) => {
    const [effort, ...rest] = args.trim().split(/\s+/).filter(Boolean);
    if (!effort) {
      await reply(host, `${modelText(await host.runtime.modelSettings(host.identity))}\n\n${MODEL_USAGE}`);
      return;
    }
    if (rest.length > 0) {
      await reply(host, MODEL_USAGE);
      return;
    }
    const settings = await host.runtime.setModelSettings(host.identity, { reasoningEffort: effort === 'default' ? null : effort });
    await reply(host, `From the next run:\n${modelText(settings)}`);
  },
} satisfies Record<string, ConversationCommandHandler>;

const MODEL_USAGE = 'Usage: `/model <model|default> [effort]`, `/effort <level|default>`. A change applies from the next run.';

/**
 * Fails fast when the shared catalogue and this surface's handlers drift
 * apart, in either direction.
 */
export function assertConversationCommandsSupported(surface: CommandChannelId): void {
  const names = new Set(commandDefinitionsFor(surface).map(definition => definition.name));
  for (const name of Object.keys(handlers)) {
    if (!names.has(name)) throw new Error(`Conversation handler /${name} is not exposed for ${surface}`);
  }
  for (const name of names) {
    if (!(name in handlers)) throw new Error(`Command /${name} has no conversation handler for ${surface}`);
  }
}

/**
 * Dispatches one slash command for a runtime-backed conversation. Returns
 * false when the text is not a slash command, so the caller passes it to the
 * agent unchanged.
 */
export async function handleConversationCommand(
  input: string,
  host: ConversationCommandHost,
): Promise<boolean> {
  const parsed = parseSlashCommand(input, findCommand, { caseInsensitive: true });
  if (!parsed) return false;
  const name = parsed.definition?.name ?? parsed.name;
  try {
    const handler = (handlers as Record<string, ConversationCommandHandler>)[name];
    if (handler) {
      await handler(parsed.args, host);
      return true;
    }
    const extra = await host.command?.(parsed.name, parsed.args, host);
    if (extra !== undefined) {
      if (extra !== null) await reply(host, extra);
      return true;
    }
    await reply(host, `Unknown command: /${parsed.name}\n\n${helpText(host.surface, host.helpFooter)}`);
  } catch (error) {
    await reply(host, errorMessage(error));
  }
  return true;
}

export function conversationHelpText(surface: CommandChannelId, helpFooter?: string): string {
  return helpText(surface, helpFooter);
}

function helpText(surface: CommandChannelId, helpFooter?: string): string {
  return [
    '**Bridge commands**',
    ...commandHelpLines('', commandDefinitionsFor(surface), surface)
      .map(line => line.replace(/^- /, '• ')),
    ...(helpFooter ? ['', helpFooter] : []),
  ].join('\n');
}

function commandSummary(definition: CommandDefinition, surface: CommandChannelId): string {
  const aliases = definition.aliases && definition.aliases.length > 0
    ? `**Aliases:** ${definition.aliases.map(alias => `\`/${alias}\``).join(', ')}`
    : undefined;
  return [
    `**${definition.name}**`,
    ...(aliases ? [aliases, ''] : []),
    ...commandHelpLines('', [definition], surface).map(line => line.replace(/^- /, '• ')),
  ].join('\n');
}

const SOURCE = { scope: 'chosen here', profile: 'configured default', cli: 'engine default', model: 'model default' } as const;

function modelText(settings: ConversationModelSettings): string {
  const model = settings.provider && settings.model ? `${settings.provider} · ${settings.model}` : settings.model ?? settings.provider;
  return [
    `**Engine:** ${settings.agentKind}`,
    `**Model:** ${model ?? 'the engine\'s own'} (${SOURCE[settings.modelSource]})`,
    `**Effort:** ${settings.reasoningEffort ?? 'the engine\'s own'} (${SOURCE[settings.effortSource]})`,
    ...(settings.notice ? [settings.notice] : []),
  ].join('\n');
}

function statusText(status: ConversationStatus): string {
  return [`**Engine:** ${status.agentKind}`, `**State:** ${status.activeRunId ? 'running' : 'idle'}`].join('\n');
}

function reply(host: ConversationCommandHost, markdown: string): Promise<{ messageId: string }> {
  return host.channel.send(host.message.chatId, { markdown }, {
    replyTo: host.message.messageId,
    ...(host.message.threadId ? { replyInThread: true } : {}),
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
