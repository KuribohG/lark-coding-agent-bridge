import type { LarkChannel } from '@larksuite/channel';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startKeepalive } from '../../../../src/channels/lark/keepalive';

afterEach(() => {
  vi.useRealTimers();
});

describe('Lark keepalive', () => {
  it('uses a fresh probe to detect recovery after the channel transport is stuck', async () => {
    vi.useFakeTimers();
    const request = vi.fn(async () => {
      throw new Error('stale transport');
    });
    const probe = vi.fn(async () => true);
    const forceReconnect = vi.fn(async () => {});
    const keepalive = startKeepalive({
      channel: disconnectedChannel(),
      domain: 'https://open.feishu.cn',
      request,
      probe,
      forceReconnect,
    });

    await vi.advanceTimersByTimeAsync(45_000);

    expect(probe).toHaveBeenCalledTimes(3);
    expect(request).not.toHaveBeenCalled();
    expect(forceReconnect).toHaveBeenCalledTimes(1);
    keepalive.stop();
  });

  it('does not churn the channel while the fresh probe still reports an outage', async () => {
    vi.useFakeTimers();
    const forceReconnect = vi.fn(async () => {});
    const keepalive = startKeepalive({
      channel: disconnectedChannel(),
      domain: 'https://open.feishu.cn',
      probe: async () => false,
      forceReconnect,
    });

    await vi.advanceTimersByTimeAsync(120_000);

    expect(forceReconnect).not.toHaveBeenCalled();
    keepalive.stop();
  });
});

function disconnectedChannel(): LarkChannel {
  return {
    getConnectionStatus: () => ({ state: 'disconnected', reconnectAttempts: 3 }),
  } as unknown as LarkChannel;
}
