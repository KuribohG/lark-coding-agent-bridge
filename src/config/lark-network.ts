export interface LarkNetworkConfig {
  /** Environment proxies (default), direct access, or an HTTP(S) proxy URL. */
  proxy?: string;
  /** Overrides NO_PROXY, including an empty string to clear inherited exclusions. */
  no_proxy?: string;
}

export function validateLarkNetwork(value: unknown, path = 'channels.lark.network'): asserts value is LarkNetworkConfig {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(`${path}: expected a table`);
  }
  for (const [key, setting] of Object.entries(value)) {
    if (key !== 'proxy' && key !== 'no_proxy') throw new Error(`${path}.${key}: unknown setting`);
    if (typeof setting !== 'string') throw new Error(`${path}.${key}: expected string`);
    if (key === 'proxy' && setting !== 'env' && setting !== 'direct') {
      let url: URL;
      try { url = new URL(setting); } catch { throw new Error(`${path}.proxy: expected env, direct, or an HTTP(S) proxy URL`); }
      if (!['http:', 'https:'].includes(url.protocol) || url.pathname !== '/' || url.search || url.hash) {
        throw new Error(`${path}.proxy: expected env, direct, or an HTTP(S) proxy URL`);
      }
      if (url.username || url.password) {
        throw new Error(`${path}.proxy: keep proxy credentials in HTTP(S)_PROXY and use proxy = "env"`);
      }
    }
  }
}
