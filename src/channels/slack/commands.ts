import {
  commandDefinitionsFor,
  commandHelpLines,
  findCommand,
  parseSlashCommand,
  type CommandDefinition,
} from '../../commands/catalog';
import type {
  ConversationIdentity,
  ConversationRuntime,
  ConversationStatus,
} from '../../runtime/conversation';

/**
 * Slack command surface. Names, aliases and argument modes come from the
 * shared command catalog; this module only binds Slack handlers to the
 * commands the catalog exposes for the `slack` channel.
 */
export interface SlackCommandContext {
  runtime: ConversationRuntime;
  identity: ConversationIdentity;
  botUserId: string;
  reply(text: string): Promise<void>;
}

type SlackCommandHandler = (args: string, ctx: SlackCommandContext) => Promise<void>;

const handlers = {
  help: async (args, ctx) => {
    const target = args.trim().split(/\s+/)[0]?.replace(/^\//, '').toLowerCase() ?? '';
    if (!target) {
      await ctx.reply(slackHelpText(ctx.botUserId));
      return;
    }
    const definition = findCommand(target);
    if (!definition || !commandDefinitionsFor('slack').includes(definition)) {
      await ctx.reply(`Unknown command: /${target}\n\n${slackHelpText(ctx.botUserId)}`);
      return;
    }
    await ctx.reply(commandSummary(definition));
  },
  new: async (_args, ctx) => {
    try {
      const reset = await ctx.runtime.reset(ctx.identity);
      await ctx.reply(reset ? 'Started a new session in this thread.' : 'This thread has no previous session.');
    } catch (error) {
      await ctx.reply(errorMessage(error));
    }
  },
  status: async (_args, ctx) => {
    try {
      await ctx.reply(statusText(await ctx.runtime.status(ctx.identity)));
    } catch (error) {
      await ctx.reply(errorMessage(error));
    }
  },
  stop: async (_args, ctx) => {
    try {
      const status = await ctx.runtime.status(ctx.identity);
      if (!status.activeRunId) {
        await ctx.reply('No active run in this thread.');
        return;
      }
      const stopped = await ctx.runtime.stop(ctx.identity, status.activeRunId);
      await ctx.reply(stopped ? 'Stopping the active run.' : 'The run is no longer active.');
    } catch (error) {
      await ctx.reply(errorMessage(error));
    }
  },
  model: async (_args, ctx) => {
    try {
      const status = await ctx.runtime.status(ctx.identity);
      await ctx.reply(`This thread is using *${status.agentKind}*. Engine switching is available through the API in this version.`);
    } catch (error) {
      await ctx.reply(errorMessage(error));
    }
  },
} satisfies Record<string, SlackCommandHandler>;

export type SlackCommandName = keyof typeof handlers;

/** Fail fast when the catalog and the Slack handler table drift apart. */
const slackDefinitions = commandDefinitionsFor('slack');
const catalogNames = new Set(slackDefinitions.map(definition => definition.name));
for (const name of Object.keys(handlers)) {
  if (!catalogNames.has(name)) {
    throw new Error(`Slack handler /${name} is not exposed by the command catalog`);
  }
}
for (const name of catalogNames) {
  if (!(name in handlers)) {
    throw new Error(`Slack command /${name} has no handler`);
  }
}

/**
 * Dispatch one slash command for Slack. Returns false when the text is not a
 * slash command, so the caller can pass it to the agent unchanged.
 */
export async function handleSlackCommand(
  input: string,
  ctx: SlackCommandContext,
): Promise<boolean> {
  const parsed = parseSlashCommand(input, findCommand, { caseInsensitive: true });
  if (!parsed) return false;
  const name = parsed.definition?.name ?? parsed.name;
  const handler = (handlers as Record<string, SlackCommandHandler>)[name];
  if (!handler) {
    await ctx.reply(`Unknown command: /${parsed.name}\n\n${slackHelpText(ctx.botUserId)}`);
    return true;
  }
  await handler(parsed.args, ctx);
  return true;
}

export function slackHelpText(botUserId: string): string {
  return [
    '*Bridge commands*',
    ...commandHelpLines('', commandDefinitionsFor('slack'), 'slack')
      .map(line => line.replace(/^- /, '• ')),
    '',
    `Mention <@${botUserId}> in a channel to start a new thread conversation. DMs do not need a mention.`,
  ].join('\n');
}

function commandSummary(definition: CommandDefinition): string {
  const aliases = definition.aliases && definition.aliases.length > 0
    ? `*Aliases:* ${definition.aliases.map(alias => `\`/${alias}\``).join(', ')}`
    : undefined;
  return [
    `*${definition.name}*`,
    ...(aliases ? [aliases, ''] : []),
    ...commandHelpLines('', [definition], 'slack').map(line => line.replace(/^- /, '• ')),
  ].join('\n');
}

function statusText(status: ConversationStatus): string {
  return [
    `*Engine:* ${status.agentKind}`,
    `*State:* ${status.activeRunId ? 'running' : 'idle'}`,
    ...(status.activeRunId ? [`*Run:* \`${status.activeRunId}\``] : []),
  ].join('\n');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
