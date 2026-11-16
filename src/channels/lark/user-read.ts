import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ApiMessageItem } from '@larksuite/channel';
import type { TenantBrand } from '../../config/schema';
import { log } from '../../core/logger';
import { larkFetch } from '../../lark-auth/network';
import type { UserTokenProvider } from '../../lark-auth/user-token';
import type { ChatMode } from './scope-types';

/**
 * Read-only IM calls made with the operator's *user* identity.
 *
 * The bridge normally reads with the app (tenant) identity. When the app is
 * missing a read scope — `im:message:readonly`, `im:chat:readonly`, ... — every
 * such call fails with 99991672 while the same call succeeds with a user token
 * the operator already authorized. Each method here is a drop-in for the
 * channel-SDK call it backs, and every one of them throws
 * {@link UserReadUnavailable} when no grant exists so the caller can stay on
 * the tenant path.
 *
 * Only reads live here: writes (send/card/stream) must stay on the app
 * identity so they don't depend on an individual's token.
 */

const OPEN_API_ORIGIN: Record<TenantBrand, string> = {
  feishu: 'https://open.feishu.cn',
  lark: 'https://open.larksuite.com',
};

const DEFAULT_TIMEOUT_MS = 20_000;
/** Error bodies are tiny JSON; cap what we read so a stream can't grow. */
const MAX_ERROR_BODY_BYTES = 2048;

export class UserReadUnavailable extends Error {
  constructor(message = 'no user grant available') {
    super(message);
    this.name = 'UserReadUnavailable';
  }
}

export interface LarkUserReadsOptions {
  tenant: TenantBrand;
  tokens: UserTokenProvider;
  request?: typeof fetch;
  timeoutMs?: number;
}

export interface MessageListPage {
  items: ApiMessageItem[];
  hasMore: boolean;
  pageToken?: string;
}

export interface ChatSummary {
  id: string;
  name: string;
}

export class LarkUserReads {
  private readonly tenant: TenantBrand;
  private readonly tokens: UserTokenProvider;
  private readonly request: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: LarkUserReadsOptions) {
    this.tenant = options.tenant;
    this.tokens = options.tokens;
    this.request = options.request ?? larkFetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** True when a user grant is on file and currently refreshable. */
  async available(): Promise<boolean> {
    try {
      return Boolean(await this.tokens.getAccessToken());
    } catch {
      return false;
    }
  }

  async messageItems(
    messageId: string,
    opts: { cardContentType?: string | null } = {},
  ): Promise<ApiMessageItem[]> {
    const cardContentType = opts.cardContentType === undefined
      ? 'user_card_content'
      : opts.cardContentType;
    const data = await this.getJson(`/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`, {
      ...(cardContentType ? { card_msg_content_type: cardContentType } : {}),
    });
    return asItems(data.items);
  }

  async threadMessages(params: {
    threadId: string;
    sortType?: 'ByCreateTimeAsc' | 'ByCreateTimeDesc';
    pageSize?: number;
    pageToken?: string;
  }): Promise<MessageListPage> {
    const data = await this.getJson('/open-apis/im/v1/messages', {
      container_id_type: 'thread',
      container_id: params.threadId,
      sort_type: params.sortType ?? 'ByCreateTimeDesc',
      page_size: String(Math.min(Math.max(params.pageSize ?? 50, 1), 50)),
      ...(params.pageToken ? { page_token: params.pageToken } : {}),
    });
    return {
      items: asItems(data.items ?? data.messages),
      hasMore: data.has_more === true,
      ...(typeof data.page_token === 'string' && data.has_more === true
        ? { pageToken: data.page_token }
        : {}),
    };
  }

  /**
   * Stream a message resource straight to disk. Mirrors
   * `channel.downloadResourceToFile`: returns the server content-type so the
   * caller can pick a file extension.
   */
  async downloadResource(
    messageId: string,
    fileKey: string,
    type: 'image' | 'file',
    destPath: string,
  ): Promise<{ contentType?: string }> {
    const token = await this.accessToken();
    const url = new URL(
      `${OPEN_API_ORIGIN[this.tenant]}/open-apis/im/v1/messages/${encodeURIComponent(messageId)}` +
        `/resources/${encodeURIComponent(fileKey)}`,
    );
    url.searchParams.set('type', type);
    const response = await this.request(url, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok || !response.body) {
      // Never hand the response stream to a caller/log: it carries the live
      // socket graph. Summarize the API's own code/msg instead.
      throw new Error(await describeFailure(response));
    }
    const contentType = response.headers.get('content-type') ?? undefined;
    await pipeline(Readable.fromWeb(response.body as never), createWriteStream(destPath));
    return contentType ? { contentType } : {};
  }

  async chatMode(chatId: string): Promise<ChatMode> {
    const data = await this.getJson(`/open-apis/im/v1/chats/${encodeURIComponent(chatId)}`, {});
    if (data.chat_mode === 'p2p') return 'p2p';
    if (data.chat_mode === 'topic') return 'topic';
    return 'group';
  }

  async listChats(opts: { pageSize?: number; maxPages?: number } = {}): Promise<ChatSummary[]> {
    const pageSize = String(Math.min(Math.max(opts.pageSize ?? 100, 1), 100));
    const maxPages = opts.maxPages ?? 10;
    const out: ChatSummary[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < maxPages; page += 1) {
      const data = await this.getJson('/open-apis/im/v1/chats', {
        page_size: pageSize,
        ...(pageToken ? { page_token: pageToken } : {}),
      });
      for (const item of Array.isArray(data.items) ? data.items : []) {
        if (!item || typeof item !== 'object') continue;
        const record = item as Record<string, unknown>;
        if (typeof record.chat_id !== 'string') continue;
        out.push({
          id: record.chat_id,
          name: typeof record.name === 'string' ? record.name : '',
        });
      }
      if (data.has_more !== true || typeof data.page_token !== 'string') break;
      pageToken = data.page_token;
    }
    return out;
  }

  private async accessToken(): Promise<string> {
    const token = await this.tokens.getAccessToken();
    if (!token) throw new UserReadUnavailable();
    return token.accessToken;
  }

  private async getJson(path: string, params: Record<string, string>): Promise<Record<string, unknown>> {
    const token = await this.accessToken();
    const url = new URL(`${OPEN_API_ORIGIN[this.tenant]}${path}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    const response = await this.request(url, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) throw new Error(await describeFailure(response));
    const body: unknown = await response.json().catch(() => undefined);
    const data = body && typeof body === 'object' ? (body as Record<string, unknown>).data : undefined;
    if (data && typeof data === 'object') return data as Record<string, unknown>;
    const code = body && typeof body === 'object' ? (body as Record<string, unknown>).code : undefined;
    if (code === 0) return {};
    throw new Error(`user read returned no data (code ${String(code ?? 'unknown')})`);
  }
}

/**
 * Run a user-identity read, falling back to the tenant-identity call when no
 * grant exists or the user call fails. Read failures are already best-effort
 * everywhere they're used, so a user-token hiccup must not turn into a missing
 * reply — it only loses the fallback's capabilities.
 */
export async function userFirst<T>(
  reads: LarkUserReads | undefined,
  phase: string,
  user: () => Promise<T>,
  fallback: () => Promise<T>,
): Promise<T> {
  if (!reads) return fallback();
  try {
    return await user();
  } catch (err) {
    if (!(err instanceof UserReadUnavailable)) {
      log.warn(phase, 'user-read-failed', {
        err: err instanceof Error ? err.message : String(err),
      });
    }
    return fallback();
  }
}

function asItems(value: unknown): ApiMessageItem[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is ApiMessageItem =>
    Boolean(item && typeof item === 'object' && typeof (item as { message_id?: unknown }).message_id === 'string'));
}

async function describeFailure(response: Response): Promise<string> {
  let summary = `HTTP ${response.status}`;
  try {
    const text = (await response.text()).slice(0, MAX_ERROR_BODY_BYTES);
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object') {
      const record = parsed as Record<string, unknown>;
      const code = record.code;
      const msg = typeof record.msg === 'string' ? record.msg : undefined;
      if (code !== undefined || msg) summary += ` code=${String(code ?? '?')}${msg ? ` msg=${msg}` : ''}`;
    }
  } catch {
    /* body was not JSON — the status is all we keep */
  }
  return summary;
}
