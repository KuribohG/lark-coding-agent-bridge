import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, stringify } from 'smol-toml';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const nativeHome = process.env.CODEX_HOME || join(homedir(), '.codex');
const nativeConfig = parse(await readFile(join(nativeHome, 'config.toml'), 'utf8'));
const providerId = nativeConfig.model_provider;
const provider = nativeConfig.model_providers?.[providerId];
if (!provider || provider.wire_api !== 'responses') {
  throw new Error('The isolated launcher requires a custom Responses provider in the native Codex config. Use the normal web command for other login methods.');
}
const credential = provider.experimental_bearer_token || (provider.env_key && process.env[provider.env_key]);
if (!credential) throw new Error('The configured provider has no readable bearer token or environment credential.');

const privateHome = join(process.env.BRIDGE_WEB_STATE_DIR || join(repository, '.web-local'), 'codex-home');
const headers = { ...provider.env_http_headers };
for (const [index, [name, value]] of Object.entries(provider.http_headers ?? {}).entries()) {
  const variable = `BRIDGE_CODEX_HEADER_${index}`;
  process.env[variable] = value;
  headers[name] = variable;
}
const isolatedConfig = {
  model: nativeConfig.model,
  model_provider: providerId,
  ...(nativeConfig.model_reasoning_effort ? { model_reasoning_effort: nativeConfig.model_reasoning_effort } : {}),
  ...(nativeConfig.model_catalog_json ? { model_catalog_json: resolve(nativeHome, nativeConfig.model_catalog_json) } : {}),
  ...(nativeConfig.windows ? { windows: nativeConfig.windows } : {}),
  model_providers: {
    [providerId]: {
      name: provider.name || providerId,
      base_url: provider.base_url,
      wire_api: 'responses',
      env_key: 'BRIDGE_CODEX_PROVIDER_KEY',
      ...(Object.keys(headers).length ? { env_http_headers: headers } : {}),
    },
  },
};
await mkdir(privateHome, { recursive: true });
await writeFile(join(privateHome, 'config.toml'), stringify(isolatedConfig), { mode: 0o600 });
process.env.CODEX_HOME = privateHome;
process.env.BRIDGE_CODEX_PROVIDER_KEY = credential;
await import('../lark-channel-bridge.mjs');
