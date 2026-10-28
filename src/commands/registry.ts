import { canRunAdminCommand } from '../policy/access';
import { log, reportMetric } from '../core/logger';
import { commandDefinitions, type CommandDefinition } from './catalog';
import { builtinHandlers } from './builtins';
import { reply } from './presentation';
import type {
  CommandContext,
  CommandDispatcher,
  FeatureCommandContribution,
  Handler,
} from './types';

export class CommandRegistry implements CommandDispatcher {
  private readonly definitionsByName = new Map<string, CommandDefinition>();
  private readonly handlersByName = new Map<string, Handler>();
  private readonly definitions: CommandDefinition[] = [];

  constructor(contributions: readonly FeatureCommandContribution[] = []) {
    for (const definition of commandDefinitions) {
      this.add(definition, builtinHandlers[definition.name], 'builtin');
    }
    for (const contribution of contributions) {
      this.add(contribution.definition, contribution.handler, contribution.pluginId);
    }
  }

  find(name: string): CommandDefinition | undefined {
    return this.definitionsByName.get(normalizeName(name));
  }

  list(): readonly CommandDefinition[] {
    return this.definitions;
  }

  helpLines(escapedAgentName: string): string[] {
    return this.definitions.flatMap(definition =>
      definition.help.map(line => `- ${line.replace('{agent}', () => escapedAgentName)}`));
  }

  async tryHandle(ctx: CommandContext): Promise<boolean> {
    const trimmed = ctx.msg.content.trim();
    if (!trimmed.startsWith('/')) return false;
    const parts = trimmed.split(/\s+/);
    const name = parts[0] ?? '';
    const definition = this.find(name);
    if (!definition) return false;
    const args = definition.arguments === 'verbatim'
      ? trimmed.slice(name.length).trimStart()
      : parts.slice(1).join(' ');
    return this.dispatch(definition, name, args, ctx, 'text');
  }

  async run(name: string, args: string, ctx: CommandContext): Promise<boolean> {
    const definition = this.find(name);
    return definition ? this.dispatch(definition, name, args, ctx, 'card') : false;
  }

  private add(definition: CommandDefinition, handler: Handler | undefined, source: string): void {
    if (!handler) throw new Error(`missing command handler: ${definition.name}`);
    const aliases = definition.aliases ?? [];
    for (const name of [definition.name, ...aliases]) {
      const normalized = normalizeName(name);
      if (!normalized || this.definitionsByName.has(normalized)) {
        throw new Error(`duplicate command from ${source}: ${name}`);
      }
      this.definitionsByName.set(normalized, definition);
      this.handlersByName.set(normalized, handler);
    }
    this.definitions.push(definition);
  }

  private async dispatch(
    definition: CommandDefinition,
    invokedName: string,
    args: string,
    ctx: CommandContext,
    source: 'text' | 'card',
  ): Promise<boolean> {
    if (
      definition.access === 'admin'
      && !canRunAdminCommand(ctx.controls.profileConfig, ctx.controls, ctx.msg.senderId).ok
    ) {
      log.info('command', 'admin-deny', {
        cmd: invokedName,
        sender: ctx.msg.senderId.slice(-6),
        ...(source === 'card' ? { via: 'card' } : {}),
      });
      if (source === 'text') await reply(ctx, '❌ 此命令仅管理员可用。');
      return true;
    }
    const handler = this.handlersByName.get(normalizeName(invokedName));
    if (!handler) return false;
    try {
      await handler(args, ctx);
    } catch (error) {
      log.fail('command', error, { cmd: invokedName });
      reportMetric('command_fail', 1, {
        step: source === 'text' ? 'dispatch' : 'handler',
      });
    }
    return true;
  }
}

function normalizeName(name: string): string {
  return name.startsWith('/') ? name.slice(1) : name;
}
