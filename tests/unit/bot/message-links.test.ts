import { describe, expect, it } from 'vitest';
import {
  isLarkAppLink,
  lookupMessageAppLink,
  scopeAppLink,
} from '../../../src/bot/message-links';
import { createFakeChannel, type FakeChannel } from '../../helpers/fake-channel';

describe('Lark message links', () => {
  it('builds chat and topic fallback links', () => {
    expect(scopeAppLink('oc_chat')).toBe(
      'https://applink.feishu.cn/client/chat/open?openChatId=oc_chat',
    );
    expect(scopeAppLink('oc_chat:omt_topic')).toBe(
      'https://applink.feishu.cn/client/thread/open?open_chat_id=oc_chat&open_thread_id=omt_topic',
    );
    expect(scopeAppLink('invalid')).toBeUndefined();
  });

  it('returns the exact message app link from the raw message', async () => {
    const channel = createFakeChannel();
    const link = 'https://applink.feishu.cn/client/thread/open?open_chat_id=oc_chat&thread_position=3';
    channel.rawMessageLinks.set('om_source', link);

    await expect(lookupMessageAppLink(channel, 'om_source')).resolves.toBe(link);
  });

  it('rejects missing, malformed, and non-Feishu links', async () => {
    const channel = createFakeChannel() as FakeChannel;
    expect(await lookupMessageAppLink(channel, 'not-a-message')).toBeUndefined();
    expect(await lookupMessageAppLink(channel, 'om_missing')).toBeUndefined();
    expect(isLarkAppLink('https://example.com/message')).toBe(false);
  });
});
