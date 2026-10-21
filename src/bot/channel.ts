import {
  createLarkPlugin,
  type LegacyLarkStartChannelDeps,
  type LarkStartChannelEntryDeps,
} from '../channels/lark';
import { ChannelHost } from '../channels/plugin';
import type { BridgeChannel } from '../channels/lark/channel';
export * from '../channels/lark/channel';

export type LegacyStartChannelDeps = LegacyLarkStartChannelDeps;
export type StartChannelEntryDeps = LarkStartChannelEntryDeps;

/** Compatibility entry point for existing Lark profile hosts. */
export async function startChannel(deps: StartChannelEntryDeps): Promise<BridgeChannel> {
  const host = new ChannelHost();
  const bridge = await host.connect(createLarkPlugin(deps));
  return { ...bridge, disconnect: () => host.close() };
}
