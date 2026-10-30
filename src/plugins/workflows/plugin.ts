import type { BridgePlugin } from '../api';
import { reply } from '../../commands/presentation';

export function createWorkflowsPlugin(): BridgePlugin {
  return {
    id: 'workflows',
    commands: [{
      pluginId: 'workflows',
      definition: { name: 'workflow', access: 'user', pending: 'preserve', arguments: 'verbatim',
        help: ['`/workflow start <需求>` — 启动架构评审；`/workflow script <任务>` — 脚本编排，可选 harness；`/workflow status|pause|resume|cancel` — 管理当前工作流'] },
      handler: async (args, ctx) => {
        if (!ctx.controls.workflow) { await reply(ctx, '当前入口未启用工作流。'); return; }
        try {
          const response = await ctx.controls.workflow.command(ctx.scope, args, ctx.msg);
          if (response) await reply(ctx, response);
        } catch (error) { await reply(ctx, error instanceof Error ? error.message : String(error)); }
      },
    }],
    reconcile: async () => {},
    close: async () => {},
  };
}
