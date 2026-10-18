import { handleModelCommand } from './model';
import { handleRun } from './run';
import { canRunAdminCommand } from '../policy/access';
import { log, reportMetric } from '../core/logger';
import type { Handler, CommandContext } from './types';
import { reply } from './presentation';
import { handleNew, handleCd, handleWs } from './workspace';
import { handleResume } from './resume';
import { handleStatus } from './status';
import { handleHelp, handleDoc } from './utility';
import { handleAccount } from './account';
import { handleConfig } from './config';
import { handleStop, handleTimeout, handlePs, handleExit, handleReconnect } from './lifecycle';
import { handleDoctor } from './doctor';
import { handleInvite, handleRemove } from './access';
import { handleMeeting } from './meeting';
import { findCommand, type CommandDefinition, type CommandName } from './catalog';

const handlers = {
  inbox: async (args, ctx) => {
    const manager = ctx.controls.inbox;
    if (!manager) { await reply(ctx, '当前 Bridge 尚未启用会话助理。'); return; }
    // CLI reads and history retrieval can exceed the card callback deadline.
    const work = async () => {
      const feedback = await manager.command(args, { profile: ctx.controls.profile, operator: ctx.msg.senderId, chatId: ctx.msg.chatId, threadId: ctx.msg.threadId, messageId: ctx.msg.messageId });
      if (feedback) await reply(ctx, feedback);
    };
    if (ctx.fromCardAction) void work().catch(() => {});
    else await work();
  },
  new: handleNew,
  cd: handleCd,
  ws: handleWs,
  resume: handleResume,
  status: handleStatus,
  help: handleHelp,
  account: handleAccount,
  config: handleConfig,
  run: handleRun,
  btw: async (args, ctx) => {
    if (ctx.controls.btw) await ctx.controls.btw.enqueue(args, ctx);
    else await reply(ctx, '当前入口暂不支持 /btw。');
  },
  model: (args, ctx) => handleModelCommand('model', args, ctx),
  effort: (args, ctx) => handleModelCommand('reasoningEffort', args, ctx),
  stop: handleStop,
  timeout: handleTimeout,
  ps: handlePs,
  exit: handleExit,
  doctor: handleDoctor,
  reconnect: handleReconnect,
  doc: handleDoc,
  invite: handleInvite,
  remove: handleRemove,
  meeting: handleMeeting,
} satisfies Record<CommandName, Handler>;

export type { CommandContext, Controls } from './types';

export async function tryHandleCommand(ctx: CommandContext): Promise<boolean> {
  const trimmed = ctx.msg.content.trim();
  if (!trimmed.startsWith('/')) return false;
  const parts = trimmed.split(/\s+/);
  const name = parts[0] ?? '';
  const definition = findCommand(name);
  if (!definition) return false;
  const args = definition.arguments === 'verbatim' ? trimmed.slice(name.length).trimStart() : parts.slice(1).join(' ');
  return dispatchCommand(definition, name, args, ctx, 'text');
}

/** Card buttons and text commands share authorization and handler selection. */
export async function runCommandHandler(name: string, args: string, ctx: CommandContext): Promise<boolean> {
  const definition = findCommand(name);
  return definition ? dispatchCommand(definition, name, args, ctx, 'card') : false;
}

async function dispatchCommand(definition: CommandDefinition, name: string, args: string,
  ctx: CommandContext, source: 'text' | 'card'): Promise<boolean> {
  if (definition.access === 'admin' && !canRunAdminCommand(ctx.controls.profileConfig, ctx.controls, ctx.msg.senderId).ok) {
    log.info('command', 'admin-deny', { cmd: name, sender: ctx.msg.senderId.slice(-6), ...(source === 'card' ? { via: 'card' } : {}) });
    if (source === 'text') await reply(ctx, '❌ 此命令仅管理员可用。');
    return true;
  }
  try { await handlers[definition.name](args, ctx); }
  catch (err) {
    log.fail('command', err, { cmd: name });
    reportMetric('command_fail', 1, { step: source === 'text' ? 'dispatch' : 'handler' });
  }
  return true;
}
