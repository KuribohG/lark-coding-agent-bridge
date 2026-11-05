import { createLarkPlugin } from '../channels/lark';
import { ChannelHost } from '../channels/plugin';
import type { BridgeChannel, StartChannelDeps } from '../channels/lark/channel';
export * from '../channels/lark/channel';

/** Connect one Lark profile through its own channel host. */
export async function startChannel(deps: StartChannelDeps): Promise<BridgeChannel> {
  const host = new ChannelHost();
  const bridge = await host.connect(createLarkPlugin(deps));
  return { ...bridge, disconnect: () => host.close() };
}
