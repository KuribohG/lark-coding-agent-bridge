import type { BridgePlugin } from '../api';
import { reply } from '../../commands/presentation';

export function createWorkflowsPlugin(): BridgePlugin {
  return {
    id: 'workflows',
    commands: [{
      pluginId: 'workflows',
      definition: { name: 'workflow', access: 'user', pending: 'preserve', arguments: 'verbatim',
        help: ['`/workflow start <任务>` — 启动工作流，可指定各 worker 的 harness 和模型；`/workflow status|pause|resume|cancel` — 管理当前工作流'] },
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
