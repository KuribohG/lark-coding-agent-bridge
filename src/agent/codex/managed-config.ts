import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, lstat, realpath, rename, rm, writeFile } from 'node:fs/promises';
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

/** Provider ids and key variables Bridge itself writes; never part of a native setup. */
const MANAGED_PROVIDER_PREFIX = 'lark_';
const MANAGED_ENV_PREFIX = 'LARK_MODEL_PROVIDER_KEY_';

function isManagedProvider(id: string, value: unknown): boolean {
  const envKey = object(value).env_key;
  return id.startsWith(MANAGED_PROVIDER_PREFIX) || (typeof envKey === 'string' && envKey.startsWith(MANAGED_ENV_PREFIX));
}

function dropRouting(config: Record<string, unknown>, ids: ReadonlySet<string>): boolean {
  let touched = false;
  if (typeof config.model_provider === 'string' && ids.has(config.model_provider)) {
    delete config.model_provider;
    delete config.model;
    touched = true;
  }
  const profiles = object(config.profiles);
  for (const [name, value] of Object.entries(profiles)) {
    const profile = object(value);
    if (typeof profile.model_provider !== 'string' || !ids.has(profile.model_provider)) continue;
    delete profile.model_provider;
    delete profile.model;
    profiles[name] = profile;
    touched = true;
  }
  return touched;
}

/**
 * Drop Bridge's own provider entries and the routing that names them. A launch
 * without a resolved provider injects no credentials, so a leftover `env_key`
 * here would make Codex fail with "Missing environment variable".
 */
function clearManagedRouting(config: Record<string, unknown>): boolean {
  const providers = object(config.model_providers);
  const ids = new Set<string>();
  for (const [id, value] of Object.entries(providers)) {
    if (!isManagedProvider(id, value)) continue;
    delete providers[id];
    ids.add(id);
  }
  if (ids.size === 0) return false;
  if (Object.keys(providers).length > 0) config.model_providers = providers;
  else delete config.model_providers;
  dropRouting(config, ids);
  return true;
}

export interface ManagedCodexConfig {
  /** The daemon has to restart before this routing can be served. */
  changed: boolean;
  id: string;
  model?: string;
  /** Routing the file carried before this launch; a deferred daemon keeps serving it. */
  previous: { id: string; model?: string };
  /** Called once the daemon was activated (or restarted) for this routing. */
  commit?: () => Promise<void>;
  /** Restore the pre-launch file when the daemon keeps its previous environment. */
  revert: () => Promise<void>;
}

/** Bridge owns provider routing; all other native settings stay editable here. */
export async function prepareManagedCodexConfig(home: string, provider?: ResolvedModelProvider): Promise<ManagedCodexConfig> {
  const path = join(home, 'config.toml');
  const previous = await optional(path);
  const config = object(previous ? parse(previous) : {});
  const previousRouting = { id: String(config.model_provider ?? 'openai'),
    ...(typeof config.model === 'string' ? { model: config.model } : {}) };
  const rewrite = async (next: string) => {
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, next, { mode: 0o600 });
    await rename(temporary, path);
  };
  // A deferred daemon restart leaves the old environment in place, so the file
  // has to go back to what that daemon was launched with.
  const revert = async () => {
    if (previous === undefined) await rm(path, { force: true });
    else await rewrite(previous);
  };
  const rendered = () => stringify(config as Parameters<typeof stringify>[0]);

  if (!provider?.codex) {
    if (!clearManagedRouting(config)) {
      return { changed: false, id: previousRouting.id, model: previousRouting.model, previous: previousRouting, revert };
    }
    await mkdir(home, { recursive: true, mode: 0o700 });
    await rewrite(rendered());
    return { changed: true, id: previousRouting.id, model: previousRouting.model, previous: previousRouting, revert };
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
  const next = rendered();
  if (next !== previous) await rewrite(next);
  const signaturePath = join(home, 'bridge-provider.sha256');
  const signature = createHash('sha256').update(JSON.stringify({ native, model: provider.model, env: provider.env })).digest('hex');
  const changed = await optional(signaturePath) !== signature;
  // Written only after a successful daemon check by the caller, so failed
  // activation still retries the required daemon restart next time.
  return { changed, id: native.providerId, model: provider.model, previous: previousRouting, revert,
    commit: () => writeFile(signaturePath, signature, { mode: 0o600 }),
  };
}
