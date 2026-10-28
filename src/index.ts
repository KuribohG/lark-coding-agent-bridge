// Public exports for consumers that need the same rendering logic the bot uses.
export { renderCard } from './card/run-renderer';
export { renderText } from './card/text-renderer';
export {
  initialState,
  reduce,
  finalizeIfRunning,
  markInterrupted,
} from './card/run-state';
export type { RunState, ToolEntry, Block, ToolStatus, Terminal, FooterStatus } from './card/run-state';

// Optional telemetry hook (see README "Optional telemetry"). Types let an
// external adapter package implement the interface via `import type`; the
// runtime helpers are noop unless LARK_CHANNEL_TELEMETRY_MODULE is set.
export type {
  TelemetryAdapter,
  AdapterFactory,
  AdapterMeta,
  TelemetryEvent,
} from './core/telemetry';
export type {
  BridgePlugin,
  BridgePluginFactory,
  PluginAction,
  PluginContext,
  PluginHttpRequest,
  PluginHttpResponse,
  PluginHttpRoute,
} from './plugins/api';
export { PluginHost } from './plugins/host';
export type { CommandDefinition } from './commands/catalog';
export type {
  CommandContext,
  Controls,
  FeatureCommandContribution,
  Handler,
} from './commands/types';
export { reportMetric, reportError } from './core/logger';
