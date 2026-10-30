import { BlockList, isIP } from 'node:net';
import axios from 'axios';
import { ProxyAgent as NodeProxyAgent } from 'proxy-agent';
import { Agent, Pool, ProxyAgent } from 'undici';
import type { LarkChannelOptions } from '@larksuite/channel';
import { validateLarkNetwork, type LarkNetworkConfig } from '../config/lark-network';

function bypassMatcher(value: string): (url: URL) => boolean {
  const rules = value.toLowerCase().split(/[,\s]+/).filter(Boolean).map(rule => {
    if (rule === '*') return () => true;
    const cidr = rule.match(/^(.+)\/(\d+)$/);
    if (cidr && isIP(cidr[1]!)) {
      const subnet = new BlockList();
      const family = isIP(cidr[1]!) === 6 ? 'ipv6' : 'ipv4';
      try { subnet.addSubnet(cidr[1]!, Number(cidr[2]), family); } catch { return () => false; }
      return (url: URL) => {
        const host = url.hostname.replace(/^\[|\]$/g, '');
        return isIP(host) !== 0 && subnet.check(host, isIP(host) === 6 ? 'ipv6' : 'ipv4');
      };
    }
    const withPort = rule.match(/^(\[[^\]]+\]|[^:]+):(\d+)$/);
    const host = withPort?.[1] ?? rule;
    return (url: URL) => {
      const port = url.port || (['https:', 'wss:'].includes(url.protocol) ? '443' : '80');
      if (withPort && withPort[2] !== port) return false;
      const hostname = url.hostname.toLowerCase();
      if (host.startsWith('*')) return hostname.endsWith(host.slice(1));
      if (host.startsWith('.')) return hostname.endsWith(host);
      return hostname.replace(/^\[|\]$/g, '') === host.replace(/^\[|\]$/g, '');
    };
  });
  return url => rules.some(rule => rule(url));
}

/** Snapshot only network settings; never mutate process.env or global dispatchers. */
export function larkProxyResolver(config: LarkNetworkConfig = {}, env: NodeJS.ProcessEnv = process.env) {
  validateLarkNetwork(config);
  const mode = config.proxy ?? 'env';
  const all = env.all_proxy || env.ALL_PROXY || '';
  const http = mode === 'env' ? env.http_proxy || env.HTTP_PROXY || all : mode === 'direct' ? '' : mode;
  const https = mode === 'env' ? env.https_proxy || env.HTTPS_PROXY || http : http;
  for (const proxy of [http, https]) {
    if (!proxy) continue;
    try {
      const parsed = new URL(proxy);
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.pathname !== '/' || parsed.search || parsed.hash) throw new Error();
    } catch { throw new Error('Lark proxy must be an HTTP(S) proxy URL; check channels.lark.network or HTTP(S)_PROXY'); }
  }
  const bypass = bypassMatcher(config.no_proxy ?? (env.no_proxy || env.NO_PROXY || ''));
  return (target: string | URL): string => {
    const url = new URL(target);
    if (bypass(url)) return '';
    return ['https:', 'wss:'].includes(url.protocol) ? https : http;
  };
}

/** A profile's Feishu/Lark HTTP and WebSocket transport. */
export class LarkNetwork {
  private readonly dispatcher: Agent;
  readonly agent: NodeProxyAgent;
  readonly httpInstance: NonNullable<LarkChannelOptions['httpInstance']>;

  constructor(config: LarkNetworkConfig = {}, env: NodeJS.ProcessEnv = process.env) {
    const proxyFor = larkProxyResolver(config, env);
    // Agent's factory also runs for redirected origins, so NO_PROXY applies to
    // every hop, rather than only to the original fetch URL.
    this.dispatcher = new Agent({ factory: (origin, options) => {
      const proxy = proxyFor(origin);
      return proxy ? new ProxyAgent(proxy) : new Pool(origin, options);
    } });
    this.agent = new NodeProxyAgent({ getProxyForUrl: url => proxyFor(url) });
    const http = axios.create({
      proxy: false,
      httpAgent: this.agent,
      httpsAgent: this.agent,
      timeout: 30_000,
    });
    // Preserve node-sdk's response contract, including binary/stream replies
    // and the headers used by file download helpers.
    http.interceptors.response.use(response =>
      (response.config as { $return_headers?: boolean }).$return_headers
        ? { data: response.data, headers: response.headers }
        : response.data,
    );
    // Axios' type cannot express the SDK response-unwrapping interceptor.
    this.httpInstance = http as unknown as NonNullable<LarkChannelOptions['httpInstance']>;
  }

  readonly request: typeof fetch = async (input, init) => {
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    try {
      return await fetch(input, {
        ...init,
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
        // Node's bundled undici types lag the compatible installed dispatcher.
        dispatcher: this.dispatcher as unknown as RequestInit['dispatcher'],
      });
    } catch (cause) {
      // Causes may carry request bodies, headers, or proxy credentials. Keep
      // their machine-readable codes visible without rendering those objects.
      const codes: string[] = [];
      const seen = new Set<unknown>();
      let error: unknown = cause;
      while (error && typeof error === 'object' && !seen.has(error) && seen.size < 5) {
        seen.add(error);
        const item = error as { code?: unknown; name?: unknown; cause?: unknown };
        const code = typeof item.code === 'string' ? item.code : item.name;
        if (typeof code === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(code)) codes.push(code);
        error = item.cause;
      }
      throw new Error(`Lark network request failed${codes.length ? ` (${[...new Set(codes)].join(', ')})` : ''}`, { cause });
    }
  };

  async close(): Promise<void> {
    this.agent.destroy();
    await this.dispatcher.close();
  }
}

let defaultNetwork: LarkNetwork | undefined;
/** For standalone consumers without a profile; managed profiles inject their own request. */
export const larkFetch: typeof fetch = (input, init) => (defaultNetwork ??= new LarkNetwork()).request(input, init);
