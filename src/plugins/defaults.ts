import type { BridgePluginFactory, PluginAction, PluginContext } from './api';
import { PluginHost } from './host';
import { createWorkflowsPlugin } from './workflows/plugin';
import {
  createWorkItemsPlugin,
  type WorkItemsPluginOptions,
} from './work-items/plugin';

export interface BuiltinPluginOptions extends WorkItemsPluginOptions {}

/** Explicit production composition. Core runtime code never imports these plugins. */
export function createBuiltinPlugins(
  options: BuiltinPluginOptions = {},
): BridgePluginFactory {
  return context => [createWorkItemsPlugin(context, options), createWorkflowsPlugin()];
}

/** One-shot validation used by configuration commands that do not host plugins. */
export async function validateBuiltinPluginAction(
  context: PluginContext,
  action: PluginAction,
): Promise<void> {
  const host = new PluginHost(createBuiltinPlugins(), context);
  try {
    await host.validateAction(action);
  } finally {
    await host.close();
  }
}
