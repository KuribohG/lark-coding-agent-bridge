import type { Handler } from './types';
import type { CommandName } from './catalog';
import { reply } from './presentation';
import { handleNew, handleCd, handleWs } from './workspace';
import { handleResume } from './resume';
import { handleRecent } from './recent';
import { handleStatus } from './status';
import { handleHelp } from './utility';
import { handleAccount } from './account';
import { handleConfig } from './config';
import { handleStop, handleTimeout, handlePs, handleExit, handleReconnect } from './lifecycle';
import { handleDoctor } from './doctor';
import { handleInvite, handleRemove } from './access';
import { handleRun } from './run';
import { handleModelCommand } from './model';
import { handleAgent } from './agent';

export const builtinHandlers = {
  new: handleNew,
  cd: handleCd,
  ws: handleWs,
  resume: handleResume,
  recent: handleRecent,
  status: handleStatus,
  help: handleHelp,
  account: handleAccount,
  config: handleConfig,
  run: handleRun,
  btw: async (args, ctx) => {
    if (ctx.controls.channel) await ctx.controls.channel.btw.enqueue(args, ctx);
    else await reply(ctx, '当前入口暂不支持 /btw。');
  },
  model: (args, ctx) => handleModelCommand('model', args, ctx),
  agent: handleAgent,
  effort: (args, ctx) => handleModelCommand('reasoningEffort', args, ctx),
  stop: handleStop,
  timeout: handleTimeout,
  ps: handlePs,
  exit: handleExit,
  doctor: handleDoctor,
  reconnect: handleReconnect,
  invite: handleInvite,
  remove: handleRemove,
} satisfies Record<CommandName, Handler>;
