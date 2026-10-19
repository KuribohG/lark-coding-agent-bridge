import { createLarkPlugin } from '../channels/lark';
import { ChannelHost } from '../channels/plugin';
import type { StartChannelDeps, BridgeChannel } from '../channels/lark/channel';
export * from '../channels/lark/channel';

/** Compatibility entry point for existing Lark profile hosts. */
export async function startChannel(deps: StartChannelDeps): Promise<BridgeChannel> {
  const host = new ChannelHost();
  const bridge = await host.connect(createLarkPlugin(deps));
  return { ...bridge, disconnect: () => host.close() };
}
