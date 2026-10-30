import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, lstat, realpath, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse, stringify } from 'smol-toml';
import type { ResolvedModelProvider } from '../../model-provider/types';

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

async function optional(path: string): Promise<string | undefined> {
  try { return await readFile(path, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}

/** Bridge owns provider routing; all other native settings stay editable here. */
export async function prepareManagedCodexConfig(home: string, provider?: ResolvedModelProvider) {
  const path = join(home, 'config.toml');
  const previous = await optional(path);
  const config = object(previous ? parse(previous) : {});
  if (!provider?.codex) {
    return { changed: false, id: String(config.model_provider ?? 'openai'), model: typeof config.model === 'string' ? config.model : undefined };
  }
  const resolvedHome = await realpath(home).catch(() => resolve(home));
  const personalHome = await realpath(join(homedir(), '.codex')).catch(() => resolve(homedir(), '.codex'));
  if (resolvedHome === personalHome) {
    throw new Error('Bridge-managed providers require a separate codexHome; the command-line Codex home will not be modified.');
  }
  if (previous !== undefined && (await lstat(path)).isSymbolicLink()) {
    throw new Error('Bridge Codex config.toml must be an independent file, not a symlink.');
  }
  await mkdir(home, { recursive: true, mode: 0o700 });
  const native = provider.codex;
  const providers = object(config.model_providers);
  const entry = { ...object(providers[native.providerId]),
    name: provider.displayName, base_url: native.baseUrl, wire_api: native.wireApi,
    env_key: native.apiKeyEnv, requires_openai_auth: false,
  };
  // Authentication is supplied from Bridge's secret references, never from a
  // previously copied personal account or a serialized bearer token.
  for (const key of ['auth', 'experimental_bearer_token', 'http_headers', 'env_http_headers']) delete entry[key as keyof typeof entry];
  if (native.headersEnv) Object.assign(entry, { env_http_headers: native.headersEnv });
  providers[native.providerId] = entry;
  config.model_providers = providers;
  config.model_provider = native.providerId;
  config.model = provider.model;
  if (typeof config.profile === 'string') {
    const profiles = object(config.profiles);
    profiles[config.profile] = { ...object(profiles[config.profile]), model_provider: native.providerId, model: provider.model };
    config.profiles = profiles;
  }
  const rendered = stringify(config as Parameters<typeof stringify>[0]);
  if (rendered !== previous) {
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, rendered, { mode: 0o600 });
    await rename(temporary, path);
  }
  const signaturePath = join(home, 'bridge-provider.sha256');
  const signature = createHash('sha256').update(JSON.stringify({ native, model: provider.model, env: provider.env })).digest('hex');
  const changed = await optional(signaturePath) !== signature;
  // Written only after a successful daemon check by the caller, so failed
  // activation still retries the required daemon restart next time.
  return { changed, id: native.providerId, model: provider.model,
    commit: () => writeFile(signaturePath, signature, { mode: 0o600 }),
  };
}
