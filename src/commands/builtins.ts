import type { Handler } from './types';
import type { CommandName } from './catalog';
import { reply } from './presentation';
import { handleNew, handleCd, handleWs } from './workspace';
import { handleResume } from './resume';
import { handleRecent } from './recent';
import { handleStatus } from './status';
import { handleHelp, handleDoc } from './utility';
import { handleAccount } from './account';
import { handleConfig } from './config';
import { handleStop, handleTimeout, handlePs, handleExit, handleReconnect } from './lifecycle';
import { handleDoctor } from './doctor';
import { handleInvite, handleRemove } from './access';
import { handleMeeting } from './meeting';
import { handleRun } from './run';
import { handleModelCommand } from './model';

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
