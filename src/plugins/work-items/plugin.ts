import { createMonitorRuntime } from './runtime';
import type { MonitorHost } from '../../monitoring/host';
import type { InboxManager } from '../../monitoring/sources/lark/manager';
import { loadMonitorRoot } from '../../monitoring/store';
import { reply } from '../../commands/presentation';
import { HttpError } from '../../ui/http';
import type {
  BridgePlugin,
  PluginAction,
  PluginContext,
  PluginHttpResponse,
  PluginHttpRoute,
} from '../api';

export interface WorkItemsPlugin extends BridgePlugin {
  readonly sources: ReturnType<typeof createMonitorRuntime>['sources'];
  readonly inbox: InboxManager;
}

export interface WorkItemsPluginOptions {
  monitorHost?: MonitorHost;
}

export function createWorkItemsPlugin(
  context: PluginContext,
  options: WorkItemsPluginOptions = {},
): WorkItemsPlugin {
  const monitors = createMonitorRuntime({
    configPath: context.configPath,
    rootDir: context.rootDir,
    profiles: profile => context.controlsFor(profile),
    host: options.monitorHost,
  });
  const inbox = monitors.controllers.lark;

  return {
    id: 'work-items',
    sources: monitors.sources,
    inbox,
    commands: [{
      pluginId: 'work-items',
      definition: {
        name: 'inbox',
        access: 'user',
        pending: 'preserve',
        arguments: 'words',
        help: ['`/inbox` — 查看和处理会话助理事项'],
      },
      handler: async (args, ctx) => {
        const work = async () => {
          const feedback = await inbox.command(args, {
            profile: ctx.controls.profile,
            operator: ctx.msg.senderId,
            chatId: ctx.msg.chatId,
            threadId: ctx.msg.threadId,
            messageId: ctx.msg.messageId,
          });
          if (feedback) await reply(ctx, feedback);
        };
        if (ctx.fromCardAction) void work().catch(() => {});
        else await work();
      },
    }],
    httpRoutes: createInboxHttpRoutes(inbox),
    validateAction: action => validateWorkItemsAction(context, action),
    reconcile: () => monitors.reconcile(),
    close: () => monitors.close(),
  };
}

export async function validateWorkItemsAction(
  context: Pick<PluginContext, 'configPath'>,
  action: PluginAction,
): Promise<void> {
  if (action.type !== 'model-service.remove') return;
  const root = await loadMonitorRoot(context.configPath);
  if (root?.inbox?.triageService === action.resource) {
    throw new Error('会话助理仍引用此模型服务，请先更改筛选服务');
  }
}

export function createInboxHttpRoutes(inbox: InboxManager): PluginHttpRoute[] {
  return [
    route('/api/inbox', ['GET', 'POST'], async request =>
      request.method === 'GET'
        ? inbox.view()
        : inbox.configure(await request.readJson())),
    route('/api/inbox/concurrency', ['POST'], async request =>
      inbox.configureConcurrency(await request.readJson())),
    route('/api/inbox/workbench', ['GET'], () => inbox.workbench()),
    route('/api/inbox/command', ['POST'], async request =>
      inbox.workbenchCommand(await request.readJson())),
    route('/api/inbox/check', ['POST'], async request =>
      inbox.checkSetup(await request.readJson())),
  ];
}

function route(
  path: string,
  methods: readonly string[],
  handler: (request: Parameters<PluginHttpRoute['handle']>[0]) =>
    Promise<unknown> | unknown,
): PluginHttpRoute {
  return {
    id: `work-items:${methods.join(',')}:${path}`,
    path,
    methods,
    async handle(request): Promise<PluginHttpResponse> {
      try {
        return { body: await handler(request) };
      } catch (error) {
        throw new HttpError(400, error instanceof Error ? error.message : '操作失败');
      }
    },
  };
}
