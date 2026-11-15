import type { LarkChannel } from '@larksuite/channel';
import { createLarkCommandChannel } from '../../src/channels/lark/command-channel';
import type { CommandChannel } from '../../src/commands/types';

/**
 * Commands run against the same transport the Lark channel installs, with a
 * fake SDK client behind it, so tests observe what a real command would send.
 */
export function fakeCommandChannel<T>(channel: T): CommandChannel {
  return createLarkCommandChannel(channel as unknown as LarkChannel);
}
