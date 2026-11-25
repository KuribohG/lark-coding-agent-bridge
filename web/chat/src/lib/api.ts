import type { Conversation, ConversationState, EngineInfo, Meta, ModelChoices, TranscriptItem } from './types';

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/**
 * A page that cannot reach the server over HTTP is given another way by its host document, which defines
 * `__bridgeChatFetch` before the page's script runs. The contract is `fetch`'s, streamed bodies included.
 */
const send: typeof fetch = (input, init) =>
  ((globalThis as { __bridgeChatFetch?: typeof fetch }).__bridgeChatFetch ?? fetch)(input, init);

export class Api {
  /**
   * `token` is empty for a page that reached the server through a proxy that adds it; the server's answer says
   * whether that is so. `base` is where the server is, for a caller that is not a page it served.
   */
  constructor(private readonly token: string, private readonly base = '') {}

  private headers(json = false): Record<string, string> {
    return { ...(this.token ? { 'x-ui-token': this.token } : {}), ...(json ? { 'Content-Type': 'application/json' } : {}) };
  }

  async request<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    let response: Response;
    try {
      response = await send(this.base + path, body === undefined
        ? { headers: this.headers(), signal }
        : { method: 'POST', headers: this.headers(true), body: JSON.stringify(body), signal });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new ApiError(0, '连接不到服务，请确认它还在运行。');
    }
    if (!response.ok) {
      let message = `请求失败（${response.status}）`;
      try { message = ((await response.json()) as { error?: string }).error || message; } catch { /* not JSON */ }
      throw new ApiError(response.status, message);
    }
    return response.json() as Promise<T>;
  }

  /** The page's one long-lived connection; the caller reads NDJSON lines from it. */
  stream(query: URLSearchParams, signal: AbortSignal): Promise<Response> {
    return send(`${this.base}api/stream?${query}`, { headers: this.headers(), signal });
  }

  meta = () => this.request<Meta>('api/meta');
  /** Without a conversation: what one that has not been started yet would begin with. */
  state = (conversationId?: string, signal?: AbortSignal) =>
    this.request<ConversationState>(`api/state${conversationId ? `?conversationId=${encodeURIComponent(conversationId)}` : ''}`, undefined, signal);
  models = (conversationId: string | undefined, agent: string, refresh = false, signal?: AbortSignal) => {
    const query = new URLSearchParams({ agent, ...(conversationId ? { conversationId } : {}), ...(refresh ? { refresh: '1' } : {}) });
    return this.request<ModelChoices>(`api/models?${query}`, undefined, signal);
  };
  engines = (signal?: AbortSignal) => this.request<{ engines: EngineInfo[] }>('api/engines', undefined, signal);
  /** A string chooses, `null` goes back to the default, an absent key leaves it as it is. */
  setModel = (conversationId: string, change: { agent?: string; model?: string | null; provider?: string | null; effort?: string | null }) =>
    this.request<ConversationState>('api/model', { conversationId, ...change });
  items = (conversationId: string, before: number, limit = 60) =>
    this.request<{ items: TranscriptItem[]; more: boolean }>(`api/items?conversationId=${encodeURIComponent(conversationId)}&before=${before}&limit=${limit}`);
  send = (conversationId: string, text: string, messageId: string) =>
    this.request<{ runId: string }>('api/send', { conversationId, text, messageId });
  command = (conversationId: string, text: string, messageId: string) =>
    this.request<{ reply?: string }>('api/command', { conversationId, text, messageId });
  input = (conversationId: string, runId: string, text: string, messageId: string) =>
    this.request<{ status: 'accepted' | 'inactive' | 'unsupported' | 'unknown' }>('api/input', { conversationId, runId, text, messageId });
  stop = (conversationId: string, runId: string) => this.request<{ stopped: boolean }>('api/stop', { conversationId, runId });
  answer = (conversationId: string, requestId: string, answers: string[][]) =>
    this.request<{ settled: boolean; message: string }>('api/answer', { conversationId, requestId, answers });
  setEngine = (conversationId: string, agent: string) =>
    this.request<{ agent: string }>('api/engine', { conversationId, agent });
  update = (conversationId: string, change: { title?: string; pinned?: boolean }) =>
    this.request<{ conversation: Conversation }>('api/conversation', { conversationId, ...change });
  remove = (conversationId: string) => this.request<{ deleted: boolean }>('api/conversation/delete', { conversationId });

  /** A read of the workflow views; `etag` makes an unchanged answer cost nothing. */
  async workflows<T>(path: string, etag?: string, signal?: AbortSignal): Promise<{ status: number; etag?: string; body?: T }> {
    const response = await send(`${this.base}api/workflows${path}`, { headers: { ...this.headers(), ...(etag ? { 'If-None-Match': etag } : {}) }, signal });
    if (response.status === 304) return { status: 304, etag };
    const body = await response.json().catch(() => undefined) as T | undefined;
    return { status: response.status, etag: response.headers.get('ETag') ?? undefined, body };
  }
}
