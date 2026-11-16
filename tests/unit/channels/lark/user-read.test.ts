import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LarkUserReads, UserReadUnavailable, userFirst } from '../../../../src/channels/lark/user-read';
import type { UserAccessToken, UserTokenProvider } from '../../../../src/lark-auth/user-token';

function tokensWith(value: UserAccessToken | undefined): UserTokenProvider {
  return {
    getAccessToken: async () => value,
  } as unknown as UserTokenProvider;
}

interface Captured {
  url: string;
  headers: Record<string, string>;
}

function fetchReturning(responders: ((captured: Captured) => Response | Promise<Response>)[]) {
  const calls: Captured[] = [];
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input);
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]),
    );
    const captured = { url, headers };
    calls.push(captured);
    const responder = responders.shift();
    if (!responder) throw new Error(`unexpected request to ${url}`);
    return responder(captured);
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const TOKEN: UserAccessToken = { accessToken: 'user-at', expiresAt: Date.now() + 3_600_000 };

function readsWith(fetchImpl: typeof fetch, token: UserAccessToken | undefined): LarkUserReads {
  return new LarkUserReads({ tenant: 'feishu', tokens: tokensWith(token), request: fetchImpl });
}

describe('LarkUserReads', () => {
  it('fetches message items with the user token and card content type', async () => {
    const { fetch: fetchImpl, calls } = fetchReturning([
      () => json({ code: 0, data: { items: [{ message_id: 'om_1' }, { message_id: 'om_2' }] } }),
    ]);
    const reads = readsWith(fetchImpl, TOKEN);

    const items = await reads.messageItems('om_1');
    expect(items.map(item => item.message_id)).toEqual(['om_1', 'om_2']);
    expect(calls[0]!.headers.authorization).toBe('Bearer user-at');
    expect(calls[0]!.url).toContain('/open-apis/im/v1/messages/om_1');
    expect(calls[0]!.url).toContain('card_msg_content_type=user_card_content');
  });

  it('pages thread messages and reports the cursor', async () => {
    const { fetch: fetchImpl, calls } = fetchReturning([
      () => json({
        code: 0,
        data: { items: [{ message_id: 'om_1' }], has_more: true, page_token: 'p2' },
      }),
      () => json({ code: 0, data: { items: [{ message_id: 'om_2' }], has_more: false } }),
    ]);
    const reads = readsWith(fetchImpl, TOKEN);

    const first = await reads.threadMessages({ threadId: 'omt_1' });
    expect(first).toMatchObject({ hasMore: true, pageToken: 'p2' });
    expect(calls[0]!.url).toContain('container_id_type=thread');
    expect(calls[0]!.url).toContain('container_id=omt_1');

    const second = await reads.threadMessages({ threadId: 'omt_1', pageToken: first.pageToken });
    expect(second).toMatchObject({ hasMore: false });
    expect(calls[1]!.url).toContain('page_token=p2');
  });

  it('maps chat mode and pages the chat list', async () => {
    const { fetch: fetchImpl } = fetchReturning([
      () => json({ code: 0, data: { chat_mode: 'topic' } }),
      () => json({
        code: 0,
        data: { items: [{ chat_id: 'oc_1', name: 'a' }], has_more: true, page_token: 'p2' },
      }),
      () => json({ code: 0, data: { items: [{ chat_id: 'oc_2' }], has_more: false } }),
    ]);
    const reads = readsWith(fetchImpl, TOKEN);

    await expect(reads.chatMode('oc_1')).resolves.toBe('topic');
    await expect(reads.listChats({ maxPages: 5 })).resolves.toEqual([
      { id: 'oc_1', name: 'a' },
      { id: 'oc_2', name: '' },
    ]);
  });

  it('streams a resource to disk and returns the content type', async () => {
    const { fetch: fetchImpl, calls } = fetchReturning([
      () => new Response(new Uint8Array([1, 2, 3, 4]), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      }),
    ]);
    const reads = readsWith(fetchImpl, TOKEN);
    const dir = await mkdtemp(join(tmpdir(), 'user-read-'));
    const dest = join(dir, 'img.png');
    try {
      const { contentType } = await reads.downloadResource('om_1', 'img_v3_x', 'image', dest);
      expect(contentType).toBe('image/png');
      expect(await readFile(dest)).toEqual(Buffer.from([1, 2, 3, 4]));
      expect(calls[0]!.url).toContain('/messages/om_1/resources/img_v3_x');
      expect(calls[0]!.url).toContain('type=image');
      expect(calls[0]!.headers.authorization).toBe('Bearer user-at');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('summarizes a failed download without exposing the response stream', async () => {
    const { fetch: fetchImpl } = fetchReturning([
      () => json({ code: 99991672, msg: 'no scope' }, 400),
    ]);
    const reads = readsWith(fetchImpl, TOKEN);
    const dir = await mkdtemp(join(tmpdir(), 'user-read-err-'));
    try {
      const error = await reads
        .downloadResource('om_1', 'img_v3_x', 'image', join(dir, 'img.png'))
        .catch((err: Error) => err);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain('HTTP 400');
      expect((error as Error).message).toContain('99991672');
      expect((error as Error).message).toContain('no scope');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('throws UserReadUnavailable when no grant is stored', async () => {
    const reads = readsWith(fakeFetchNever(), undefined);
    await expect(reads.messageItems('om_1')).rejects.toBeInstanceOf(UserReadUnavailable);
    await expect(reads.available()).resolves.toBe(false);
  });
});

describe('userFirst', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses the tenant path when no reads are configured', async () => {
    await expect(userFirst(undefined, 'quote',
      async () => 'user',
      async () => 'tenant',
    )).resolves.toBe('tenant');
  });

  it('falls back silently when the user grant is missing', async () => {
    const reads = readsWith(fakeFetchNever(), undefined);
    await expect(userFirst(reads, 'quote',
      () => reads.messageItems('om_1'),
      async () => [],
    )).resolves.toEqual([]);
  });

  it('falls back when the user call fails but keeps the user answer otherwise', async () => {
    const failing = readsWith(fetchReturning([() => json({ code: 1 }, 500)]).fetch, TOKEN);
    await expect(userFirst<unknown>(failing, 'quote',
      () => failing.messageItems('om_1'),
      async () => 'tenant',
    )).resolves.toBe('tenant');

    const working = readsWith(fetchReturning([() => json({ code: 0, data: { items: [{ message_id: 'om_1' }] } })]).fetch, TOKEN);
    await expect(userFirst(working, 'quote',
      () => working.messageItems('om_1'),
      async () => [],
    )).resolves.toHaveLength(1);
  });
});

function fakeFetchNever(): typeof fetch {
  return (async () => {
    throw new Error('network should not be used');
  }) as typeof fetch;
}
