import { startLarkChannel, type BridgeChannel, type StartChannelDeps } from './channel';
import { ChannelHost, type ChannelPlugin } from '../plugin';

export { createLarkRunOutput } from './run-output';
export type { LarkRunOutputOptions } from './run-output';
export interface LarkConnection extends BridgeChannel { close(): Promise<void> }

export function createLarkPlugin(deps: StartChannelDeps): ChannelPlugin<LarkConnection> {
  return {
    id: `lark:${deps.controls.profile}`,
    async connect() {
      const bridge = await startLarkChannel(deps);
      return { ...bridge, close: () => bridge.disconnect() };
    },
  };
}

/** Connect one Lark profile through its own channel host. */
export async function startChannel(deps: StartChannelDeps): Promise<BridgeChannel> {
  const host = new ChannelHost();
  const bridge = await host.connect(createLarkPlugin(deps));
  return { ...bridge, disconnect: () => host.close() };
}
