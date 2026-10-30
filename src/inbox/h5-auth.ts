import { createHash, randomBytes } from 'node:crypto';
import { TenantTokenProvider } from '../lark-auth/tenant-token';
import { obj } from './values';
import { larkFetch } from '../lark-auth/network';

export interface InboxH5AuthOptions {
  appId: string;
  appSecret: string;
  ownerOpenId: string;
  publicUrl: string;
  tenant: 'feishu' | 'lark';
  request?: typeof fetch;
  now?: () => number;
  tenantTokens?: TenantTokenProvider;
}

export class InboxH5Auth {
  private readonly appId: string;
  private readonly secret: string;
  private readonly owner: string;
  readonly publicUrl: string;
  private readonly brand: 'feishu' | 'lark';
  private readonly request: typeof fetch;
  private readonly now: () => number;
  private readonly tenantTokens: TenantTokenProvider;
  private ticket?: { value: string; expires: number };
  private ticketPending?: Promise<string>;
  private challenges = new Map<string, number>();
  private sessions = new Map<string, number>();
  private requests: number[] = [];
  constructor(options: InboxH5AuthOptions) {
    this.appId = options.appId;
    this.secret = options.appSecret;
    this.owner = options.ownerOpenId;
    this.publicUrl = options.publicUrl;
    this.brand = options.tenant;
    this.request = options.request ?? larkFetch;
    this.now = options.now ?? Date.now;
    this.tenantTokens = options.tenantTokens ?? new TenantTokenProvider({
      tenant: options.tenant,
      appId: options.appId,
      appSecret: options.appSecret,
      request: this.request,
      now: this.now,
    });
  }
  private get host() { return this.brand === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn'; }
  private async api(path: string, body?: unknown, token?: string) {
    const r = await this.request(this.host + path, { method: body ? 'POST' : 'GET', signal: AbortSignal.timeout(15_000),
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    const data = obj(await r.json());
    if (!r.ok || data.code !== 0) throw new Error('飞书网页登录校验失败，请检查应用配置');
    return data;
  }
  private rateLimit() {
    this.requests = this.requests.filter(t => this.now() - t < 60_000);
    if (this.requests.length >= 30) throw new Error('请求过多，请稍后再试');
    this.requests.push(this.now());
    for (const map of [this.challenges, this.sessions]) for (const [key, expires] of map) if (expires < this.now()) map.delete(key);
  }
  private async getTicket(): Promise<string> {
    if (this.ticket && this.ticket.expires > this.now()) return this.ticket.value;
    if (this.ticketPending) return this.ticketPending;
    this.ticketPending = (async () => {
      const token = await this.tenantTokens.getToken();
      const data = obj((await this.api('/open-apis/jssdk/ticket/get', {}, token)).data);
      if (typeof data.ticket !== 'string' || typeof data.expire_in !== 'number') throw new Error('invalid JSAPI ticket');
      this.ticket = { value: data.ticket, expires: this.now() + Math.max(0, data.expire_in - 60) * 1000 };
      return data.ticket;
    })();
    try { return await this.ticketPending; } finally { this.ticketPending = undefined; }
  }
  async bootstrap(pageUrl: string) {
    this.rateLimit();
    const base = new URL(this.publicUrl); const url = new URL(pageUrl);
    if (url.origin !== base.origin || url.pathname !== base.pathname || url.username || url.password || url.hash || pageUrl.length > 4096) throw new Error('非法页面地址');
    const timestamp = this.now(); const nonceStr = randomBytes(16).toString('hex');
    const ticket = await this.getTicket();
    const signature = createHash('sha1').update(`jsapi_ticket=${ticket}&noncestr=${nonceStr}&timestamp=${timestamp}&url=${pageUrl}`).digest('hex');
    const state = randomBytes(32).toString('hex'); this.challenges.set(state, this.now() + 180_000);
    return { appId: this.appId, timestamp, nonceStr, signature, state, jsApiList: ['chooseChat', 'getTriggerContext', 'requestAccess'] };
  }
  async login(code: string, state: string): Promise<string> {
    this.rateLimit();
    const expires = this.challenges.get(state); this.challenges.delete(state);
    if (!expires || expires < this.now() || !code || code.length > 4096) throw new Error('登录请求已失效，请刷新页面');
    const result = await this.api('/open-apis/authen/v2/oauth/token', { grant_type: 'authorization_code', client_id: this.appId, client_secret: this.secret, code });
    if (typeof result.access_token !== 'string') throw new Error('未取得登录凭证');
    const user = obj((await this.api('/open-apis/authen/v1/user_info', undefined, result.access_token)).data);
    if (user.open_id !== this.owner) throw new Error('只有配置的本人可以使用此助理');
    const session = randomBytes(32).toString('hex'); this.sessions.set(session, this.now() + 30 * 60_000); return session;
  }
  authorized(token: string): boolean { return (this.sessions.get(token) ?? 0) > this.now(); }
}
